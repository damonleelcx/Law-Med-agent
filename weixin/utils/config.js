// The ACT server. It must be listed under 开发管理 → 服务器域名 → request合法域名
// in the mini program console (HTTPS only).
//
// Inside WeChat DevTools' simulator the app talks to a server on this machine
// instead (scripts/wx-dev.ps1 starts one). Real phones, including preview and
// trial builds, always use production.
const PROD = 'https://act.heros-agent.space'
const LOCAL = 'http://127.0.0.1:8080'

function inDevTools() {
  try {
    return (wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()).platform === 'devtools'
  } catch (e) {
    return false
  }
}

module.exports = {
  API_BASE: inDevTools() ? LOCAL : PROD,
  // Stamp packs offered on the Stamps page. The price of one stamp is the coin
  // price set in the WeChat virtual payment console; WeChat shows the total.
  PACKS: [10, 30, 100, 300],
}
