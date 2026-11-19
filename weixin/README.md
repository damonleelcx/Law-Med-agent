# ACT · Vera — WeChat mini program (微信小程序)

Everything the web app does, inside WeChat, in **简体中文 only**: chat with
Vera, cases with live plans, approvals, documents and uploads, and every
setting. It uses the web app's design (cream, ink and ember, light and dark),
Vera's portrait and her three moods, and the same server and soul. On top:
WeChat sign-in, and **stamps** (邮票) bought with WeChat virtual payment.
**Sending one message costs 1 stamp.**

```
weixin/
  app.js / app.json / app.wxss   shell, 4 tabs, design tokens + shared styles (from web/src/styles)
  theme.json                     light/dark chrome (nav bar, tab bar)
  utils/config.js                API_BASE (local server inside DevTools) and stamp packs
  utils/api.js                   sign-in on request, bearer token, silent re-login, streaming, upload
  utils/live.js                  /api/stream: "something changed" → pages refetch (web live.tsx)
  utils/page.js                  page() wrapper: strings, signed-in state, theme, live, login sheet
  utils/strings.js               the web app's 中文 dictionary
  utils/md.js · fmt.js · ui.js   Markdown → rich-text, times/activity/timeline labels, appearance
  components/login-sheet         the one place sign-in is asked for
  components/goal-card           case card in the chat, follows its plan live (web GoalCard)
  components/approval-card       同意 / 拒绝 with a note (web ApprovalCard)
```

| Web app | Mini program |
|---|---|
| Sidebar: new chat, search, conversations | 对话 tab: new chat, search, archived; long-press → 重命名 / 归档 / 删除 |
| Chat: streaming, Vera's moods, case cards, inline approvals, attach | pages/chat — attach takes a file from a WeChat chat or a photo |
| Cases, case view (plan / timeline / files, next, reminders, criteria, usage, pause / resume / cancel) | 案件 tab, pages/case |
| Documents, upload, document view, download | 文件 tab, pages/doc — 复制全文 / 发送到聊天 instead of download |
| Approvals (own + professional queue) | pages/approvals, badge on 我的 |
| Settings: profile, Vera, notifications, privacy & memory (export, delete), devices, limits, professional licence, appearance, admin | 我的 tab → pages/settings?tab=… — language is fixed to 简体中文; email toggles are off for WeChat accounts (no email) |
| — | pages/stamps: balance, packs, recent use |

## How it works

### Browse first, sign in when you act

Nothing signs in at launch: every page opens signed out (WeChat's review rules
expect that). The login sheet appears only when an action needs an account —
sending a message, tapping a suggestion, opening your history, cases, files or
settings, or buying stamps — and "暂不登录" keeps what was typed.

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

## Run it locally in WeChat DevTools

`scripts/wx-dev.ps1` starts the whole stack in Docker: Postgres, ACT on
`127.0.0.1:8080` (where the app points inside DevTools), and `cmd/devmock` on
`8090`, a stand-in WeChat that accepts any login code, keeps a stamp balance
(3 to start) and checks payment signatures like the real thing.

```powershell
.\scripts\wx-dev.ps1                                              # replies from devmock
.\scripts\wx-dev.ps1 -KeyFile D:\.ENV -KeyName QWEN_LLM_API_KEY_V2  # replies from the real model
curl.exe -X POST "http://127.0.0.1:8090/mock/grant?n=10"           # add stamps (the simulator cannot pay)
```

Open `weixin/` in DevTools. `project.config.json` uses the test AppID
`touristappid`; `project.private.config.json` (not committed) turns off the
request-domain check for the local server. The DevTools command line and
automation need a real AppID.

## Notes

- Use the sandbox (`ACT_WX_PAY_ENV=1` + sandbox AppKey) for testing purchases.
- Virtual payment is subject to WeChat's platform rules (category
  qualification, iOS availability). The Stamps page shows WeChat's error if the
  payment sheet is refused.
- Uploads: `wx.uploadFile` names the file part after a temp path, so the app
  sends the real name as form field `name`; the server keeps it when it is valid
  UTF-8 and its extension matches the file sent.
- Server tests: `internal/wechat/wechat_test.go` (signatures, token refresh,
  coin APIs against a fake WeChat) and `internal/httpapi/wechat_test.go`
  (sign-in, bearer auth, charge once per message, refund, 402, upload names,
  passwordless delete for WeChat accounts; needs `ACT_TEST_DATABASE_URL`).
