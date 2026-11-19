const api = require('../../utils/api')
const fmt = require('../../utils/fmt')
const S = require('../../utils/strings')
const page = require('../../utils/page')
const app = getApp()

page({
  data: { list: [], all: [], q: '', archived: false, loading: false, balance: null, stampsEnabled: true, pending: 0 },

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
    this.setData({ loading: true })
    app
      .refreshStamps()
      .then((r) => this.setData({ balance: r.balance, stampsEnabled: r.enabled !== false }))
      .catch(() => {})
    app.refreshPending().then((n) => this.setData({ pending: n }))
    return api
      .get('/api/conversations' + (this.data.archived ? '?archived=1' : ''))
      .then((list) => {
        const all = list.map((c) => ({
          id: c.id,
          title: c.title || (c.last ? fmt.plain(c.last).slice(0, 40) : S.untitled),
          rawTitle: c.title || '',
          last: fmt.plain(c.last || ''),
          when: fmt.time(c.updated_at),
        }))
        this.setData({ all, loading: false })
        this.filter()
      })
      .catch((e) => {
        this.setData({ loading: false })
        if (e.needLogin) this.setData({ signedIn: false })
        else wx.showToast({ icon: 'none', title: S.error })
      })
  },

  onSearch(e) {
    this.setData({ q: e.detail.value })
    this.filter()
  },

  filter() {
    const q = this.data.q.trim().toLowerCase()
    this.setData({ list: q ? this.data.all.filter((c) => (c.title + ' ' + c.last).toLowerCase().indexOf(q) >= 0) : this.data.all })
  },

  toggleArchived() {
    this.setData({ archived: !this.data.archived, q: '' })
    this.load()
  },

  // Browsing never needs an account: a new conversation opens straight away,
  // and sign-in is asked for when the first message is sent.
  create() {
    wx.navigateTo({ url: '/pages/chat/chat' })
  },

  open(e) {
    wx.navigateTo({ url: '/pages/chat/chat?id=' + e.currentTarget.dataset.id })
  },

  // Long press: rename, archive / restore, delete (the web app's actions).
  more(e) {
    const c = this.data.list[e.currentTarget.dataset.i]
    if (!c) return
    const items = [S.rename, this.data.archived ? S.unarchive : S.archive, S.del]
    wx.showActionSheet({
      itemList: items,
      success: (r) => {
        if (r.tapIndex === 0) this.rename(c)
        else if (r.tapIndex === 1) this.patch(c.id, { archived: !this.data.archived })
        else this.remove(c)
      },
    })
  },

  rename(c) {
    wx.showModal({
      title: S.rename,
      editable: true,
      placeholderText: S.untitled,
      content: c.rawTitle,
      confirmColor: '#E8662A',
      success: (r) => {
        if (r.confirm) this.patch(c.id, { title: (r.content || '').trim() })
      },
    })
  },

  patch(id, body) {
    api
      .patch('/api/conversations/' + id, body)
      .then(() => this.load())
      .catch(() => wx.showToast({ icon: 'none', title: S.error }))
  },

  remove(c) {
    wx.showModal({
      title: S.del,
      content: S.confirmDelete,
      confirmText: S.del,
      confirmColor: '#D8483B',
      success: (r) => {
        if (r.confirm)
          api
            .del('/api/conversations/' + c.id)
            .then(() => this.load())
            .catch(() => wx.showToast({ icon: 'none', title: S.error }))
      },
    })
  },

  signIn() {
    this.requireLogin().catch(() => {})
  },

  approvals() {
    wx.navigateTo({ url: '/pages/approvals/approvals' })
  },

  stamps() {
    wx.navigateTo({ url: '/pages/stamps/stamps' })
  },
})
