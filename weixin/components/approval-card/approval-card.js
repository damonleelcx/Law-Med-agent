// The web app's ApprovalCard: what Vera wants to send, file or order, shown
// in full, with 同意 / 拒绝. G2 actions need a verified licensed professional.
const api = require('../../utils/api')
const S = require('../../utils/strings')

Component({
  properties: { a: { type: Object, value: null } },
  data: { s: S.view, v: null, note: '', busy: false, err: '' },
  observers: {
    a(a) {
      if (!a) return this.setData({ v: null })
      const role = S.approval.roles[a.required_role] || a.required_role
      const client = a.client && !a.own ? S.approval.client + '：' + (a.client.name || a.client.email || '') : ''
      this.setData({
        v: {
          id: a.id,
          status: a.status,
          gate: a.gate,
          gateLabel: a.gate === 'G2' ? S.approval.g2(role) : S.approval.g1,
          tool: S.approval.tools[a.tool] || a.tool,
          sub: [a.goal_title, client].filter(Boolean).join(' · '),
          preview: a.preview,
          pending: a.status === 'pending',
          canDecide: !!a.can_decide,
          waiting: S.approval.waiting(role),
          result: (S.approval[a.status] || '') + (a.note ? ' — “' + a.note + '”' : ''),
        },
      })
    },
  },
  methods: {
    onNote(e) {
      this.setData({ note: e.detail.value })
    },
    approve() {
      this.decide(true)
    },
    decline() {
      this.decide(false)
    },
    decide(approve) {
      if (this.data.busy) return
      this.setData({ busy: true, err: '' })
      api
        .post('/api/approvals/' + this.data.v.id, { approve, note: this.data.note })
        .then(() => {
          this.setData({ busy: false, note: '' })
          this.triggerEvent('done')
        })
        .catch((e) => this.setData({ busy: false, err: e.message || S.error }))
    },
  },
})
