package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/damonleelcx/Law-Med-agent/internal/agent"
	"github.com/damonleelcx/Law-Med-agent/internal/auth"
	"github.com/damonleelcx/Law-Med-agent/internal/engine"
	"github.com/damonleelcx/Law-Med-agent/internal/mail"
	"github.com/damonleelcx/Law-Med-agent/internal/speech"
	"github.com/damonleelcx/Law-Med-agent/internal/wechat"
)

// Voice end to end: the recording is fetched by the speech service from the
// server's own short-lived clip URL, its text comes back for the message box,
// and Vera's reply is read aloud — only for the conversation's owner.
func TestVoiceInAndOut(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	recording := append([]byte("ID3\x04\x00\x00\x00\x00\x00\x00"), bytes.Repeat([]byte{0xFF, 0xFB, 0x90, 0x64}, 200)...)

	var apiURL string
	var fetched []byte
	var spoken []string
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		switch r.URL.Path {
		case "/v1/wand/asrproxy/sync_transcribe":
			u, _ := in["input_url"].(string)
			if !strings.HasPrefix(u, apiURL+"/api/voice/clip/") {
				t.Errorf("input_url %q not on the server", u)
			}
			res, err := http.Get(u) // what TokenHub does
			if err != nil {
				t.Error(err)
				return
			}
			fetched, _ = io.ReadAll(res.Body)
			res.Body.Close()
			w.Write([]byte(`{"status":"completed","output":{"text":"房东不退押金怎么办"},"usage":{"total_tokens":48}}`))
		case "/v1/tenlai/ttsproxy/text_to_voice":
			spoken = append(spoken, in["text"].(string))
			json.NewEncoder(w).Encode(map[string]any{"status": "completed", "data": map[string]string{"audio_url": "http://" + r.Host + "/a.mp3"}})
		case "/a.mp3":
			w.Write([]byte("MP3DATA"))
		}
	}))
	defer hub.Close()

	store := &engine.Store{Pool: pool}
	s := &Server{Pool: pool, Auth: &auth.Service{Pool: pool, Mailer: mail.Log{}, SessionTTL: time.Hour}, Hub: NewHub(), Store: store,
		Agent:  &agent.Agent{Store: store, Model: &engine.Model{Store: store}},
		Speech: &speech.Client{BaseURL: hub.URL + "/v1", APIKey: "k", ASRModel: "hy-asr", TTSModel: "tts", Voice: 602003}}
	fx := &fakeWX{t: t, appKey: "appkey", balance: map[string]int{}, keys: map[string]string{}, orders: map[string]bool{}}
	wxSrv := httptest.NewServer(fx)
	defer wxSrv.Close()
	s.WX = wechat.New(wechat.Config{AppID: "wxtest", AppSecret: "secret"})
	s.WX.BaseURL = wxSrv.URL
	api := httptest.NewServer(s.Handler())
	defer api.Close()
	apiURL = api.URL
	s.PublicOrigin = api.URL

	do := func(method, path, token, ct string, body io.Reader) (*http.Response, []byte) {
		req, _ := http.NewRequest(method, api.URL+path, body)
		req.Header.Set("X-ACT", "1")
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		return res, b
	}
	login := func(code string) (string, string) {
		_, b := do("POST", "/api/wx/login", "", "application/json", strings.NewReader(`{"code":"`+code+`"}`))
		var out struct {
			Token string `json:"token"`
			User  struct {
				ID string `json:"id"`
			} `json:"user"`
		}
		_ = json.Unmarshal(b, &out)
		if out.Token == "" {
			t.Fatalf("login %s: %s", code, b)
		}
		return out.Token, out.User.ID
	}
	token, uid := login("code-dana-1")
	other, _ := login("code-erin-1")

	// The app learns what is on.
	_, b := do("GET", "/api/settings", token, "", nil)
	if !strings.Contains(string(b), `"voice":{"input":true,"output":true}`) {
		t.Fatalf("settings voice flags: %s", b)
	}

	// Voice in.
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "tmp_rec.mp3")
	fw.Write(recording)
	mw.Close()
	res, b := do("POST", "/api/voice/transcribe", token, mw.FormDataContentType(), &body)
	if res.StatusCode != 200 || !strings.Contains(string(b), "房东不退押金怎么办") {
		t.Fatalf("transcribe: %d %s", res.StatusCode, b)
	}
	if !bytes.Equal(fetched, recording) {
		t.Fatalf("the speech service fetched %d bytes, want the %d-byte recording", len(fetched), len(recording))
	}
	if n := len(s.clips.m); n != 0 {
		t.Fatalf("%d recordings still held after transcription", n)
	}
	// Not audio → refused before any model call.
	body.Reset()
	mw = multipart.NewWriter(&body)
	fw, _ = mw.CreateFormFile("file", "x.mp3")
	fw.Write([]byte("<html>not audio</html>"))
	mw.Close()
	if res, _ := do("POST", "/api/voice/transcribe", token, mw.FormDataContentType(), &body); res.StatusCode != 400 {
		t.Fatalf("non-audio upload: %d", res.StatusCode)
	}

	// Voice out: Vera's reply, read without its Markdown.
	var conv string
	_ = pool.QueryRow(ctx, `INSERT INTO conversations (user_id) VALUES ($1) RETURNING id`, uid).Scan(&conv)
	var msg int64
	_ = pool.QueryRow(ctx, `INSERT INTO messages (conversation_id, role, content) VALUES ($1,'assistant','**先别急。** 押金一般应当退还。') RETURNING id`, conv).Scan(&msg)
	path := "/api/messages/" + strconv.FormatInt(msg, 10) + "/speech"
	res, b = do("GET", path, token, "", nil)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "audio/mpeg" || string(b) != "MP3DATA" {
		t.Fatalf("speak: %d %s %q", res.StatusCode, res.Header.Get("Content-Type"), b)
	}
	if len(spoken) != 1 || spoken[0] != "先别急。 押金一般应当退还。" {
		t.Fatalf("spoke %q", spoken)
	}
	// A replay comes from the cache.
	do("GET", path, token, "", nil)
	if len(spoken) != 1 {
		t.Fatalf("replay synthesized again (%d calls)", len(spoken))
	}
	// Someone else's message, or a user message, is not theirs to hear.
	if res, _ := do("GET", path, other, "", nil); res.StatusCode != 404 {
		t.Fatalf("other account got %d", res.StatusCode)
	}
	var mine int64
	_ = pool.QueryRow(ctx, `INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user','hi') RETURNING id`, conv).Scan(&mine)
	if res, _ := do("GET", "/api/messages/"+strconv.FormatInt(mine, 10)+"/speech", token, "", nil); res.StatusCode != 404 {
		t.Fatalf("user message read aloud: %d", res.StatusCode)
	}
	// Both directions were metered against the account.
	var calls int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM llm_calls WHERE user_id=$1 AND purpose IN ('voice-in','voice-out')`, uid).Scan(&calls)
	if calls != 2 {
		t.Fatalf("%d metered voice calls, want 2", calls)
	}
}
