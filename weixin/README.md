# ACT · Vera — WeChat mini program (微信小程序)

The WeChat client for Vera: WeChat sign-in, chat that streams like the web
app, and **stamps** (邮票) bought with WeChat virtual payment. **Sending one
message costs 1 stamp.**

```
weixin/
  app.js / app.json / app.wxss   shell, tab bar (Chats · Stamps), WeChat palette
  utils/config.js                API_BASE and the stamp packs offered
  utils/api.js                   wx.login sign-in, bearer token, silent re-login, streaming
  utils/sse.js                   chunk → UTF-8 → server-sent events
  pages/index                    conversation list (会话列表)
  pages/chat                     chat: green/white bubbles, live reply, tap "!" to resend
  pages/stamps                   balance, packs, wx.requestVirtualPayment, recent use
```

## How it works

### Sign-in

```
wx.login() ─code─► POST /api/wx/login ─► jscode2session ─► openid + session_key
                                       └► find or create the account by (appid, openid)
            ◄─ { token, user } ─────────┘
```

The account has no email and no password. The token is the same kind of
session the web app keeps in a cookie; the mini program sends it as
`Authorization: Bearer <token>`. WeChat already verified the person, so a
WeChat account passes the gate that web accounts pass by confirming an email.

The server stores the **latest** `session_key`, because every virtual payment
call is signed with it. When WeChat refuses a signature (the user's WeChat
session moved on), the API answers `502 {"error":"wx_pay_error"}` and the mini
program calls `wx.login` again and retries once — no prompt.

### Stamps: virtual payment in coin mode (代币)

A stamp is one coin of the mini program's virtual payment. **WeChat holds the
balance**; the server never edits a number of its own.

| Step | Mini program | Server | WeChat API |
|---|---|---|---|
| Buy N stamps | `POST /api/wx/stamps/order {quantity}` → `wx.requestVirtualPayment` (mode `short_series_coin`) | signs `signData` with `paySig = HMAC(AppKey, "requestVirtualPayment&"+signData)` and `signature = HMAC(session_key, signData)` | payment sheet |
| See balance | `GET /api/wx/stamps` | | `xpay/query_user_balance` |
| Send a message | `POST /api/conversations/{id}/messages` | **charges 1 stamp before any model work** | `xpay/currency_pay` |
| Turn failed | — | refunds that stamp | `xpay/cancel_currency_pay` |

Guarantees, enforced by the `stamp_ledger` table (migration `0003_wechat.sql`):

- **One charge per message.** Every send carries a `client_msg_id`; a unique
  index allows one live charge per (user, conversation, client_msg_id). A
  retried POST or two racing retries pay once.
- **No answer, no charge.** If the turn fails, the stamp is refunded exactly
  once (the ledger row flips `charged → refunded` before WeChat is called).
- **Out of stamps** answers `402 {"error":"no_stamps","balance":0}` before the
  message is stored; the mini program offers the Stamps page.
- Web (email) accounts are never charged. A deployment without the payment
  keys charges nobody and logs `WECHAT_STAMPS_DISABLED` at startup.

## Set it up

1. **Mini program console** (mp.weixin.qq.com)
   - 开发管理 → 服务器域名 → request合法域名: your ACT origin
     (`https://act.heros-agent.space`).
   - 虚拟支付 → enable it, create the **代币** (coin) product, set the price of
     one coin, and note the **OfferID** and **AppKey** (the sandbox has its own
     AppKey).
2. **Server environment**

   | Variable | Value |
   |---|---|
   | `ACT_WX_APPID` | mini program AppID |
   | `ACT_WX_APPSECRET` | mini program AppSecret |
   | `ACT_WX_OFFER_ID` | virtual payment OfferID |
   | `ACT_WX_PAY_APPKEY` | virtual payment AppKey (production or sandbox, matching `ACT_WX_PAY_ENV`) |
   | `ACT_WX_PAY_ENV` | `0` production, `1` sandbox |

   In k8s these come from the optional `act-wechat` secret
   (`deploy/k8s/10-secrets.yaml`, Secrets Manager key `act/wechat`).
3. **This folder**: put your AppID in `project.config.json`, check
   `API_BASE` in `utils/config.js`, open the folder in WeChat DevTools
   (微信开发者工具), and upload.

## Notes

- Use the sandbox (`ACT_WX_PAY_ENV=1` + sandbox AppKey) for testing purchases.
- Virtual payment is subject to WeChat's platform rules (category
  qualification, iOS availability). The Stamps page shows WeChat's error if the
  payment sheet is refused.
- Replies are Markdown on the server; bubbles show them as plain text with the
  Markdown syntax stripped.
- Server tests: `internal/wechat/wechat_test.go` (signatures, token refresh,
  coin APIs against a fake WeChat) and `internal/httpapi/wechat_test.go`
  (sign-in, bearer auth, charge once per message, refund, 402; needs
  `ACT_TEST_DATABASE_URL`).
