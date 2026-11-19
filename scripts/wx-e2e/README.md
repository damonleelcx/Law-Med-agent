# Mini program UI tests

These tests drive the Vera mini program (`weixin/`) inside WeChat DevTools the way a person would: they tap, long-press and type into the rendered pages, then check what the pages show and what the local server stored.

WeChat's own system UI can't be automated: the action sheet, confirm dialog, file and photo pickers, payment sheet, clipboard and share. Each of those calls is stubbed with `mockWxMethod`, and the step's name says when one is.

| Suite | Model | Covers |
|---|---|---|
| `devmock.js` (28 steps) | devmock: no tokens used | Every screen and button. The case and approval are created directly in the local database. |
| `real-model.js` (31 steps) | Hunyuan | Also Vera's own work: she opens a real case, plans it and drafts documents. |

`real-model.js` uses a lot of tokens: one run used about 880k, enough to run out a free quota on a key shared with production. Use `devmock.js` day to day and `real-model.js` before a release.

## Setup (once)

1. **Local stack.** `devmock.js` needs it started without a model key:
   ```powershell
   .\scripts\wx-dev.ps1
   ```
   This starts Postgres (`act-pg`), ACT as the China copy on 127.0.0.1:8080, and devmock on 8090. For `real-model.js`, add `-KeyFile <dotenv> -KeyName HUNYUAN_LLM_API_KEY`.
2. **DevTools.** Log in to WeChat DevTools.
3. **AppID.** Give `weixin/` a real AppID in the git-ignored `weixin/project.private.config.json`. Automation doesn't work with `touristappid`.
   ```json
   { "appid": "wx…", "setting": { "urlCheck": false } }
   ```
4. **Automation port.** Open the project with automation on port 9420:
   ```bash
   "/c/Program Files (x86)/Tencent/微信web开发者工具/cli.bat" auto --project "C:\\…\\Law-Med-agent\\weixin" --auto-port 9420
   ```
5. **Dependencies.** In this folder, run `npm install`.

## Run

```bash
node reset.js
SHOTS=./shots node devmock.js
```

`reset.js` deletes the signed-in test account so a run starts from nothing. `SHOTS` saves a screenshot after every step and writes `results.json`. The exit code is 0 only when every step passes.

Environment variables:
- `FROM=n` starts at step n. Later steps can depend on earlier ones.
- `AUTO_PORT` changes the automation port from 9420.

## Gotchas

- Never call `restoreWxMethod` on a method that wasn't mocked. It deletes that `wx` API from the simulator until DevTools restarts, for example "wx.showModal not exists". Use `stub()`, which records what it mocked.
- `page.callMethod` doesn't work with this DevTools version. Act through elements, or use `mp.evaluate` with `getCurrentPages()`.
- Custom components can't be selected by tag name. The templates give them classes for this (`.goal-card`, `.approval-card`).
- `rich-text` has no `.text()`. Read the page data instead.
- After many runs, the simulator may refuse every file write with "the maximum size of the file storage limit is exceeded", even with little stored. Clear DevTools' file cache:
  `cli.bat cache --clean file --project <path to weixin>`
- `devmock.js` sends `#fail` to check refunds. devmock fails only when the latest user message contains it.
