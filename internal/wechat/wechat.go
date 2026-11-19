// Package wechat talks to the WeChat mini program server APIs the product
// needs: sign-in (jscode2session), the app access token, and virtual payment
// (xpay) in coin mode, where a "stamp" is one coin.
//
// Coin mode keeps the balance with WeChat. The mini program buys stamps with
// wx.requestVirtualPayment (signed here); the server spends them with
// currency_pay and gives them back with cancel_currency_pay.
//
// Two signatures guard every xpay call:
//
//	pay_sig   = hex(HMAC-SHA256(AppKey,      uri + "&" + body))   proves it is us
//	signature = hex(HMAC-SHA256(session_key, body))               proves it is that user's live session
//
// The body that is signed must be byte-for-byte the body that is sent.
package wechat

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

type Config struct {
	AppID     string
	AppSecret string
	// Virtual payment. OfferID and AppKey come from the mini program's
	// 虚拟支付 console. Env 0 is production, 1 is the sandbox; the sandbox uses
	// its own AppKey.
	OfferID string
	AppKey  string
	Env     int
}

// Enabled reports whether sign-in is configured.
func (c Config) Enabled() bool { return c.AppID != "" && c.AppSecret != "" }

// PayEnabled reports whether virtual payment is configured too.
func (c Config) PayEnabled() bool { return c.Enabled() && c.OfferID != "" && c.AppKey != "" }

type Client struct {
	Config
	HTTP    *http.Client
	BaseURL string // https://api.weixin.qq.com; overridden in tests

	mu       sync.Mutex
	token    string
	tokenExp time.Time
}

func New(c Config) *Client {
	return &Client{Config: c, HTTP: &http.Client{Timeout: 10 * time.Second}, BaseURL: "https://api.weixin.qq.com"}
}

// Error is a non-zero errcode from WeChat.
type Error struct {
	Code int
	Msg  string
}

func (e *Error) Error() string { return fmt.Sprintf("wechat errcode %d: %s", e.Code, e.Msg) }

// ErrCode returns the WeChat errcode inside err, or 0.
func ErrCode(err error) int {
	var we *Error
	if errors.As(err, &we) {
		return we.Code
	}
	return 0
}

type base struct {
	ErrCode int    `json:"errcode"`
	ErrMsg  string `json:"errmsg"`
}

func (b base) err() error {
	if b.ErrCode != 0 {
		return &Error{Code: b.ErrCode, Msg: b.ErrMsg}
	}
	return nil
}

// ── Sign-in ────────────────────────────────────────────────────────────────

type Session struct {
	OpenID     string `json:"openid"`
	UnionID    string `json:"unionid"`
	SessionKey string `json:"session_key"`
}

// Code2Session exchanges the code from wx.login for the user's openid and the
// session key. The code works once and for five minutes.
func (c *Client) Code2Session(ctx context.Context, code string) (*Session, error) {
	q := url.Values{"appid": {c.AppID}, "secret": {c.AppSecret}, "js_code": {code}, "grant_type": {"authorization_code"}}
	var out struct {
		base
		Session
	}
	if err := c.do(ctx, http.MethodGet, c.BaseURL+"/sns/jscode2session?"+q.Encode(), nil, &out); err != nil {
		return nil, err
	}
	if err := out.err(); err != nil {
		return nil, err
	}
	if out.OpenID == "" || out.SessionKey == "" {
		return nil, errors.New("wechat: jscode2session returned no openid")
	}
	return &out.Session, nil
}

// ── Access token ───────────────────────────────────────────────────────────

// AccessToken uses the stable_token endpoint: unlike the classic token API,
// fetching one does not invalidate the token another pod is still using.
func (c *Client) AccessToken(ctx context.Context, force bool) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !force && c.token != "" && time.Now().Before(c.tokenExp) {
		return c.token, nil
	}
	body, _ := json.Marshal(map[string]any{"grant_type": "client_credential", "appid": c.AppID, "secret": c.AppSecret, "force_refresh": force})
	var out struct {
		base
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := c.do(ctx, http.MethodPost, c.BaseURL+"/cgi-bin/stable_token", body, &out); err != nil {
		return "", err
	}
	if err := out.err(); err != nil {
		return "", err
	}
	c.token = out.AccessToken
	// Refresh five minutes early so a request never carries a token that
	// expires in flight.
	c.tokenExp = time.Now().Add(time.Duration(out.ExpiresIn)*time.Second - 5*time.Minute)
	return c.token, nil
}

// ── Virtual payment: signatures ────────────────────────────────────────────

func HMAC(key, msg string) string {
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte(msg))
	return hex.EncodeToString(m.Sum(nil))
}

// PaymentRequest is what the mini program passes to wx.requestVirtualPayment.
type PaymentRequest struct {
	SignData  string `json:"signData"`
	PaySig    string `json:"paySig"`
	Signature string `json:"signature"`
	Mode      string `json:"mode"`
}

// SignCoinPurchase prepares a purchase of qty stamps. The price is the coin
// price set in the console; WeChat computes and charges it.
func (c *Client) SignCoinPurchase(sessionKey, outTradeNo string, qty int, attach string) (*PaymentRequest, error) {
	if !c.PayEnabled() {
		return nil, errors.New("wechat: virtual payment is not configured")
	}
	// Field order is irrelevant to WeChat; only the exact bytes matter, and the
	// same bytes are signed and handed to the client.
	sd, err := json.Marshal(struct {
		OfferID      string `json:"offerId"`
		BuyQuantity  int    `json:"buyQuantity"`
		Env          int    `json:"env"`
		CurrencyType string `json:"currencyType"`
		Platform     string `json:"platform"`
		OutTradeNo   string `json:"outTradeNo"`
		Attach       string `json:"attach"`
	}{c.OfferID, qty, c.Env, "CNY", "android", outTradeNo, attach})
	if err != nil {
		return nil, err
	}
	s := string(sd)
	return &PaymentRequest{SignData: s, PaySig: HMAC(c.AppKey, "requestVirtualPayment&"+s),
		Signature: HMAC(sessionKey, s), Mode: "short_series_coin"}, nil
}

// ── Virtual payment: server APIs ───────────────────────────────────────────

type Balance struct {
	Balance        int `json:"balance"`         // spendable, paid + present
	PresentBalance int `json:"present_balance"` // of which granted for free
	SumSave        int `json:"sum_save"`
	SumCost        int `json:"sum_cost"`
}

func (c *Client) QueryBalance(ctx context.Context, openid, sessionKey, ip string) (*Balance, error) {
	var out struct {
		base
		Balance
	}
	err := c.xpay(ctx, "/xpay/query_user_balance", sessionKey, map[string]any{"openid": openid, "env": c.Env, "user_ip": ip}, &out)
	if err != nil {
		return nil, err
	}
	return &out.Balance, out.err()
}

type PayResult struct {
	OrderID     string `json:"order_id"`
	Balance     int    `json:"balance"`
	UsedPresent int    `json:"used_present_amount"`
}

// CurrencyPay spends amount stamps. orderID is ours and unique: WeChat refuses
// a second order with the same id, which is what makes a retry safe.
func (c *Client) CurrencyPay(ctx context.Context, openid, sessionKey, ip, orderID string, amount int, payitem, remark string) (*PayResult, error) {
	var out struct {
		base
		PayResult
	}
	err := c.xpay(ctx, "/xpay/currency_pay", sessionKey, map[string]any{"openid": openid, "env": c.Env, "user_ip": ip,
		"amount": amount, "order_id": orderID, "payitem": payitem, "remark": remark}, &out)
	if err != nil {
		return nil, err
	}
	return &out.PayResult, out.err()
}

// CancelCurrencyPay returns the stamps spent by payOrderID. refundID is a new,
// unique order id for the refund itself.
func (c *Client) CancelCurrencyPay(ctx context.Context, openid, sessionKey, ip, payOrderID, refundID string, amount int) error {
	var out base
	err := c.xpay(ctx, "/xpay/cancel_currency_pay", sessionKey, map[string]any{"openid": openid, "env": c.Env, "user_ip": ip,
		"pay_order_id": payOrderID, "order_id": refundID, "amount": amount}, &out)
	if err != nil {
		return err
	}
	return out.err()
}

// xpay signs and sends one call, refreshing the access token once if WeChat
// says it is stale.
func (c *Client) xpay(ctx context.Context, uri, sessionKey string, body map[string]any, out any) error {
	if !c.PayEnabled() {
		return errors.New("wechat: virtual payment is not configured")
	}
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	for attempt := 0; ; attempt++ {
		tok, err := c.AccessToken(ctx, attempt > 0)
		if err != nil {
			return err
		}
		q := url.Values{"access_token": {tok}, "pay_sig": {HMAC(c.AppKey, uri+"&"+string(b))},
			"signature": {HMAC(sessionKey, string(b))}, "sig_method": {"hmac_sha256"}}
		raw := json.RawMessage{}
		if err := c.do(ctx, http.MethodPost, c.BaseURL+uri+"?"+q.Encode(), b, &raw); err != nil {
			return err
		}
		var probe base
		_ = json.Unmarshal(raw, &probe)
		if (probe.ErrCode == 40001 || probe.ErrCode == 42001) && attempt == 0 {
			continue
		}
		return json.Unmarshal(raw, out)
	}
}

func (c *Client) do(ctx context.Context, method, u string, body []byte, out any) error {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("wechat: %w", err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("wechat: http %d", res.StatusCode)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("wechat: bad response: %w", err)
	}
	return nil
}
