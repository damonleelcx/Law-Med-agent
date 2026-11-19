const api = require('../../utils/api')
const fmt = require('../../utils/fmt')
const S = require('../../utils/strings')
const page = require('../../utils/page')
const app = getApp()

const ZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London',
  'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC']

// The web app's Settings, one section per page (?tab=). Language is fixed to
// 简体中文 here; everything else is the same preference on the same server.
page({
  data: {
    tab: 'profile',
    loaded: false,
    user: null,
    p: {},
    name: '',
    jurisdiction: '',
    cost: '20',
    days: '30',
    zones: ZONES,
    zoneIndex: 0,
    memories: [],
    sessions: [],
    usage: null,
    licenses: [],
    lic: { kind: 0, number: '', jur: '' },
    adminRows: [],
    hasEmail: false,
    kindLabels: S.settings.kinds.map((k) => k[1]),
  },

  onLoad(q) {
    const tab = q.tab || 'profile'
    this.setData({ tab })
    wx.setNavigationBarTitle({ title: S.settings.tabs[tab] || S.settings.title })
  },

  onShow() {
    if (!api.loggedIn()) {
      this.requireLogin()
        .then(() => this.load())
        .catch(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/me/me' }) }))
      return
    }
    this.load()
  },

  apply(d) {
    const p = d.preferences || {}
    app.globalData.prefs = p
    app.globalData.settings = d
    const tz = p.timezone || 'Asia/Shanghai'
    const zones = ZONES.indexOf(tz) >= 0 ? ZONES : [tz].concat(ZONES)
    this.setData({
      loaded: true,
      user: {
        name: d.user.name,
        role: S.settings.roles[d.user.role] || d.user.role,
        licensed: !!d.user.licensed,
        admin: !!d.user.admin,
        joined: fmt.time(d.user.created_at, true),
        email: d.user.email || '',
      },
      hasEmail: !!d.user.email,
      p: {
        tone: p.tone || 'warm',
        verbosity: p.verbosity || 'balanced',
        notify_email: p.notify_email !== false,
        notify_approvals: p.notify_approvals !== false,
        memory_enabled: p.memory_enabled !== false,
        theme: p.theme || 'system',
        font_size: p.font_size || 'medium',
        reduce_motion: !!p.reduce_motion,
      },
      name: d.user.name,
      jurisdiction: p.jurisdiction || '',
      cost: String(p.goal_max_cost_usd != null ? p.goal_max_cost_usd : 20),
      days: String(p.goal_max_days != null ? p.goal_max_days : 30),
      zones,
      zoneIndex: Math.max(0, zones.indexOf(tz)),
      licenses: (d.licenses || []).map((l) => ({
        id: l.id,
        kind: l.kind === 'bar' ? S.settings.kinds[0][1] : S.settings.kinds[1][1],
        sub: l.number + ' · ' + l.jurisdiction,
        status: l.status,
        statusLabel: S.settings.lic[l.status],
      })),
    })
    this.refreshUI()
  },

  load() {
    api
      .get('/api/settings')
      .then((d) => this.apply(d))
      .catch(() => wx.showToast({ icon: 'none', title: S.error }))
    const t = this.data.tab
    if (t === 'privacy') this.loadMemories()
    if (t === 'security') this.loadSessions()
    if (t === 'limits') api.get('/api/account/usage').then((u) => this.setData({ usage: { today: u.tokens_today.toLocaleString(), month: u.tokens_month.toLocaleString() } })).catch(() => {})
    if (t === 'admin') this.loadAdmin()
  },

  save(patch) {
    return api
      .put('/api/settings', patch)
      .then((d) => {
        this.apply(d)
        wx.showToast({ icon: 'success', title: S.settings.saved })
      })
      .catch((e) => wx.showToast({ icon: 'none', title: e.message || S.error }))
  },

  // ── profile ──
  onName(e) {
    this.setData({ name: e.detail.value })
  },
  saveName() {
    this.save({ name: this.data.name.trim() })
  },

  // ── prefs / look: segmented choices and switches ──
  pick(e) {
    const { key, value } = e.currentTarget.dataset
    this.save({ preferences: { [key]: value } })
  },
  toggle(e) {
    this.save({ preferences: { [e.currentTarget.dataset.key]: e.detail.value } })
  },
  onZone(e) {
    this.save({ preferences: { timezone: this.data.zones[Number(e.detail.value)] } })
  },
  onJur(e) {
    this.setData({ jurisdiction: e.detail.value })
  },
  saveJur() {
    this.save({ preferences: { jurisdiction: this.data.jurisdiction.trim() } })
  },

  // ── limits ──
  onCost(e) {
    this.setData({ cost: e.detail.value })
  },
  onDays(e) {
    this.setData({ days: e.detail.value })
  },
  saveCost() {
    this.save({ preferences: { goal_max_cost_usd: Number(this.data.cost) } })
  },
  saveDays() {
    this.save({ preferences: { goal_max_days: Number(this.data.days) } })
  },

  // ── privacy ──
  loadMemories() {
    api
      .get('/api/memories')
      .then((m) => this.setData({ memories: (m || []).map((x) => ({ id: x.id, content: x.content })) }))
      .catch(() => {})
  },
  forget(e) {
    api.del('/api/memories/' + e.currentTarget.dataset.id).then(() => this.loadMemories())
  },
  forgetAll() {
    wx.showModal({
      title: S.settings.forgetAll,
      content: S.settings.forgetAll + '？',
      confirmColor: '#D8483B',
      success: (r) => r.confirm && api.del('/api/memories').then(() => this.loadMemories()),
    })
  },
  exportData() {
    wx.showLoading({ title: S.loading })
    api
      .download('/api/account/export', 'act-export.json')
      .then((path) => {
        wx.hideLoading()
        wx.shareFileMessage({ filePath: path, fileName: 'act-export.json', fail: () => {} })
      })
      .catch(() => {
        wx.hideLoading()
        wx.showToast({ icon: 'none', title: S.error })
      })
  },
  deleteAccount() {
    wx.showModal({
      title: S.settings.deleteAccount,
      content: S.settings.deleteConfirm,
      confirmText: S.settings.deleteAccount,
      confirmColor: '#D8483B',
      success: (r) => {
        if (!r.confirm) return
        api
          .post('/api/account/delete', { password: '' })
          .then(() => app.signOut())
          .then(() => wx.switchTab({ url: '/pages/index/index' }))
          .catch((e) => wx.showToast({ icon: 'none', title: e.message || S.error }))
      },
    })
  },

  // ── security ──
  loadSessions() {
    api
      .get('/api/account/sessions')
      .then((ss) =>
        this.setData({
          sessions: (ss || []).map((x) => ({ id: x.id, device: fmt.device(x.user_agent), sub: x.ip + ' · ' + S.settings.lastSeen + ' ' + fmt.time(x.last_seen_at, true), current: x.current })),
        })
      )
      .catch(() => {})
  },
  revoke(e) {
    api.del('/api/account/sessions/' + e.currentTarget.dataset.id).then(() => this.loadSessions())
  },
  revokeOthers() {
    api.post('/api/account/sessions/revoke-others').then(() => this.loadSessions())
  },

  // ── professional licence ──
  onLicKind(e) {
    this.setData({ 'lic.kind': Number(e.detail.value) })
  },
  onLicNumber(e) {
    this.setData({ 'lic.number': e.detail.value })
  },
  onLicJur(e) {
    this.setData({ 'lic.jur': e.detail.value })
  },
  submitLicense() {
    const l = this.data.lic
    api
      .post('/api/account/license', { kind: S.settings.kinds[l.kind][0], number: l.number.trim(), jurisdiction: l.jur.trim() })
      .then(() => {
        this.setData({ lic: { kind: l.kind, number: '', jur: '' } })
        this.load()
      })
      .catch((e) => wx.showToast({ icon: 'none', title: e.message || S.error }))
  },

  // ── admin ──
  loadAdmin() {
    api
      .get('/api/admin/licenses')
      .then((rows) =>
        this.setData({
          adminRows: (rows || []).map((r) => ({
            id: r.id,
            who: (r.name || r.email || S.me.wechatUser) + ' · ' + (r.kind === 'bar' ? S.settings.kinds[0][1] : S.settings.kinds[1][1]),
            sub: [r.email, r.number, r.jurisdiction].filter(Boolean).join(' · '),
            status: r.status,
            statusLabel: S.settings.lic[r.status],
          })),
        })
      )
      .catch(() => {})
  },
  decideLicense(e) {
    const { id, verify } = e.currentTarget.dataset
    api.post('/api/admin/licenses/' + id, { verify: verify === 'yes' }).then(() => this.loadAdmin())
  },
})
