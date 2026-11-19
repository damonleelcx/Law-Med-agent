package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/damonleelcx/Law-Med-agent/internal/auth"
	"github.com/damonleelcx/Law-Med-agent/internal/db"
	"github.com/damonleelcx/Law-Med-agent/internal/mail"
	"github.com/damonleelcx/Law-Med-agent/internal/wechat"
)

// Runs against a real Postgres, like the engine tests:
//
//	ACT_TEST_DATABASE_URL=postgres://act@127.0.0.1:55850/act?sslmode=disable go test ./internal/httpapi/
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("ACT_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("ACT_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `TRUNCATE users, conversations, messages, user_preferences, sessions, wechat_identities, stamp_ledger CASCADE`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// fakeWX is WeChat: sign-in by code, a coin balance per openid, both xpay
// signatures checked on every call.
type fakeWX struct {
	t       *testing.T
	appKey  string
	mu      sync.Mutex
	balance map[string]int
	keys    map[string]string // openid → current session_key
	pays    int
	refunds int
	orders  map[string]bool
}

func (f *fakeWX) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	switch {
	case r.URL.Path == "/sns/jscode2session":
		code := r.URL.Query().Get("js_code") // "code-<openid>-<n>"
		parts := strings.Split(code, "-")
		if len(parts) != 3 {
			w.Write([]byte(`{"errcode":40029,"errmsg":"invalid code"}`))
			return
		}
		f.keys[parts[1]] = "sk-" + code
		json.NewEncoder(w).Encode(map[string]string{"openid": parts[1], "session_key": f.keys[parts[1]]})
	case r.URL.Path == "/cgi-bin/stable_token":
		w.Write([]byte(`{"access_token":"tok","expires_in":7200}`))
	case strings.HasPrefix(r.URL.Path, "/xpay/"):
		var in map[string]any
		_ = json.Unmarshal(body, &in)
		openid, _ := in["openid"].(string)
		q := r.URL.Query()
		if q.Get("pay_sig") != wechat.HMAC(f.appKey, r.URL.Path+"&"+string(body)) ||
			q.Get("signature") != wechat.HMAC(f.keys[openid], string(body)) {
			w.Write([]byte(`{"errcode":268435463,"errmsg":"signature error"}`))
			return
		}
		switch r.URL.Path {
		case "/xpay/query_user_balance":
			json.NewEncoder(w).Encode(map[string]any{"errcode": 0, "balance": f.balance[openid]})
		case "/xpay/currency_pay":
			oid := in["order_id"].(string)
			if f.orders[oid] {
				w.Write([]byte(`{"errcode":268490004,"errmsg":"duplicate order"}`))
				return
			}
			f.orders[oid] = true
			f.pays++
			f.balance[openid] -= int(in["amount"].(float64))
			json.NewEncoder(w).Encode(map[string]any{"errcode": 0, "order_id": "wx-" + oid, "balance": f.balance[openid]})
		case "/xpay/cancel_currency_pay":
			f.refunds++
			f.balance[openid] += int(in["amount"].(float64))
			w.Write([]byte(`{"errcode":0}`))
		}
	default:
		http.NotFound(w, r)
	}
}

func TestWeChatLoginAndStamps(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	fx := &fakeWX{t: t, appKey: "appkey", balance: map[string]int{"alice": 2}, keys: map[string]string{}, orders: map[string]bool{}}
	wxSrv := httptest.NewServer(fx)
	defer wxSrv.Close()

	wx := wechat.New(wechat.Config{AppID: "wxtest", AppSecret: "secret", OfferID: "1450000000", AppKey: "appkey"})
	wx.BaseURL = wxSrv.URL
	s := &Server{Pool: pool, Auth: &auth.Service{Pool: pool, Mailer: mail.Log{}, SessionTTL: time.Hour}, Hub: NewHub(),
		WX: wx, Stamps: &wechat.Stamps{Pool: pool, WX: wx}}
	h := s.Handler()

	call := func(method, path, token string, body any) (int, map[string]any) {
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, path, rd)
		req.Header.Set("X-ACT", "1")
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}

	// Sign in: a new account, no email, usable at once.
	code, out := call("POST", "/api/wx/login", "", map[string]string{"code": "code-alice-1", "language": "zh"})
	if code != 200 {
		t.Fatalf("login: %d %v", code, out)
	}
	token := out["token"].(string)
	user := out["user"].(map[string]any)
	if user["wechat"] != true || user["email"] != "" || user["language"] != "zh" {
		t.Fatalf("user = %v", user)
	}
	// Signing in again is the same account, with the new session key stored.
	code, out2 := call("POST", "/api/wx/login", "", map[string]string{"code": "code-alice-2"})
	if code != 200 || out2["user"].(map[string]any)["id"] != user["id"] {
		t.Fatalf("second login made a different account: %v", out2)
	}
	if code, _ := call("POST", "/api/wx/login", "", map[string]string{"code": "nonsense"}); code != 401 {
		t.Fatalf("bad code: %d", code)
	}
	// An empty email never signs in by password.
	if code, _ := call("POST", "/api/auth/signin", "", map[string]string{"email": "", "password": ""}); code != 401 {
		t.Fatalf("empty-email sign-in: %d", code)
	}

	// Bearer token authenticates; the WeChat account passes the verified gate.
	if code, out := call("GET", "/api/auth/me", token, nil); code != 200 || out["wechat"] != true {
		t.Fatalf("me: %d %v", code, out)
	}
	code, out = call("POST", "/api/conversations", token, map[string]any{})
	if code != 201 && code != 200 {
		t.Fatalf("new conversation: %d %v", code, out)
	}
	conv := out["id"].(string)

	// Balance (signed with the LATEST session key) and a signed purchase.
	if code, out := call("GET", "/api/wx/stamps", token, nil); code != 200 || out["balance"].(float64) != 2 || out["stamps_per_message"].(float64) != 1 {
		t.Fatalf("stamps: %d %v", code, out)
	}
	code, out = call("POST", "/api/wx/stamps/order", token, map[string]int{"quantity": 30})
	if code != 200 || out["mode"] != "short_series_coin" || out["paySig"] != wechat.HMAC("appkey", "requestVirtualPayment&"+out["signData"].(string)) {
		t.Fatalf("order: %d %v", code, out)
	}
	if code, _ := call("POST", "/api/wx/stamps/order", token, map[string]int{"quantity": 0}); code != 400 {
		t.Fatalf("zero quantity: %d", code)
	}

	// 1 stamp per message; a retry of the same message is not charged again.
	u, _ := s.Auth.UserByID(ctx, user["id"].(string))
	req := httptest.NewRequest("POST", "/", nil)
	c1, ok := s.chargeMessage(httptest.NewRecorder(), req, u, conv, "m1")
	if !ok || c1.Balance != 1 || c1.Already {
		t.Fatalf("first charge: %+v %v", c1, ok)
	}
	c1b, ok := s.chargeMessage(httptest.NewRecorder(), req, u, conv, "m1")
	if !ok || !c1b.Already || fx.pays != 1 {
		t.Fatalf("retry charged again: %+v pays=%d", c1b, fx.pays)
	}
	// A failed turn gives the stamp back, exactly once.
	if err := s.Stamps.Refund(ctx, u.ID, c1, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.Stamps.Refund(ctx, u.ID, c1, ""); err != nil || fx.refunds != 1 || fx.balance["alice"] != 2 {
		t.Fatalf("refund: err=%v refunds=%d balance=%d", err, fx.refunds, fx.balance["alice"])
	}
	// After a refund, resending the same message pays again.
	if c, ok := s.chargeMessage(httptest.NewRecorder(), req, u, conv, "m1"); !ok || c.Already || c.Balance != 1 {
		t.Fatalf("resend after refund: %+v", c)
	}
	if c, ok := s.chargeMessage(httptest.NewRecorder(), req, u, conv, "m2"); !ok || c.Balance != 0 {
		t.Fatalf("second message: %+v", c)
	}

	// Out of stamps: the message endpoint answers 402 before any model work.
	code, out = call("POST", "/api/conversations/"+conv+"/messages", token, map[string]string{"content": "hello", "client_msg_id": "m3"})
	if code != 402 || out["error"] != "no_stamps" || out["balance"].(float64) != 0 {
		t.Fatalf("no stamps: %d %v", code, out)
	}
	var charged, failed int
	_ = pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status='charged'), count(*) FILTER (WHERE status='failed') FROM stamp_ledger`).Scan(&charged, &failed)
	if charged != 2 || failed != 1 {
		t.Fatalf("ledger charged=%d failed=%d", charged, failed)
	}

	// A web (email) account is never charged.
	web, err := s.Auth.SignUp(ctx, "web@example.com", "a-long-password", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	if c, ok := s.chargeMessage(httptest.NewRecorder(), req, web, conv, "w1"); !ok || c != nil {
		t.Fatalf("email account was charged: %+v", c)
	}
	// Several WeChat accounts can coexist with an empty email.
	if code, _ := call("POST", "/api/wx/login", "", map[string]string{"code": "code-bob-1"}); code != 200 {
		t.Fatalf("second wechat account: %d", code)
	}
}
