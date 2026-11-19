const api = require('../../utils/api')
const t = require('../../utils/i18n')
const app = getApp()

function when(iso) {
  const d = new Date(iso)
  const now = new Date()
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes())
  return d.getMonth() + 1 + '/' + d.getDate()
}

Page({
  data: { s: t(), list: [], loading: true, balance: null, stampsEnabled: true },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    app
      .refreshStamps()
      .then(() => this.setData({ balance: app.globalData.balance, stampsEnabled: app.globalData.stampsEnabled }))
      .catch(() => {})
    return api
      .get('/api/conversations')
      .then((list) => {
        const s = this.data.s
        this.setData({
          loading: false,
          list: list.map((c) => ({
            id: c.id,
            title: c.title || s.untitled,
            last: (c.last || '').replace(/\s+/g, ' '),
            when: when(c.updated_at),
          })),
        })
      })
      .catch((e) => {
        this.setData({ loading: false })
        wx.showToast({ icon: 'none', title: e.message || this.data.s.error })
      })
  },

  open(e) {
    wx.navigateTo({ url: '/pages/chat/chat?id=' + e.currentTarget.dataset.id })
  },

  create() {
    api
      .post('/api/conversations')
      .then((r) => wx.navigateTo({ url: '/pages/chat/chat?id=' + r.id }))
      .catch((e) => wx.showToast({ icon: 'none', title: e.message || this.data.s.error }))
  },

  stamps() {
    wx.switchTab({ url: '/pages/stamps/stamps' })
  },
})
