const api = require('../../utils/api')
const fmt = require('../../utils/fmt')
const S = require('../../utils/strings')
const { md } = require('../../utils/md')
const page = require('../../utils/page')

const icon = { succeeded: 'done', skipped: 'done', failed: 'fail', cancelled: 'fail', waiting_approval: 'wait', leased: 'run', ready: 'next' }
const glyph = { done: '✓', fail: '✕', wait: '!', next: '' }

// The web app's CaseView: what happened, why, when, and what happens next —
// straight from the persisted timeline.
page({
  data: { id: '', g: null, tab: 'plan', tasks: [], events: [], summaries: [], next: [], reminders: [], docs: [], approvals: [], open: {}, err: '' },

  onLoad(q) {
    this.setData({ id: q.id })
  },
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
    const id = this.data.id
    api
      .get('/api/goals/' + id)
      .then((g) => {
        const live = g.status === 'active' || g.status === 'planning'
        wx.setNavigationBarTitle({ title: g.title.slice(0, 16) })
        this.setData({
          err: '',
          g: {
            title: g.title,
            meta: (S.goal.domain[g.domain] || '') + ' · ' + fmt.time(g.created_at, true),
            status: g.status,
            statusLabel: S.goal.status[g.status] || g.status,
            attention: g.status === 'needs_attention' ? g.attention_reason || '' : '',
            needsAttention: g.status === 'needs_attention',
            conversation: g.conversation_id || '',
            canPause: live,
            canResume: g.status === 'paused' || g.status === 'needs_attention',
            canCancel: g.status !== 'completed' && g.status !== 'cancelled',
            criteria: g.criteria || [],
            steps: (g.usage && g.usage.iterations) || 0,
            tools: (g.usage && g.usage.tool_calls) || 0,
            cost: '$' + ((g.usage && g.usage.cost_usd) || 0).toFixed(2) + ' / $' + ((g.limits && g.limits.max_cost_usd) || 0),
          },
          tasks: fmt.workTasks(g.tasks).map((x) => {
            const k = icon[x.status] || 'idle'
            const p = fmt.plain(x.summary)
            return {
              id: x.id,
              title: x.title,
              status: x.status,
              icon: k,
              glyph: glyph[k] || '',
              label: S.goal.task[x.status] || '',
              activity: fmt.activity(x),
              short: x.summary ? p.slice(0, 160) + (p.length > 160 ? '…' : '') : '',
              html: x.summary ? md(x.summary) : '',
              error: x.error && x.status !== 'succeeded' ? x.error : '',
              wait: x.kind === 'wait' && x.status === 'ready' ? '⏰ ' + fmt.time(x.run_after, true) : '',
            }
          }),
          docs: (g.documents || []).map((d) => ({ id: d.id, title: d.title, sub: d.kind + ' · v' + d.version })),
          approvals: (g.approvals || []).filter((a) => a.status === 'pending'),
        })
      })
      .catch((e) => this.setData({ err: e.needLogin ? '' : e.message || S.error }))
    api
      .get('/api/goals/' + id + '/timeline')
      .then((tl) =>
        this.setData({
          summaries: (tl.summaries || []).map((x) => ({ key: x.upto_event_id, text: x.summary })),
          events: (tl.events || []).slice().reverse().map(fmt.event),
          next: (tl.next || []).map((n, i) => ({ key: i, title: n.title, icon: icon[n.status] || 'idle', glyph: glyph[icon[n.status]] || '' })),
          reminders: (tl.reminders || []).map((r, i) => ({ key: i, at: fmt.time(r.due_at, true), text: r.text })),
        })
      )
      .catch(() => {})
  },

  setTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  toggle(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ ['open.' + id]: !this.data.open[id] })
  },

  chat() {
    wx.navigateTo({ url: '/pages/chat/chat?id=' + this.data.g.conversation })
  },

  pause() {
    this.act('pause')
  },
  resume() {
    this.act('resume')
  },
  cancel() {
    wx.showModal({
      title: S.goal.cancel,
      content: S.goal.confirmCancel,
      confirmText: S.goal.cancel,
      confirmColor: '#D8483B',
      success: (r) => r.confirm && this.act('cancel'),
    })
  },

  act(a) {
    api
      .post('/api/goals/' + this.data.id + '/' + a)
      .then(() => this.load())
      .catch((e) => wx.showToast({ icon: 'none', title: e.message || S.error }))
  },

  openDoc(e) {
    wx.navigateTo({ url: '/pages/doc/doc?id=' + e.currentTarget.dataset.id })
  },

  onApprovalDone() {
    this.load()
  },

  signIn() {
    this.requireLogin().catch(() => {})
  },
})
