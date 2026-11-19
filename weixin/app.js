const api = require('./utils/api')
const t = require('./utils/i18n')

App({
  globalData: { balance: null, stampsEnabled: true },

  onLaunch() {
    // Sign in up front (silently, with wx.login) so the first screen is ready.
    api.ensureSession().catch(() => {})
    const s = t()
    wx.setTabBarItem({ index: 0, text: s.chats })
    wx.setTabBarItem({ index: 1, text: s.stamps })
  },

  // refreshStamps reads the live balance (WeChat holds it) for every page.
  refreshStamps() {
    return api.get('/api/wx/stamps').then((r) => {
      this.globalData.stampsEnabled = !!r.enabled
      this.globalData.balance = r.enabled ? r.balance : null
      return r
    })
  },
})
