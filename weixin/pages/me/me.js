const api = require('../../utils/api')
const fmt = require('../../utils/fmt')
const S = require('../../utils/strings')
const page = require('../../utils/page')
const app = getApp()

// 我的: who you are, your stamps and approvals, and every settings section the
// web app has (Settings tabs become rows).
// Signed out, a short list; tapping any row asks to sign in first.
const OUT_TABS = ['profile', 'prefs', 'privacy', 'look'].map((k) => ({ key: k, label: S.settings.tabs[k] }))

page({
  data: { me: null, balance: null, stampsEnabled: true, pending: 0, tabs: OUT_TABS },

  onShow() {
    if (api.loggedIn()) this.load()
  },
  onLive() {
    this.load()
  },
  onSignedIn() {
    this.load()
  },

  load() {
    app
      .loadPrefs()
      .then((d) => {
        if (!d) return
        const u = d.user
        const tabs = ['profile', 'prefs', 'notify', 'privacy', 'security', 'limits', 'pro', 'look']
        if (u.admin) tabs.push('admin')
        this.setData({
          me: {
            name: u.name || S.me.wechatUser,
            initial: (u.name || '维').slice(0, 1),
            role: S.settings.roles[u.role] || u.role,
            licensed: !!u.licensed,
            joined: fmt.time(u.created_at, true),
          },
          tabs: tabs.map((k) => ({ key: k, label: S.settings.tabs[k] })),
        })
        this.refreshUI()
      })
    app
      .refreshStamps()
      .then((r) => this.setData({ balance: r.balance, stampsEnabled: r.enabled !== false }))
      .catch(() => {})
    app.refreshPending().then((n) => this.setData({ pending: n }))
  },

  stamps() {
    wx.navigateTo({ url: '/pages/stamps/stamps' })
  },
  approvals() {
    this.requireLogin()
      .then(() => wx.navigateTo({ url: '/pages/approvals/approvals' }))
      .catch(() => {})
  },
  settings(e) {
    const tab = e.currentTarget.dataset.tab
    this.requireLogin()
      .then(() => wx.navigateTo({ url: '/pages/settings/settings?tab=' + tab }))
      .catch(() => {})
  },
  signIn() {
    this.requireLogin().catch(() => {})
  },
  signOut() {
    wx.showModal({
      title: S.me.signOut,
      content: S.me.confirmSignOut,
      confirmText: S.me.signOut,
      confirmColor: '#D8483B',
      success: (r) => {
        if (!r.confirm) return
        app.signOut().then(() => {
          this.setData({ signedIn: false, me: null, balance: null, pending: 0, tabs: OUT_TABS })
          this.refreshUI()
        })
      },
    })
  },
})
