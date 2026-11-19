// Command devmock stands in for WeChat and the model so the mini program can
// be run end to end in WeChat DevTools on one machine, with no AppSecret, no
// virtual payment account and no model key.
//
//	ACT_WX_API_BASE=http://127.0.0.1:8090   (WeChat: sign-in, token, xpay)
//	ACT_LLM_BASE_URL=http://127.0.0.1:8090/v1  (OpenAI-compatible model)
//
// WeChat side: every login code maps to ONE dev user (DevTools hands out a
// fresh code each time), with a new session_key per login, like the real
// thing. xpay calls are refused unless both pay_sig and the user signature
// verify, exactly as WeChat does. The coin balance starts at DEVMOCK_STAMPS
// (default 3). The simulator cannot show the virtual payment sheet, so
// POST /mock/grant?n=10 stands in for a completed purchase.
//
// Model side: routes every message as a general question and streams a short
// canned reply. A message containing "#fail" makes the reply fail, to watch
// the stamp being refunded.
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type state struct {
	mu         sync.Mutex
	appKey     string
	sessionKey string
	balance    int
	orders     map[string]int
}

func main() {
	addr := env("DEVMOCK_ADDR", "127.0.0.1:8090")
	n, _ := strconv.Atoi(env("DEVMOCK_STAMPS", "3"))
	st := &state{appKey: env("DEVMOCK_APPKEY", "dev-appkey"), balance: n, orders: map[string]int{}}
	m := http.NewServeMux()
	m.HandleFunc("/sns/jscode2session", st.login)
	m.HandleFunc("/cgi-bin/stable_token", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"access_token": "dev-token", "expires_in": 7200})
	})
	m.HandleFunc("/xpay/", st.xpay)
	m.HandleFunc("/mock/grant", st.grant)
	m.HandleFunc("/mock/set", st.set)
	m.HandleFunc("/mock/state", func(w http.ResponseWriter, r *http.Request) {
		st.mu.Lock()
		defer st.mu.Unlock()
		writeJSON(w, map[string]any{"balance": st.balance, "orders": len(st.orders)})
	})
	m.HandleFunc("/v1/chat/completions", chat)
	m.HandleFunc("/v1/wand/asrproxy/sync_transcribe", asr)
	m.HandleFunc("/v1/tenlai/ttsproxy/text_to_voice", tts)
	m.HandleFunc("/mock/tts.mp3", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Write(sampleMP3)
	})
	log.Printf("devmock on http://%s (stamps=%d)", addr, n)
	log.Fatal(http.ListenAndServe(addr, logged(m)))
}

func (s *state) login(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("js_code")
	if code == "" {
		writeJSON(w, map[string]any{"errcode": 40029, "errmsg": "invalid code"})
		return
	}
	s.mu.Lock()
	s.sessionKey = "sk-" + short(code)
	sk := s.sessionKey
	s.mu.Unlock()
	writeJSON(w, map[string]any{"openid": "dev-openid", "session_key": sk})
}

func (s *state) xpay(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	q := r.URL.Query()
	s.mu.Lock()
	defer s.mu.Unlock()
	if q.Get("pay_sig") != mac(s.appKey, r.URL.Path+"&"+string(body)) {
		writeJSON(w, map[string]any{"errcode": 268435463, "errmsg": "pay_sig error"})
		return
	}
	if q.Get("signature") != mac(s.sessionKey, string(body)) {
		// What a stale session_key looks like from WeChat's side.
		writeJSON(w, map[string]any{"errcode": 268435464, "errmsg": "signature error (stale session_key?)"})
		return
	}
	var in map[string]any
	_ = json.Unmarshal(body, &in)
	switch r.URL.Path {
	case "/xpay/query_user_balance":
		writeJSON(w, map[string]any{"errcode": 0, "balance": s.balance})
	case "/xpay/currency_pay":
		oid, _ := in["order_id"].(string)
		amt := int(num(in["amount"]))
		if _, dup := s.orders[oid]; dup {
			writeJSON(w, map[string]any{"errcode": 268490004, "errmsg": "duplicate order"})
			return
		}
		if s.balance < amt {
			writeJSON(w, map[string]any{"errcode": 268490001, "errmsg": "balance not enough"})
			return
		}
		s.orders[oid] = amt
		s.balance -= amt
		writeJSON(w, map[string]any{"errcode": 0, "order_id": "wx" + oid, "balance": s.balance})
	case "/xpay/cancel_currency_pay":
		pay, _ := in["pay_order_id"].(string)
		amt, ok := s.orders[pay]
		if !ok {
			writeJSON(w, map[string]any{"errcode": 268490002, "errmsg": "order not found"})
			return
		}
		delete(s.orders, pay)
		s.balance += amt
		writeJSON(w, map[string]any{"errcode": 0, "order_id": in["order_id"]})
	default:
		writeJSON(w, map[string]any{"errcode": 404, "errmsg": "unknown xpay api"})
	}
}

func (s *state) grant(w http.ResponseWriter, r *http.Request) {
	n, _ := strconv.Atoi(r.URL.Query().Get("n"))
	if n <= 0 {
		n = 10
	}
	s.mu.Lock()
	s.balance += n
	b := s.balance
	s.mu.Unlock()
	writeJSON(w, map[string]any{"balance": b})
}

// chat is an OpenAI-compatible /chat/completions.
func chat(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Stream   bool `json:"stream"`
		Messages []struct {
			Role    string `json:"role"`
			Content any    `json:"content"`
		} `json:"messages"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	var all strings.Builder
	last := ""
	for _, m := range req.Messages {
		if s, ok := m.Content.(string); ok {
			all.WriteString(s)
			if m.Role == "user" {
				last = s
			}
		}
	}
	prompt := all.String()
	// Only the client's latest message decides: devmock's own replies mention
	// #fail, and they come back in the history of every later turn.
	if strings.Contains(last, "#fail") && req.Stream {
		http.Error(w, `{"error":{"message":"devmock: failing on purpose"}}`, 400)
		return
	}
	usage := map[string]int{"prompt_tokens": 20, "completion_tokens": 20, "total_tokens": 40}
	if !req.Stream {
		content := "{}"
		if strings.Contains(prompt, "Classify the client's latest message") {
			content = `{"intent":"legal.explain","confidence":0.95,"domain":"general","language":"en"}`
		}
		writeJSON(w, map[string]any{"model": "devmock", "usage": usage,
			"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": content}}}})
		return
	}
	zh := strings.ContainsAny(prompt, "的是我你")
	reply := "This is a **local test reply** from devmock. In production Vera would answer here.\n\n- Your message cost 1 stamp.\n- Send `#fail` to see a refund."
	if zh {
		reply = "这是 devmock 的**本地测试回复**，正式环境中维拉会在这里回答。\n\n- 这条消息消耗了 1 张邮票。\n- 发送 `#fail` 可以看到退回邮票。"
	}
	w.Header().Set("Content-Type", "text/event-stream")
	fl, _ := w.(http.Flusher)
	for _, part := range chunks(reply, 6) {
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]string{"content": part}}}})
		fmt.Fprintf(w, "data: %s\n\n", b)
		if fl != nil {
			fl.Flush()
		}
		time.Sleep(40 * time.Millisecond)
	}
	b, _ := json.Marshal(map[string]any{"choices": []any{}, "usage": usage})
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", b)
}

func chunks(s string, n int) []string {
	r := []rune(s)
	var out []string
	for i := 0; i < len(r); i += n {
		j := i + n
		if j > len(r) {
			j = len(r)
		}
		out = append(out, string(r[i:j]))
	}
	return out
}

func mac(key, msg string) string {
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte(msg))
	return hex.EncodeToString(m.Sum(nil))
}

func short(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:6])
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func logged(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		h.ServeHTTP(w, r)
	})
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// sampleMP3 is Vera's voice (tenlai-tts-v1.0, voice 602003 爱小悠):
// "你好，我是维拉。房东不退押金，先别急，我们一步一步来。"
//
//go:embed testdata/vera.mp3
var sampleMP3 []byte

// asr stands in for TokenHub speech recognition. Like the real one it fetches
// the recording from input_url; the server advertises its public origin
// (127.0.0.1:8080), which from this container is act-wx-server:8080.
func asr(w http.ResponseWriter, r *http.Request) {
	var in struct {
		InputURL string `json:"input_url"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	u := strings.Replace(in.InputURL, "127.0.0.1:8080", "act-wx-server:8080", 1)
	res, err := http.Get(u)
	if err != nil || res.StatusCode != 200 {
		writeJSON(w, map[string]any{"error": map[string]string{"message": fmt.Sprintf("devmock: could not fetch %s", in.InputURL)}})
		return
	}
	n, _ := io.Copy(io.Discard, res.Body)
	res.Body.Close()
	writeJSON(w, map[string]any{"status": "completed", "output": map[string]any{"text": "房东不退押金怎么办"},
		"usage": map[string]int{"total_tokens": int(n/4000) + 22}})
}

// tts stands in for TokenHub speech synthesis, with its 300-byte limit.
func tts(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text string `json:"text"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	if len(in.Text) > 300 {
		writeJSON(w, map[string]any{"Response": map[string]any{"Error": map[string]string{"Code": "InvalidParameterValue",
			"Message": fmt.Sprintf("field 'text' too long (bytes=%d, limit=300)", len(in.Text))}}})
		return
	}
	writeJSON(w, map[string]any{"status": "completed", "data": map[string]string{"audio_url": "http://" + r.Host + "/mock/tts.mp3"}})
}

// set makes the balance exactly n (POST /mock/set?balance=3), so a test run
// starts from a known count whatever earlier runs bought.
func (s *state) set(w http.ResponseWriter, r *http.Request) {
	n, err := strconv.Atoi(r.URL.Query().Get("balance"))
	if err != nil || n < 0 {
		http.Error(w, "balance=N", 400)
		return
	}
	s.mu.Lock()
	s.balance = n
	s.mu.Unlock()
	writeJSON(w, map[string]any{"balance": n})
}
