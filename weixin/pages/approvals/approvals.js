const api = require('../../utils/api')
const page = require('../../utils/page')
const app = getApp()

// The web app's Approvals: your own, and — for a verified licensed
// professional — the review queue.
page({
  data: { own: [], queue: [], loaded: false, licensed: false },

  onShow() {
    if (api.loggedIn()) this.load()
  },
  onLive() {
    this.load()
  },
  onSignedIn() {
    this.load()
  },
  onPullDownRefresh() {
    ;(api.loggedIn() ? this.load() : Promise.resolve()).then(() => wx.stopPullDownRefresh())
  },

  load() {
    // The latest settings carry the live licence state; the login copy may be older.
    const user = (app.globalData.settings && app.globalData.settings.user) || api.user() || {}
    return api
      .get('/api/approvals')
      .then((items) => {
        this.setData({ loaded: true, licensed: !!user.licensed, own: items.filter((a) => a.own), queue: items.filter((a) => !a.own) })
        app.setPending(items.filter((x) => x.status === 'pending' && x.can_decide).length)
      })
      .catch(() => this.setData({ loaded: true }))
  },

  onDone() {
    this.load()
  },

  signIn() {
    this.requireLogin().catch(() => {})
  },
})
