import { useState } from 'react'
import { Link } from 'react-router-dom'
import { IconAlert, IconCheck, IconClock, IconX } from '../components/Icons'
import { api, type Approval, type Goal, type Task } from '../lib/api'
import { useI18n } from '../lib/i18n'

export type Mood = 'smile' | 'think' | 'laugh'

export function VeraFace({ mood = 'smile', size = 36, pulse }: { mood?: Mood; size?: number; pulse?: boolean }) {
  return (
    <span className={`vface ${pulse ? 'pulse' : ''}`} style={{ width: size, height: size }}>
      <img src={`/vera/vera-face-${mood}.webp`} alt="Vera" width={size} height={size} />
    </span>
  )
}

export function StatusPill({ status }: { status: Goal['status'] }) {
  const { t } = useI18n()
  return <span className={`pill pill-${status}`}>{t.goal.status[status]}</span>
}

export function TaskIcon({ status }: { status: string }) {
  if (status === 'succeeded') return <span className="ti ti-done"><IconCheck size={13} /></span>
  if (status === 'failed' || status === 'cancelled') return <span className="ti ti-fail"><IconX size={13} /></span>
  if (status === 'waiting_approval') return <span className="ti ti-wait"><IconAlert size={13} /></span>
  if (status === 'leased') return <span className="ti ti-run" />
  if (status === 'ready' ) return <span className="ti ti-next"><IconClock size={12} /></span>
  return <span className="ti ti-idle" />
}

export function workTasks(tasks?: Task[]) {
  return (tasks || []).filter((x) => x.kind === 'llm' || x.kind === 'wait')
}

// An inline card for a case opened from the conversation. It follows the plan
// live: steps tick over as the workers finish them.
export function GoalCard({ goal }: { goal: Goal }) {
  const { t, f } = useI18n()
  const tasks = workTasks(goal.tasks)
  const done = tasks.filter((x) => x.status === 'succeeded' || x.status === 'skipped').length
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0
  return (
    <div className={`goal-card domain-${goal.domain}`}>
      <div className="gc-head">
        <div>
          <small>{t.app.caseOpened} · {t.goal.domain[goal.domain]}</small>
          <strong>{goal.title}</strong>
        </div>
        <StatusPill status={goal.status} />
      </div>
      {goal.status === 'needs_attention' && goal.attention_reason && (
        <div className="gc-attn"><IconAlert size={15} /> {goal.attention_reason}</div>
      )}
      <div className="gc-bar"><i style={{ width: `${pct}%` }} /></div>
      {tasks.length > 0 ? (
        <ol className="gc-steps">
          {tasks.map((x) => (
            <li key={x.id} className={`st-${x.status}`}>
              <TaskIcon status={x.status} />
              <span>{x.title}</span>
              {x.status !== 'blocked' && x.status !== 'succeeded' && <em>{t.goal.task[x.status as keyof typeof t.goal.task]}</em>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="gc-planning"><span className="dots3"><i /><i /><i /></span> {t.goal.status.planning}</p>
      )}
      <div className="gc-foot">
        <span>{f(t.app.progress, { done, total: tasks.length })}</span>
        <Link to={`/app/cases/${goal.id}`}>{t.app.viewCase} →</Link>
      </div>
    </div>
  )
}

export function ApprovalCard({ a, onDone }: { a: Approval; onDone?: () => void }) {
  const { t, f, lang } = useI18n()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const role = a.required_role === 'attorney' ? (lang === 'zh' ? '律师' : 'attorney') : a.required_role === 'physician' ? (lang === 'zh' ? '医生' : 'physician') : a.required_role
  const decide = async (approve: boolean) => {
    setBusy(true)
    setErr('')
    try {
      await api.post(`/api/approvals/${a.id}`, { approve, note })
      onDone?.()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  const label = t.approval.tools[a.tool] || a.tool
  return (
    <div className={`approval ${a.status}`}>
      <div className="ap-head">
        <span className={`ap-gate ${a.gate}`}>{a.gate === 'G2' ? f(t.approval.g2, { role }) : t.approval.g1}</span>
        <strong>{label}</strong>
        <small>{a.goal_title}{a.client && ` · ${t.approval.client}: ${a.client.name || a.client.email}`}</small>
      </div>
      <pre className="ap-preview">{a.preview}</pre>
      {a.status === 'pending' ? (
        a.can_decide ? (
          <>
            <input className="input ap-note" placeholder={t.approval.note} value={note} onChange={(e) => setNote(e.target.value)} />
            {err && <div className="alert alert-error">{err}</div>}
            <div className="ap-actions">
              <button className="btn btn-ember btn-sm" disabled={busy} onClick={() => decide(true)}><IconCheck size={16} /> {t.approval.approve}</button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => decide(false)}>{t.approval.decline}</button>
            </div>
          </>
        ) : (
          <p className="ap-waiting"><IconClock size={15} /> {f(t.approval.waiting, { role })}</p>
        )
      ) : (
        <p className={`ap-result ${a.status}`}>{t.approval[a.status as 'approved' | 'rejected' | 'superseded']}{a.note && ` — “${a.note}”`}</p>
      )}
    </div>
  )
}

export function fmtTime(s: string, lang: string) {
  const d = new Date(s)
  return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
