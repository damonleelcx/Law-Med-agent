package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/damonleelcx/Law-Med-agent/internal/agent"
	"github.com/damonleelcx/Law-Med-agent/internal/auth"
	"github.com/damonleelcx/Law-Med-agent/internal/engine"
	"github.com/damonleelcx/Law-Med-agent/internal/llm"
	"github.com/damonleelcx/Law-Med-agent/internal/mail"
	"github.com/damonleelcx/Law-Med-agent/internal/wechat"
)

// When the model cannot answer, Vera shows and saves her fallback ("I can't
// reach my reasoning service"). That is not an answer, so the stamp the
// message paid is given back: no answer, no charge.
func TestFallbackReplyRefundsTheStamp(t *testing.T) {
	pool := testPool(t)
	fx := &fakeWX{t: t, appKey: "appkey", balance: map[string]int{"carol": 3}, keys: map[string]string{}, orders: map[string]bool{}}
	wxSrv := httptest.NewServer(fx)
	defer wxSrv.Close()
	// The model: routing (non-streamed) works, the streamed answer fails.
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Stream bool `json:"stream"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Stream {
			http.Error(w, `{"error":{"message":"quota exhausted"}}`, http.StatusPaymentRequired)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant",
			"content": `{"intent":"legal.explain","confidence":0.9,"domain":"general","language":"zh"}`}}}})
	}))
	defer model.Close()

	wx := wechat.New(wechat.Config{AppID: "wxtest", AppSecret: "secret", OfferID: "1450000000", AppKey: "appkey"})
	wx.BaseURL = wxSrv.URL
	store := &engine.Store{Pool: pool}
	client := llm.New(model.URL, "k")
	client.Retries = 0
	ag := &agent.Agent{Store: store, Model: &engine.Model{Client: client, Store: store}, LLM: "m", FastLLM: "m"}
	s := &Server{Pool: pool, Auth: &auth.Service{Pool: pool, Mailer: mail.Log{}, SessionTTL: time.Hour}, Hub: NewHub(), Agent: ag,
		Store: store, WX: wx, Stamps: &wechat.Stamps{Pool: pool, WX: wx}}
	h := s.Handler()
	do := func(method, path, token string, body any) *httptest.ResponseRecorder {
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(b))
		req.Header.Set("X-ACT", "1")
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	var login map[string]any
	_ = json.Unmarshal(do("POST", "/api/wx/login", "", map[string]string{"code": "code-carol-1", "language": "zh"}).Body.Bytes(), &login)
	token, _ := login["token"].(string)
	if token == "" {
		t.Fatalf("login: %v", login)
	}
	var conv map[string]any
	_ = json.Unmarshal(do("POST", "/api/conversations", token, map[string]any{}).Body.Bytes(), &conv)

	rec := do("POST", "/api/conversations/"+conv["id"].(string)+"/messages", token, map[string]string{"content": "房东不退押金怎么办", "client_msg_id": "c1"})
	out := rec.Body.String()
	if !strings.Contains(out, "推理服务") {
		t.Fatalf("no fallback reply streamed:\n%s", out)
	}
	if !strings.Contains(out, `"refunded":1`) || !strings.Contains(out, "event: done") {
		t.Fatalf("fallback reply was not refunded:\n%s", out)
	}
	if fx.pays != 1 || fx.refunds != 1 || fx.balance["carol"] != 3 {
		t.Fatalf("pays=%d refunds=%d balance=%d, want 1/1/3", fx.pays, fx.refunds, fx.balance["carol"])
	}
	var status string
	_ = pool.QueryRow(t.Context(), `SELECT status FROM stamp_ledger WHERE client_msg_id='c1'`).Scan(&status)
	if status != "refunded" {
		t.Fatalf("ledger status %q", status)
	}
}
