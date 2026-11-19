package wechat

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// StampsPerMessage is the price of sending one chat message.
const StampsPerMessage = 1

var (
	// ErrNoStamps: the balance is below the price of a message.
	ErrNoStamps = errors.New("not enough stamps")
	// ErrNoIdentity: the account did not sign in with WeChat.
	ErrNoIdentity = errors.New("no wechat identity")
)

// Stamps spends and refunds stamps against WeChat's coin balance and keeps our
// own ledger of every deduction.
type Stamps struct {
	Pool *pgxpool.Pool
	WX   *Client
}

type Identity struct {
	OpenID     string
	SessionKey string
}

func (s *Stamps) Identity(ctx context.Context, userID string) (*Identity, error) {
	var id Identity
	err := s.Pool.QueryRow(ctx, `SELECT openid, session_key FROM wechat_identities WHERE user_id=$1 AND appid=$2`,
		userID, s.WX.AppID).Scan(&id.OpenID, &id.SessionKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNoIdentity
	}
	return &id, err
}

// Charge is one paid message.
type Charge struct {
	OrderID string `json:"order_id"`
	Amount  int    `json:"amount"`
	Balance int    `json:"balance"`
	// Already: this message was paid for by an earlier attempt; nothing new
	// was spent.
	Already bool `json:"already"`
}

// ChargeMessage spends StampsPerMessage for one sent message. clientMsgID makes
// it idempotent: a retry of the same message is not charged again.
func (s *Stamps) ChargeMessage(ctx context.Context, userID, convID, clientMsgID, ip string) (*Charge, error) {
	id, err := s.Identity(ctx, userID)
	if err != nil {
		return nil, err
	}
	amount := StampsPerMessage
	orderID := NewOrderID("st")

	// Claim first. If this message already holds a live charge, it was paid.
	_, err = s.Pool.Exec(ctx, `INSERT INTO stamp_ledger (user_id, order_id, conversation_id, client_msg_id, amount)
		VALUES ($1,$2,$3,$4,$5)`, userID, orderID, convID, clientMsgID, amount)
	if err != nil {
		if strings.Contains(err.Error(), "23505") {
			c := &Charge{Already: true}
			_ = s.Pool.QueryRow(ctx, `SELECT order_id, amount, coalesce(balance_after,0) FROM stamp_ledger
				WHERE user_id=$1 AND conversation_id=$2 AND client_msg_id=$3 AND status IN ('pending','charged')`,
				userID, convID, clientMsgID).Scan(&c.OrderID, &c.Amount, &c.Balance)
			return c, nil
		}
		return nil, err
	}
	fail := func(e error) (*Charge, error) {
		_, _ = s.Pool.Exec(context.WithoutCancel(ctx), `UPDATE stamp_ledger SET status='failed', error=$2, updated_at=now() WHERE order_id=$1`,
			orderID, truncate(e.Error(), 300))
		return nil, e
	}

	// Check first, so "out of stamps" is a clear answer rather than whichever
	// error code currency_pay happens to use for it.
	bal, err := s.WX.QueryBalance(ctx, id.OpenID, id.SessionKey, ip)
	if err != nil {
		return fail(err)
	}
	if bal.Balance < amount {
		return fail(&NoStampsError{Balance: bal.Balance})
	}
	res, err := s.WX.CurrencyPay(ctx, id.OpenID, id.SessionKey, ip, orderID, amount, "message", "1 message")
	if err != nil {
		return fail(err)
	}
	_, err = s.Pool.Exec(context.WithoutCancel(ctx), `UPDATE stamp_ledger SET status='charged', wx_order_id=$2, balance_after=$3, updated_at=now()
		WHERE order_id=$1`, orderID, res.OrderID, res.Balance)
	if err != nil {
		return nil, err
	}
	return &Charge{OrderID: orderID, Amount: amount, Balance: res.Balance}, nil
}

// Refund gives back a charge whose message could not be answered.
func (s *Stamps) Refund(ctx context.Context, userID string, c *Charge, ip string) error {
	if c == nil || c.Already || c.OrderID == "" {
		return nil
	}
	id, err := s.Identity(ctx, userID)
	if err != nil {
		return err
	}
	// Mark first: a refund must not run twice even if two callers race.
	tag, err := s.Pool.Exec(ctx, `UPDATE stamp_ledger SET status='refunded', updated_at=now() WHERE order_id=$1 AND status='charged'`, c.OrderID)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	if err := s.WX.CancelCurrencyPay(ctx, id.OpenID, id.SessionKey, ip, c.OrderID, NewOrderID("rf"), c.Amount); err != nil {
		_, _ = s.Pool.Exec(context.WithoutCancel(ctx), `UPDATE stamp_ledger SET status='charged', error=$2, updated_at=now() WHERE order_id=$1`,
			c.OrderID, "refund failed: "+truncate(err.Error(), 280))
		return err
	}
	return nil
}

// Balance reads the live balance from WeChat.
func (s *Stamps) Balance(ctx context.Context, userID, ip string) (*Balance, error) {
	id, err := s.Identity(ctx, userID)
	if err != nil {
		return nil, err
	}
	return s.WX.QueryBalance(ctx, id.OpenID, id.SessionKey, ip)
}

// Purchase signs a wx.requestVirtualPayment for qty stamps.
func (s *Stamps) Purchase(ctx context.Context, userID string, qty int) (*PaymentRequest, error) {
	id, err := s.Identity(ctx, userID)
	if err != nil {
		return nil, err
	}
	return s.WX.SignCoinPurchase(id.SessionKey, NewOrderID("buy"), qty, "stamps")
}

type LedgerEntry struct {
	OrderID   string    `json:"order_id"`
	Amount    int       `json:"amount"`
	Status    string    `json:"status"`
	Balance   *int      `json:"balance_after"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Stamps) Ledger(ctx context.Context, userID string, limit int) ([]LedgerEntry, error) {
	rows, err := s.Pool.Query(ctx, `SELECT order_id, amount, status, balance_after, created_at FROM stamp_ledger
		WHERE user_id=$1 AND status IN ('charged','refunded') ORDER BY id DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LedgerEntry{}
	for rows.Next() {
		var e LedgerEntry
		if err := rows.Scan(&e.OrderID, &e.Amount, &e.Status, &e.Balance, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// NoStampsError carries the balance the user actually has.
type NoStampsError struct{ Balance int }

func (e *NoStampsError) Error() string {
	return fmt.Sprintf("not enough stamps (balance %d)", e.Balance)
}
func (e *NoStampsError) Unwrap() error { return ErrNoStamps }

// NewOrderID is unique and inside xpay's order id rules (8–32 characters of
// [0-9A-Za-z_-]).
func NewOrderID(prefix string) string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
