const api = require('../../utils/api')
const fmt = require('../../utils/fmt')
const S = require('../../utils/strings')
const { PACKS } = require('../../utils/config')
const page = require('../../utils/page')
const app = getApp()

// Stamps: the balance WeChat holds, packs to buy with virtual payment, and
// recent use. Packs and pricing are visible signed out; buying asks to sign in.
page({
  data: { packs: PACKS, enabled: true, balance: null, ledger: [], buying: false },

  onShow() {
    this.load()
  },
  onSignedIn() {
    this.load()
  },
  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    if (!api.loggedIn()) return Promise.resolve()
    return app
      .refreshStamps()
      .then((r) => {
        this.setData({
          enabled: !!r.enabled,
          balance: r.enabled ? r.balance || 0 : null,
          ledger: (r.ledger || []).map((e) => ({
            key: e.order_id,
            refunded: e.status === 'refunded',
            amount: e.amount,
            when: fmt.time(e.created_at, true),
          })),
        })
      })
      .catch(() => wx.showToast({ icon: 'none', title: S.error }))
  },

  signIn() {
    this.requireLogin().catch(() => {})
  },

  // Buying asks for sign-in first, then makes sure WeChat's session is live
  // (the server signs the order with the current session_key), then WeChat
  // runs the payment sheet.
  buy(e) {
    const qty = Number(e.currentTarget.dataset.qty)
    if (this.data.buying) return
    this.requireLogin()
      .then(() => {
        this.setData({ buying: true })
        return api.ensureSession()
      })
      .then(() => api.post('/api/wx/stamps/order', { quantity: qty }))
      .then(
        (order) =>
          new Promise((resolve, reject) => {
            wx.requestVirtualPayment({
              signData: order.signData,
              paySig: order.paySig,
              signature: order.signature,
              mode: order.mode,
              success: resolve,
              fail: reject,
            })
          })
      )
      .then(() => {
        wx.showToast({ icon: 'success', title: S.bought })
        // WeChat credits the coins asynchronously; read the balance shortly after.
        setTimeout(() => this.load(), 1200)
      })
      .catch((err) => {
        if (!err || err.cancelled || err.errCode === -2) return // closed the sheet or the payment
        if (err.status === 404) return wx.showToast({ icon: 'none', title: S.payOff })
        wx.showToast({ icon: 'none', title: err.errMsg || S.payFailed })
      })
      .then(() => this.setData({ buying: false }))
  },
})
