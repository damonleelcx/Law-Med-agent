const api = require('../../utils/api')
const t = require('../../utils/i18n')
const { PACKS } = require('../../utils/config')
const app = getApp()

function stamp(iso) {
  const d = new Date(iso)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getMonth() + 1 + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

Page({
  data: { s: t(), packs: PACKS, enabled: true, loading: true, balance: 0, present: 0, ledger: [], buying: false },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    return app
      .refreshStamps()
      .then((r) => {
        this.setData({
          loading: false,
          enabled: !!r.enabled,
          balance: r.balance || 0,
          present: r.present_balance || 0,
          ledger: (r.ledger || []).map((e) => ({
            key: e.order_id,
            refunded: e.status === 'refunded',
            amount: e.amount,
            when: stamp(e.created_at),
          })),
        })
      })
      .catch((e) => {
        this.setData({ loading: false })
        wx.showToast({ icon: 'none', title: e.message || this.data.s.error })
      })
  },

  // Buying: the server signs the order with the CURRENT session_key, so make
  // sure WeChat's session is live first; then WeChat runs the payment sheet.
  buy(e) {
    const qty = Number(e.currentTarget.dataset.qty)
    const s = this.data.s
    if (this.data.buying) return
    this.setData({ buying: true })
    api
      .ensureSession()
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
        wx.showToast({ icon: 'success', title: s.bought })
        // WeChat credits the coins asynchronously; read the balance shortly after.
        setTimeout(() => this.load(), 1200)
      })
      .catch((err) => {
        // errCode -2 is the user closing the sheet: no need to shout.
        if (err && err.errCode !== -2) wx.showToast({ icon: 'none', title: (err && (err.errMsg || err.message)) || s.payFailed })
      })
      .then(() => this.setData({ buying: false }))
  },
})
