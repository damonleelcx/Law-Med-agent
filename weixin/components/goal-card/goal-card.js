// The web app's GoalCard: an inline card for a case opened from the
// conversation. It follows the plan live: steps tick over as workers finish.
const S = require('../../utils/strings')
const fmt = require('../../utils/fmt')

const icon = { succeeded: 'done', skipped: 'done', failed: 'fail', cancelled: 'fail', waiting_approval: 'wait', leased: 'run', ready: 'next' }
const glyph = { done: '✓', fail: '✕', wait: '!', next: '' }

Component({
  properties: { goal: { type: Object, value: null } },
  data: { s: S.view, v: null },
  observers: {
    goal(g) {
      if (!g) return this.setData({ v: null })
      const p = fmt.progress(g.tasks)
      this.setData({
        v: {
          id: g.id,
          title: g.title,
          domain: g.domain,
          domainLabel: S.goal.domain[g.domain] || '',
          status: g.status,
          statusLabel: S.goal.status[g.status] || g.status,
          attention: g.status === 'needs_attention' ? g.attention_reason : '',
          pct: p.pct,
          progress: S.progress(p.done, p.total),
          steps: fmt.workTasks(g.tasks).map((x) => {
            const k = icon[x.status] || 'idle'
            return {
              id: x.id,
              title: x.title,
              status: x.status,
              icon: k,
              glyph: glyph[k] || '',
              label: x.status !== 'blocked' && x.status !== 'succeeded' ? S.goal.task[x.status] || '' : '',
              activity: fmt.activity(x),
            }
          }),
        },
      })
    },
  },
  methods: {
    open() {
      if (this.data.v) wx.navigateTo({ url: '/pages/case/case?id=' + this.data.v.id })
    },
  },
})
