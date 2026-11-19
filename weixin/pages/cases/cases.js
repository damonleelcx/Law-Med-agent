const api = require('../../utils/api')
const fmt = require('../../utils/fmt')
const S = require('../../utils/strings')
const page = require('../../utils/page')

// The web app's Cases: one tile per case, live.
page({
  data: { goals: null },

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
    return api
      .get('/api/goals')
      .then((gs) =>
        this.setData({
          goals: gs.map((g) => {
            const p = g.progress || { done: 0, total: 0 }
            return {
              id: g.id,
              title: g.title,
              domain: g.domain,
              domainLabel: S.goal.domain[g.domain] || '',
              status: g.status,
              statusLabel: S.goal.status[g.status] || g.status,
              attention: g.status === 'needs_attention' ? g.attention_reason : '',
              pct: p.total ? Math.round((p.done / p.total) * 100) : 0,
              progress: S.progress(p.done, p.total),
              when: fmt.time(g.updated_at, true),
            }
          }),
        })
      )
      .catch((e) => {
        if (e.needLogin) this.setData({ signedIn: false })
        this.setData({ goals: [] })
      })
  },

  open(e) {
    wx.navigateTo({ url: '/pages/case/case?id=' + e.currentTarget.dataset.id })
  },

  signIn() {
    this.requireLogin().catch(() => {})
  },
})
