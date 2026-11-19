const api = require('../../utils/api')
const t = require('../../utils/i18n')
const app = getApp()

// Light cleanup of Vera's Markdown for a plain <text>: keep the words, drop the
// syntax a chat bubble cannot render.
function plain(md) {
  return (md || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
}

function newClientId() {
  return 'wx' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

Page({
  data: { s: t(), id: '', messages: [], input: '', sending: false, balance: null, stampsEnabled: true, bottom: '' },

  onLoad(q) {
    this.setData({ id: q.id })
    this.load()
  },

  onShow() {
    app
      .refreshStamps()
      .then(() => this.setData({ balance: app.globalData.balance, stampsEnabled: app.globalData.stampsEnabled }))
      .catch(() => {})
  },

  load() {
    return api.get('/api/conversations/' + this.data.id + '/messages').then((list) => {
      const messages = list
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'event')
        .map((m) => ({ key: 'm' + m.id, role: m.role, content: m.role === 'assistant' ? plain(m.content) : m.content }))
      this.setData({ messages })
      this.scrollDown()
    })
  },

  scrollDown() {
    this.setData({ bottom: '' }, () => this.setData({ bottom: 'end' }))
  },

  onInput(e) {
    this.setData({ input: e.detail.value })
  },

  send() {
    const text = this.data.input.trim()
    if (!text || this.data.sending) return
    this.setData({ input: '' })
    this.deliver(text, newClientId())
  },

  // Tapping the red "!" on a failed message sends it again with the same
  // client id: the server neither stores nor charges it twice.
  retry(e) {
    const m = this.data.messages[e.currentTarget.dataset.i]
    if (!m || !m.failed || this.data.sending) return
    const rest = this.data.messages.filter((x) => x.key !== m.key)
    this.setData({ messages: rest })
    this.deliver(m.content, m.cid)
  },

  deliver(text, cid) {
    const s = this.data.s
    const messages = this.data.messages.concat([
      { key: 'u' + cid, cid, role: 'user', content: text },
      { key: 'a' + cid, role: 'assistant', content: '', pending: true },
    ])
    const ai = messages.length - 1
    const ui = messages.length - 2
    this.setData({ messages, sending: true })
    this.scrollDown()

    // Coalesce deltas: one setData per ~60ms, not per token.
    let reply = ''
    let timer = null
    const flush = () => {
      timer = null
      this.setData({ ['messages[' + ai + '].content']: plain(reply) })
      this.scrollDown()
    }

    api
      .stream('/api/conversations/' + this.data.id + '/messages', { content: text, client_msg_id: cid }, (ev, data) => {
        if (ev === 'delta') {
          reply += data.t || ''
          if (!timer) timer = setTimeout(flush, 60)
        } else if (ev === 'stamps') {
          if (typeof data.balance === 'number' && !data.already) this.setBalance(data.balance)
          else if (data.refunded && this.data.balance !== null) this.setBalance(this.data.balance + data.refunded)
        } else if (ev === 'error') {
          reply = reply || data.error || s.error
        }
      })
      .then(() => {
        if (timer) clearTimeout(timer)
        flush()
        this.setData({ ['messages[' + ai + '].pending']: false, sending: false })
        // Pick up anything the turn added besides the reply (case cards, events).
        this.load().catch(() => {})
      })
      .catch((e) => {
        if (timer) clearTimeout(timer)
        const msgs = this.data.messages.slice(0, ai)
        msgs[ui] = Object.assign({}, msgs[ui], { failed: true })
        this.setData({ messages: msgs, sending: false })
        if (e.status === 402) {
          this.setBalance(e.data.balance || 0)
          wx.showModal({
            title: s.outTitle,
            content: s.outBody,
            confirmText: s.buyMore,
            cancelText: s.later,
            confirmColor: '#07C160',
            success: (r) => r.confirm && wx.switchTab({ url: '/pages/stamps/stamps' }),
          })
        } else {
          wx.showToast({ icon: 'none', title: e.message || s.error })
        }
      })
  },

  setBalance(n) {
    app.globalData.balance = n
    this.setData({ balance: n })
  },

  stamps() {
    wx.switchTab({ url: '/pages/stamps/stamps' })
  },
})
