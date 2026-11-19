const api = require('../../utils/api')
const S = require('../../utils/strings')
const { md } = require('../../utils/md')
const page = require('../../utils/page')
const app = getApp()

function newClientId() {
  return 'wx' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// One row of the thread, shaped like the web app's Bubble: Vera's rows carry
// her face (mood), name, emergency tag and rendered Markdown.
function row(m) {
  const meta = m.meta || {}
  if (m.role === 'user') return { key: 'm' + m.id, role: 'user', content: m.content, goals: [] }
  return {
    key: 'm' + m.id,
    role: 'vera',
    content: m.content,
    html: md(m.content),
    emergency: meta.intent === 'med.emergency',
    update: m.role === 'event' || meta.kind === 'update' || meta.kind === 'reminder' || meta.kind === 'complete',
    complete: meta.kind === 'complete',
    openedGoal: meta.kind === 'goal_created' ? meta.goal_id : '',
    goals: [],
  }
}

page({
  data: { id: '', messages: [], tail: [], approvals: [], input: '', sending: false, mood: 'smile', balance: null, stampsEnabled: true, bottom: '', upload: '' },

  onLoad(q) {
    if (q.id) this.setData({ id: q.id })
  },

  onShow() {
    if (this.data.id && api.loggedIn() && !this.data.sending) this.load().catch(() => {})
    this.refreshStamps()
  },

  // The server says something changed (a step finished, an approval came in).
  onLive() {
    if (this.data.id && !this.data.sending) this.load().catch(() => {})
  },

  onSignedIn() {
    this.refreshStamps()
  },

  refreshStamps() {
    app
      .refreshStamps()
      .then((r) => this.setData({ balance: r.balance, stampsEnabled: r.enabled !== false }))
      .catch(() => {})
  },

  // Messages, the cases this conversation opened (with their live plans) and
  // the approvals those cases are waiting on.
  load() {
    const id = this.data.id
    return Promise.all([
      api.get('/api/conversations/' + id + '/messages'),
      api.get('/api/goals').catch(() => []),
      api.get('/api/approvals').catch(() => []),
    ]).then(([list, goals, approvals]) => {
      const mine = goals.filter((g) => g.conversation_id === id)
      return Promise.all(mine.slice(0, 6).map((g) => api.get('/api/goals/' + g.id).catch(() => g))).then((detailed) => {
        if (this.data.sending) return
        const messages = list.map(row)
        // Cases appear after the message that opened them.
        const placed = new Set()
        messages.forEach((m) => {
          if (!m.openedGoal) return
          m.goals = detailed.filter((g) => g.id === m.openedGoal)
          m.goals.forEach((g) => placed.add(g.id))
        })
        const ids = new Set(mine.map((g) => g.id))
        const lastVera = [...messages].reverse().find((m) => m.role === 'vera')
        this.setData({
          messages,
          tail: detailed.filter((g) => !placed.has(g.id)),
          approvals: approvals.filter((a) => ids.has(a.goal_id) && a.status === 'pending'),
          mood: lastVera && lastVera.complete ? 'laugh' : 'smile',
        })
        this.scrollDown()
      })
    })
  },

  scrollDown() {
    this.setData({ bottom: '' }, () => this.setData({ bottom: 'end' }))
  },

  onInput(e) {
    this.setData({ input: e.detail.value })
  },

  sendInput() {
    this.send(this.data.input)
  },

  suggest(e) {
    this.send(e.currentTarget.dataset.text)
  },

  ensureConversation() {
    if (this.data.id) return Promise.resolve(this.data.id)
    return api.post('/api/conversations').then((r) => {
      this.setData({ id: r.id })
      return r.id
    })
  },

  // Sending is the moment sign-in is asked for. A first message also creates
  // the conversation.
  send(text) {
    const body = (text || '').trim()
    if (!body || this.data.sending) return
    this.requireLogin()
      .then(() => this.ensureConversation())
      .then(() => {
        this.setData({ input: '' })
        this.deliver(body, newClientId())
      })
      .catch((e) => {
        if (!e.cancelled) wx.showToast({ icon: 'none', title: S.error })
      })
  },

  // Attach: a file from a WeChat chat, or a photo. It joins the person's
  // file, and the message box says so, as on the web.
  attach() {
    this.requireLogin()
      .then(
        () =>
          new Promise((resolve, reject) => {
            wx.showActionSheet({ itemList: S.attachFrom, success: (r) => resolve(r.tapIndex), fail: () => reject({ cancelled: true }) })
          })
      )
      .then((i) => (i === 0 ? pickMessageFile() : pickImage()))
      .then((f) => {
        this.setData({ upload: S.uploading })
        return api.upload(f.path, f.name)
      })
      .then((r) => {
        const name = r.title || ''
        this.setData({ upload: S.uploaded + name, input: (this.data.input ? this.data.input + '\n' : '') + S.uploadedSay(name) })
        setTimeout(() => this.setData({ upload: '' }), 5000)
      })
      .catch((e) => {
        if (e && e.cancelled) return
        this.setData({ upload: '' })
        wx.showToast({ icon: 'none', title: (e && e.message) || S.error })
      })
  },

  // Tapping the "!" on a failed message sends it again with the same client
  // id: the server neither stores nor charges it twice.
  retry(e) {
    const m = this.data.messages[e.currentTarget.dataset.i]
    if (!m || !m.failed || this.data.sending) return
    this.setData({ messages: this.data.messages.filter((x) => x.key !== m.key) })
    this.deliver(m.content, m.cid)
  },

  copy(e) {
    const m = this.data.messages[e.currentTarget.dataset.i]
    if (m) wx.setClipboardData({ data: m.content, success: () => wx.showToast({ icon: 'none', title: S.copied }) })
  },

  onApprovalDone() {
    this.load().catch(() => {})
  },

  deliver(text, cid) {
    const messages = this.data.messages.concat([
      { key: 'u' + cid, cid, role: 'user', content: text, goals: [] },
      { key: 'a' + cid, role: 'vera', content: '', html: '', pending: true, goals: [] },
    ])
    const ai = messages.length - 1
    const ui = messages.length - 2
    this.setData({ messages, sending: true, mood: 'think' })
    this.scrollDown()

    // Coalesce deltas: one setData per ~60ms, not per token.
    let reply = ''
    let timer = null
    const flush = () => {
      timer = null
      this.setData({ ['messages[' + ai + '].content']: reply, ['messages[' + ai + '].html']: md(reply) })
      this.scrollDown()
    }

    api
      .stream('/api/conversations/' + this.data.id + '/messages', { content: text, client_msg_id: cid }, (ev, data) => {
        if (ev === 'delta') {
          reply += data.t || ''
          if (!timer) timer = setTimeout(flush, 60)
        } else if (ev === 'meta') {
          if (data.intent === 'med.emergency') this.setData({ ['messages[' + ai + '].emergency']: true })
        } else if (ev === 'stamps') {
          if (typeof data.balance === 'number' && !data.already) this.setBalance(data.balance)
          else if (data.refunded && this.data.balance !== null) this.setBalance(this.data.balance + data.refunded)
        } else if (ev === 'error') {
          reply = reply || data.error || S.error
        }
      })
      .then(() => {
        if (timer) clearTimeout(timer)
        flush()
        this.setData({ ['messages[' + ai + '].pending']: false, sending: false, mood: 'smile' })
        // The server now has the authoritative copy, and any case it opened.
        setTimeout(() => this.load().catch(() => {}), 300)
      })
      .catch((e) => {
        if (timer) clearTimeout(timer)
        const msgs = this.data.messages.slice(0, ai)
        msgs[ui] = Object.assign({}, msgs[ui], { failed: true })
        this.setData({ messages: msgs, sending: false, mood: 'smile' })
        if (e.status === 402) {
          this.setBalance(e.data.balance || 0)
          wx.showModal({
            title: S.outTitle,
            content: S.outBody,
            confirmText: S.buyMore,
            cancelText: S.later,
            confirmColor: '#E8662A',
            success: (r) => r.confirm && wx.navigateTo({ url: '/pages/stamps/stamps' }),
          })
        } else {
          wx.showToast({ icon: 'none', title: S.error })
        }
      })
  },

  setBalance(n) {
    app.globalData.balance = n
    this.setData({ balance: n })
  },

  stamps() {
    wx.navigateTo({ url: '/pages/stamps/stamps' })
  },
})

const ACCEPT = ['pdf', 'docx', 'txt', 'md', 'csv', 'eml', 'png', 'jpg', 'jpeg', 'webp', 'gif']

function pickMessageFile() {
  return new Promise((resolve, reject) => {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ACCEPT,
      success: (r) => resolve({ path: r.tempFiles[0].path, name: r.tempFiles[0].name }),
      fail: () => reject({ cancelled: true }),
    })
  })
}

function pickImage() {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (r) => {
        const p = r.tempFiles[0].tempFilePath
        const ext = (p.split('.').pop() || 'jpg').toLowerCase()
        resolve({ path: p, name: '图片_' + new Date().toISOString().slice(0, 10) + '.' + ext })
      },
      fail: () => reject({ cancelled: true }),
    })
  })
}
