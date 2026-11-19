// page(def) is Page(def) plus what every screen shares:
//   data.s         the Chinese strings (template-safe)
//   data.signedIn  whether a WeChat session exists
//   data.ui        theme / font-size / motion classes for the root view
//   onLive()       if defined, called when the server says something changed
//   requireLogin() resolves once signed in, asking with the login sheet
//                  (<login-sheet id="login" bind:login="onLogin" /> on the page)
//   onSignedIn()   if defined, called after the person signs in on this page
const api = require('./api')
const live = require('./live')
const ui = require('./ui')
const S = require('./strings')

module.exports = function page(def) {
  const own = { onShow: def.onShow, onHide: def.onHide, onUnload: def.onUnload }
  def.data = Object.assign({ s: S.view, signedIn: false, ui: '' }, def.data || {})

  def.onShow = function () {
    this.setData({ signedIn: api.loggedIn(), ui: ui.cls() })
    ui.chrome()
    if (this.onLive && !this._off) {
      this._off = live.on(() => {
        if (api.loggedIn()) this.onLive()
      })
    }
    if (own.onShow) own.onShow.call(this)
  }
  const off = function () {
    if (this._off) this._off()
    this._off = null
  }
  def.onHide = function () {
    off.call(this)
    if (own.onHide) own.onHide.call(this)
  }
  def.onUnload = function () {
    off.call(this)
    if (own.onUnload) own.onUnload.call(this)
  }

  def.requireLogin = function () {
    if (api.loggedIn()) return Promise.resolve()
    return this.selectComponent('#login').require()
  }
  // The login sheet fires this after a successful sign-in.
  def.onLogin = function () {
    this.setData({ signedIn: true })
    getApp().onSignedIn()
    if (this.onSignedIn) this.onSignedIn()
  }
  // Re-apply appearance after Settings changed it.
  def.refreshUI = function () {
    this.setData({ ui: ui.cls() })
    ui.chrome()
  }

  Page(def)
}
