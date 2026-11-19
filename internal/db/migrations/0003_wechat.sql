-- 0003 · WeChat mini program: sign-in by openid, and stamps paid for with
-- WeChat virtual payment (xpay, coin mode).
--
-- A WeChat account has no email and no password. Its users row carries
-- email = '' and password_hash = '' (which CheckPassword never accepts), so the
-- email uniqueness index has to ignore the empty string.
DROP INDEX IF EXISTS users_email_uq;
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE deleted_at IS NULL AND email <> '';

-- One WeChat identity per user. session_key is the key WeChat issued at the
-- latest wx.login; xpay's user signature is an HMAC under it, so the server
-- must keep the current one. It is a secret: never returned by the API.
CREATE TABLE wechat_identities (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  appid       text NOT NULL,
  openid      text NOT NULL,
  unionid     text NOT NULL DEFAULT '',
  session_key text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appid, openid)
);

-- The balance itself lives with WeChat (coin mode). This ledger is our side of
-- every deduction: order_id is unique, so a retried message is charged once,
-- and a turn that fails is refunded exactly once.
CREATE TABLE stamp_ledger (
  id              bigserial PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id        text NOT NULL UNIQUE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  client_msg_id   text NOT NULL DEFAULT '',
  amount          int NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','charged','failed','refunded')),
  wx_order_id     text NOT NULL DEFAULT '',
  balance_after   int,
  error           text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stamp_ledger_user ON stamp_ledger (user_id, created_at DESC);
-- The claim: one live charge per sent message. A retried POST (same client id)
-- or two racing retries collide here instead of paying twice. A failed or
-- refunded charge drops out of the index, so the next retry can pay.
CREATE UNIQUE INDEX stamp_ledger_msg_uq ON stamp_ledger (user_id, conversation_id, client_msg_id)
  WHERE client_msg_id <> '' AND status IN ('pending','charged');
