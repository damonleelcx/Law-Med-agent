// Formatting shared by every page: times, task activity and timeline labels,
// as the web app shows them (web/src/app/parts.tsx, CaseView.tsx).

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

// "11月19日 14:05", or just "14:05" today.
function time(iso, alwaysDate) {
  if (!iso) return ''
  const d = new Date(iso)
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
  if (!alwaysDate && d.toDateString() === new Date().toDateString()) return hm
  return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + hm
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? m + ' 分钟' : s + ' 秒'
}

// What a running step is doing right now, in words a client understands.
const toolDoing = {
  legal_search_cases: '检索判例',
  legal_verify_citations: '核对引用的判例',
  legal_statute_lookup: '查阅法条',
  legal_deadline_calc: '计算期限',
  legal_conflict_check: '核查利益冲突',
  save_document: '将文书存入你的档案',
  get_document: '阅读你的文件',
  kb_search: '检索你的档案',
  memory_save: '记下要点',
  med_red_flag_check: '排查危险信号',
  med_icd10_lookup: '查询疾病编码',
  med_drug_normalize: '识别药物',
  med_drug_label: '查阅药品说明书',
  med_interaction_check: '检查药物相互作用',
  med_dose_calc: '计算剂量',
  med_pubmed_search: '检索医学文献',
  schedule_reminder: '设置提醒',
  notify_user: '给你发送进展',
  email_send: '准备待审批的邮件',
  request_professional_signoff: '提交持证专业人士审阅',
}
const stateDoing = {
  'task.started': '开始处理',
  'task.resumed': '从上次停下的地方继续',
  'task.verify_failed': '复核并修正中',
  'lease.reclaimed': '中断后正在恢复',
  'task.lease_lost': '中断后正在恢复',
  'task.retry': '稍后重试',
}

// activity: the web app's <Activity>, as {text, recovering} or null.
function activity(task) {
  const a = task.activity
  const recoverable = a && (a.type === 'lease.reclaimed' || a.type === 'task.lease_lost' || a.type === 'task.retry')
  if (!a || !(task.status === 'leased' || (task.status === 'ready' && recoverable))) return null
  const label = (a.type === 'tool.called' ? toolDoing[a.tool] : stateDoing[a.type]) || stateDoing['task.started']
  return { text: label + '… ' + ago(a.at), recovering: a.type === 'lease.reclaimed' || a.type === 'task.lease_lost' }
}

const eventText = {
  'goal.created': '案件已建立',
  'goal.planned': '已制定计划',
  'goal.replanned': '计划已调整',
  'goal.status': '状态变更',
  'task.started': '开始',
  'task.resumed': '从检查点继续',
  'task.succeeded': '完成',
  'task.verified': '已核验',
  'task.verify_failed': '核验未通过，正在修正',
  'task.retry': '将重试',
  'task.failed': '失败',
  'task.released': '已安全暂停',
  'task.lease_lost': '已交接',
  'lease.reclaimed': '中断后已恢复',
  'tool.called': '操作',
  'approval.requested': '请求审批',
  'approval.decided': '审批结果',
  'budget.exceeded': '达到上限',
  'reminder.sent': '已发送提醒',
  emergency: '已显示紧急指引',
}

function event(e) {
  const d = e.data || {}
  const detail = [d.task, d.tool, d.to && '→ ' + d.to, d.decision].filter(Boolean).join(' · ')
  const why = d.why || d.reason || d.error || d.summary
  return {
    key: 'e' + e.id,
    label: eventText[e.type] || e.type,
    at: time(e.created_at, true),
    detail,
    why: why ? String(why).slice(0, 400) : '',
    kind: e.type.split('.')[0],
    bad: e.type.indexOf('fail') >= 0,
  }
}

// workTasks: the steps a client sees (not the planner's own bookkeeping).
function workTasks(tasks) {
  return (tasks || []).filter((x) => x.kind === 'llm' || x.kind === 'wait')
}

function progress(tasks) {
  const t = workTasks(tasks)
  const done = t.filter((x) => x.status === 'succeeded' || x.status === 'skipped').length
  return { done, total: t.length, pct: t.length ? Math.round((done / t.length) * 100) : 0 }
}

// First readable line of a Markdown text, for collapsed views.
function plain(s) {
  return (s || '').replace(/[#*_`>|-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function device(ua) {
  ua = ua || ''
  if (/miniProgram|MiniProgramEnv/i.test(ua) || /MicroMessenger/.test(ua)) {
    const o = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : ''
    return '微信小程序' + (o ? ' · ' + o : '')
  }
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '浏览器'
  const o = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return b + (o ? ' · ' + o : '')
}

module.exports = { time, activity, event, workTasks, progress, plain, device }
