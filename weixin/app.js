const api = require('./utils/api')
const live = require('./utils/live')

// Nothing signs in at launch: every page can be browsed first, and the login
// sheet appears only when an action needs an account.
App({
  globalData: { balance: null, stampsEnabled: true, prefs: {}, pending: 0 },

  onShow() {
    if (api.loggedIn()) {
      live.start()
      this.loadPrefs()
    }
  },

  onHide() {
    live.stop()
  },

  // After a sign-in on any page: start live updates and load preferences.
  onSignedIn() {
    live.restart()
    this.loadPrefs()
  },

  signOut() {
    return api
      .post('/api/auth/signout')
      .catch(() => {})
      .then(() => {
        live.stop()
        api.logout()
        this.globalData.prefs = {}
        this.globalData.balance = null
        this.setPending(0)
      })
  },

  // Preferences (appearance included) live on the server, as on the web.
  loadPrefs() {
    return api
      .get('/api/settings')
      .then((d) => {
        this.globalData.prefs = d.preferences || {}
        this.globalData.settings = d
        return d
      })
      .catch(() => null)
  },

  // refreshStamps reads the live balance (WeChat holds it). Signed out, there
  // is nothing to read.
  refreshStamps() {
    if (!api.loggedIn()) {
      this.globalData.balance = null
      return Promise.resolve({ enabled: true, balance: null, signedOut: true })
    }
    return api.get('/api/wx/stamps').then((r) => {
      this.globalData.stampsEnabled = !!r.enabled
      this.globalData.balance = r.enabled ? r.balance : null
      return r
    })
  },

  // Pending approvals this person can decide, as a badge on 我的.
  refreshPending() {
    if (!api.loggedIn()) return Promise.resolve(0)
    return api
      .get('/api/approvals')
      .then((a) => {
        const n = a.filter((x) => x.status === 'pending' && x.can_decide).length
        this.setPending(n)
        return n
      })
      .catch(() => this.globalData.pending)
  },

  setPending(n) {
    this.globalData.pending = n
    const done = () => {}
    if (n > 0) wx.setTabBarBadge({ index: 3, text: String(n), fail: done })
    else wx.removeTabBarBadge({ index: 3, fail: done })
  },
})
