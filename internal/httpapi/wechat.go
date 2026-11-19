package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/damonleelcx/Law-Med-agent/internal/auth"
	"github.com/damonleelcx/Law-Med-agent/internal/persona"
	"github.com/damonleelcx/Law-Med-agent/internal/wechat"
)

// wxLogin: the mini program sends the code from wx.login; we exchange it for
// the openid, find or create the account, and answer with a session token the
// mini program sends back as "Authorization: Bearer <token>".
func (s *Server) wxLogin(w http.ResponseWriter, r *http.Request) {
	if s.WX == nil {
		writeErr(w, 404, "wechat sign-in is not enabled")
		return
	}
	var in struct {
		Code     string `json:"code"`
		Language string `json:"language"`
	}
	if err := readJSON(r, &in); err != nil || strings.TrimSpace(in.Code) == "" {
		writeErr(w, 400, "code is required")
		return
	}
	sess, err := s.WX.Code2Session(r.Context(), strings.TrimSpace(in.Code))
	if err != nil {
		slog.Warn("wx code2session", "err", err)
		writeErr(w, 401, "wechat sign-in failed, try again")
		return
	}
	u, err := s.Auth.WeChatSignIn(r.Context(), s.WX.AppID, sess.OpenID, sess.UnionID, sess.SessionKey, persona.Normalize(in.Language))
	if err != nil {
		slog.Error("wx signin", "err", err)
		writeErr(w, 500, "could not sign in")
		return
	}
	token, exp, err := s.Auth.CreateSession(r.Context(), u.ID, r.UserAgent(), clientIP(r))
	if err != nil {
		writeErr(w, 500, "could not sign in")
		return
	}
	writeJSON(w, 200, map[string]any{"token": token, "expires_at": exp, "user": s.view(r, u),
		"stamps_enabled": s.Stamps != nil, "stamps_per_message": wechat.StampsPerMessage})
}

// wxStamps: live balance (held by WeChat) and our recent deductions.
func (s *Server) wxStamps(w http.ResponseWriter, r *http.Request, u *auth.User) {
	if s.Stamps == nil || !u.WeChat {
		writeJSON(w, 200, map[string]any{"enabled": false, "stamps_per_message": 0})
		return
	}
	bal, err := s.Stamps.Balance(r.Context(), u.ID, clientIP(r))
	if err != nil {
		s.wxPayErr(w, "balance", err)
		return
	}
	ledger, _ := s.Stamps.Ledger(r.Context(), u.ID, 30)
	writeJSON(w, 200, map[string]any{"enabled": true, "balance": bal.Balance, "present_balance": bal.PresentBalance,
		"stamps_per_message": wechat.StampsPerMessage, "ledger": ledger})
}

// wxOrder signs a stamp purchase for wx.requestVirtualPayment. The price is the
// coin price configured in the WeChat virtual payment console.
func (s *Server) wxOrder(w http.ResponseWriter, r *http.Request, u *auth.User) {
	if s.Stamps == nil || !u.WeChat {
		writeErr(w, 404, "stamps are not enabled")
		return
	}
	var in struct {
		Quantity int `json:"quantity"`
	}
	if err := readJSON(r, &in); err != nil || in.Quantity < 1 || in.Quantity > 2000 {
		writeErr(w, 400, "quantity must be between 1 and 2000")
		return
	}
	req, err := s.Stamps.Purchase(r.Context(), u.ID, in.Quantity)
	if err != nil {
		s.wxPayErr(w, "order", err)
		return
	}
	writeJSON(w, 200, req)
}

// chargeMessage takes the stamp for one message before any model work. It
// answers the request itself (and returns ok=false) when the message cannot
// be sent. A non-WeChat account, or a deployment without virtual payment, is
// not charged.
func (s *Server) chargeMessage(w http.ResponseWriter, r *http.Request, u *auth.User, convID, clientMsgID string) (*wechat.Charge, bool) {
	if s.Stamps == nil || !u.WeChat {
		return nil, true
	}
	c, err := s.Stamps.ChargeMessage(r.Context(), u.ID, convID, clientMsgID, clientIP(r))
	if err != nil {
		var ns *wechat.NoStampsError
		if errors.As(err, &ns) {
			writeJSON(w, 402, map[string]any{"error": "no_stamps", "balance": ns.Balance, "stamps_per_message": wechat.StampsPerMessage})
			return nil, false
		}
		s.wxPayErr(w, "charge", err)
		return nil, false
	}
	return c, true
}

// wxPayErr: a WeChat error is usually a stale session_key (the user's WeChat
// session moved on). The mini program answers "wx_pay_error" by calling
// wx.login again and retrying once.
func (s *Server) wxPayErr(w http.ResponseWriter, op string, err error) {
	if errors.Is(err, wechat.ErrNoIdentity) {
		writeErr(w, 403, "not a wechat account")
		return
	}
	slog.Warn("wx pay", "op", op, "err", err)
	writeJSON(w, 502, map[string]any{"error": "wx_pay_error", "code": wechat.ErrCode(err)})
}
