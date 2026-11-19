// The one place sign-in is asked for. A page calls
//   this.selectComponent('#login').require()
// before any action that needs an account. It resolves at once when the
// person is signed in; otherwise it opens this sheet and resolves after they
// choose WeChat login, or rejects ({cancelled: true}) if they choose not now.
const api = require('../../utils/api')
const S = require('../../utils/strings')
const s = S.view

Component({
  data: { s, show: false, busy: false },

  methods: {
    require() {
      if (api.loggedIn()) return Promise.resolve()
      if (this._pending) return this._pending.promise
      const p = {}
      p.promise = new Promise((resolve, reject) => {
        p.resolve = resolve
        p.reject = reject
      })
      this._pending = p
      this.setData({ show: true, busy: false })
      return p.promise
    },

    confirm() {
      if (this.data.busy) return
      this.setData({ busy: true })
      api
        .login()
        .then(() => {
          this.setData({ show: false, busy: false })
          const p = this._pending
          this._pending = null
          this.triggerEvent('login')
          if (p) p.resolve()
        })
        .catch(() => {
          this.setData({ busy: false })
          wx.showToast({ icon: 'none', title: S.loginFailed })
        })
    },

    cancel() {
      if (this.data.busy) return
      this.setData({ show: false })
      const p = this._pending
      this._pending = null
      if (p) p.reject(Object.assign(new Error('cancelled'), { cancelled: true }))
    },

    noop() {},
  },
})
