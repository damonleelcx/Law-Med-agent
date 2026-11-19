// The ACT server. It must be listed under 开发管理 → 服务器域名 → request合法域名
// in the mini program console (HTTPS only).
module.exports = {
  API_BASE: 'https://act.heros-agent.space',
  // Stamp packs offered on the Stamps page. The price of one stamp is the coin
  // price set in the WeChat virtual payment console; WeChat shows the total.
  PACKS: [10, 30, 100, 300],
}
