package wechat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
)

func TestHMACKnownVector(t *testing.T) {
	// RFC 4231 test case 2.
	got := HMAC("Jefe", "what do ya want for nothing?")
	want := "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
	if got != want {
		t.Fatalf("HMAC = %s, want %s", got, want)
	}
}

func TestSignCoinPurchase(t *testing.T) {
	c := New(Config{AppID: "wxapp", AppSecret: "s", OfferID: "1450000000", AppKey: "appkey", Env: 1})
	req, err := c.SignCoinPurchase("sesskey", "buy_123", 50, "stamps")
	if err != nil {
		t.Fatal(err)
	}
	var sd map[string]any
	if err := json.Unmarshal([]byte(req.SignData), &sd); err != nil {
		t.Fatal(err)
	}
	if sd["offerId"] != "1450000000" || sd["buyQuantity"].(float64) != 50 || sd["env"].(float64) != 1 ||
		sd["currencyType"] != "CNY" || sd["outTradeNo"] != "buy_123" {
		t.Fatalf("signData = %s", req.SignData)
	}
	if req.PaySig != HMAC("appkey", "requestVirtualPayment&"+req.SignData) {
		t.Fatal("paySig is not HMAC(appKey, requestVirtualPayment&signData)")
	}
	if req.Signature != HMAC("sesskey", req.SignData) {
		t.Fatal("signature is not HMAC(session_key, signData)")
	}
	if req.Mode != "short_series_coin" {
		t.Fatalf("mode = %s", req.Mode)
	}
}

func TestOrderIDRules(t *testing.T) {
	re := regexp.MustCompile(`^[0-9A-Za-z_-]{8,32}$`)
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		for _, p := range []string{"st", "rf", "buy"} {
			id := NewOrderID(p)
			if !re.MatchString(id) {
				t.Fatalf("order id %q breaks xpay's rules", id)
			}
			if seen[id] {
				t.Fatalf("duplicate order id %q", id)
			}
			seen[id] = true
		}
	}
}

// fakeWeChat checks both signatures on every xpay call the way WeChat does,
// and keeps a coin balance.
func fakeWeChat(t *testing.T, appKey, sessionKey string, balance *int64, staleOnce *atomic.Bool) *httptest.Server {
	var tokens atomic.Int64
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch r.URL.Path {
		case "/sns/jscode2session":
			if r.URL.Query().Get("js_code") != "good" {
				w.Write([]byte(`{"errcode":40029,"errmsg":"invalid code"}`))
				return
			}
			w.Write([]byte(`{"openid":"o1","session_key":"` + sessionKey + `","unionid":"u1"}`))
		case "/cgi-bin/stable_token":
			n := tokens.Add(1)
			w.Write([]byte(`{"access_token":"tok` + string(rune('0'+n)) + `","expires_in":7200}`))
		default:
			if !strings.HasPrefix(r.URL.Path, "/xpay/") {
				http.NotFound(w, r)
				return
			}
			q := r.URL.Query()
			if staleOnce != nil && staleOnce.CompareAndSwap(true, false) {
				w.Write([]byte(`{"errcode":42001,"errmsg":"access_token expired"}`))
				return
			}
			if q.Get("pay_sig") != HMAC(appKey, r.URL.Path+"&"+string(body)) {
				t.Errorf("%s: bad pay_sig", r.URL.Path)
				w.Write([]byte(`{"errcode":-1,"errmsg":"bad pay_sig"}`))
				return
			}
			if q.Get("signature") != HMAC(sessionKey, string(body)) {
				t.Errorf("%s: bad signature", r.URL.Path)
				w.Write([]byte(`{"errcode":-1,"errmsg":"bad signature"}`))
				return
			}
			var in map[string]any
			_ = json.Unmarshal(body, &in)
			switch r.URL.Path {
			case "/xpay/query_user_balance":
				json.NewEncoder(w).Encode(map[string]any{"errcode": 0, "balance": *balance})
			case "/xpay/currency_pay":
				amt := int64(in["amount"].(float64))
				if *balance < amt {
					w.Write([]byte(`{"errcode":268490004,"errmsg":"balance not enough"}`))
					return
				}
				*balance -= amt
				json.NewEncoder(w).Encode(map[string]any{"errcode": 0, "order_id": "wx_" + in["order_id"].(string), "balance": *balance})
			case "/xpay/cancel_currency_pay":
				*balance += int64(in["amount"].(float64))
				w.Write([]byte(`{"errcode":0}`))
			}
		}
	}))
}

func TestXpayRoundTrip(t *testing.T) {
	balance := int64(2)
	stale := &atomic.Bool{}
	srv := fakeWeChat(t, "appkey", "sk", &balance, stale)
	defer srv.Close()
	c := New(Config{AppID: "wxapp", AppSecret: "s", OfferID: "1", AppKey: "appkey"})
	c.BaseURL = srv.URL
	ctx := context.Background()

	s, err := c.Code2Session(ctx, "good")
	if err != nil || s.OpenID != "o1" || s.SessionKey != "sk" {
		t.Fatalf("Code2Session = %+v, %v", s, err)
	}
	if _, err := c.Code2Session(ctx, "bad"); ErrCode(err) != 40029 {
		t.Fatalf("bad code: err = %v", err)
	}

	// An expired token is refreshed once, transparently.
	stale.Store(true)
	b, err := c.QueryBalance(ctx, "o1", "sk", "1.2.3.4")
	if err != nil || b.Balance != 2 {
		t.Fatalf("QueryBalance = %+v, %v", b, err)
	}
	res, err := c.CurrencyPay(ctx, "o1", "sk", "1.2.3.4", "st_1", 1, "message", "1 message")
	if err != nil || res.Balance != 1 || res.OrderID != "wx_st_1" {
		t.Fatalf("CurrencyPay = %+v, %v", res, err)
	}
	if err := c.CancelCurrencyPay(ctx, "o1", "sk", "1.2.3.4", "st_1", "rf_1", 1); err != nil {
		t.Fatal(err)
	}
	if balance != 2 {
		t.Fatalf("balance after refund = %d, want 2", balance)
	}
	balance = 0
	if _, err := c.CurrencyPay(ctx, "o1", "sk", "", "st_2", 1, "message", ""); ErrCode(err) == 0 {
		t.Fatal("paying with no balance should fail")
	}
}
