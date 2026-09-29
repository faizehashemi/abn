import type { PointRow, Section, User } from '../types'
import { daysInMonth, fmtDate, fmtMonth, shiftMonth, weekdayMon0 } from '../lib/util'
import { Empty, StatusPill } from './layout'

// ---------- score cards ----------

export function ScoreCards(props: { merits: number; demerits: number; score: number; rank?: number | null; of?: number }) {
  return (
    <div class="stats">
      <div class="stat stat-merit"><span class="stat-label">Total Merits</span><span class="stat-value">+{props.merits}</span></div>
      <div class="stat stat-demerit"><span class="stat-label">Total Demerits</span><span class="stat-value">−{props.demerits}</span></div>
      <div class="stat stat-score"><span class="stat-label">Final Score</span><span class="stat-value">{props.score}</span></div>
      {props.rank != null ? (
        <div class="stat"><span class="stat-label">Leaderboard Rank</span><span class="stat-value">#{props.rank}<small> / {props.of}</small></span></div>
      ) : null}
    </div>
  )
}

// ---------- merit / demerit history ----------

export function pointSentence(p: PointRow, you: boolean): string {
  const n = `${p.points} ${p.kind === 'merit' ? 'Merit' : 'Demerit'}${p.points === 1 ? '' : 's'}`
  return `${you ? 'You got' : 'Received'} ${n} on ${fmtDate(p.event_date)} for ${p.reason}`
}

export function PointsTable(props: { rows: PointRow[]; showStatus?: boolean; showRequester?: boolean; you?: boolean }) {
  if (props.rows.length === 0) return <Empty>No merit or demerit entries yet.</Empty>
  return (
    <ul class="points-list">
      {props.rows.map((p) => (
        <li class={`point point-${p.kind}`}>
          <span class={`point-amount ${p.kind}`}>{p.kind === 'merit' ? '+' : '−'}{p.points}</span>
          <div class="point-body">
            <div>{pointSentence(p, !!props.you)}</div>
            <div class="muted small">
              {props.showRequester && p.requester_name ? <>Given by {p.requester_name} · </> : null}
              Recorded {fmtDate(p.created_at)}
              {p.review_note ? <> · Note: {p.review_note}</> : null}
            </div>
          </div>
          {props.showStatus ? <StatusPill status={p.status} /> : null}
        </li>
      ))}
    </ul>
  )
}

// ---------- attendance calendar ----------

const STATUS_SHORT: Record<string, string> = { present: 'P', absent: 'A', leave: 'L' }

export function AttendanceCalendar(props: { month: string; records: Record<string, string>; baseUrl: string; today: string }) {
  const { month, records } = props
  const days = daysInMonth(month)
  const lead = weekdayMon0(`${month}-01`)
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]
  while (cells.length % 7) cells.push(null)
  const sep = props.baseUrl.includes('?') ? '&' : '?'
  return (
    <div class="calendar-wrap">
      <div class="cal-nav">
        <a class="btn btn-sm" href={`${props.baseUrl}${sep}month=${shiftMonth(month, -1)}`}>‹ Prev</a>
        <strong>{fmtMonth(month)}</strong>
        <a class="btn btn-sm" href={`${props.baseUrl}${sep}month=${shiftMonth(month, 1)}`}>Next ›</a>
      </div>
      <div class="calendar">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div class="cal-h">{d}</div>)}
        {cells.map((d) => {
          if (d == null) return <div class="cal-cell cal-empty"></div>
          const iso = `${month}-${String(d).padStart(2, '0')}`
          const st = records[iso]
          return (
            <div class={`cal-cell${st ? ` cal-${st}` : ''}${iso === props.today ? ' cal-today' : ''}`} title={st ? `${fmtDate(iso)}: ${st}` : fmtDate(iso)}>
              <span class="cal-day">{d}</span>
              {st ? <span class="cal-status">{STATUS_SHORT[st]}</span> : null}
            </div>
          )
        })}
      </div>
      <div class="legend">
        <span><i class="dot dot-present"></i>Present</span>
        <span><i class="dot dot-absent"></i>Absent</span>
        <span><i class="dot dot-leave"></i>Leave</span>
      </div>
    </div>
  )
}

export function AttendanceSummary(props: { present: number; absent: number; leave: number; label?: string }) {
  return (
    <div class="stats stats-sm">
      <div class="stat stat-present"><span class="stat-label">Present{props.label ? ` (${props.label})` : ''}</span><span class="stat-value">{props.present}</span></div>
      <div class="stat stat-absent"><span class="stat-label">Absent</span><span class="stat-value">{props.absent}</span></div>
      <div class="stat stat-leave"><span class="stat-label">Leave</span><span class="stat-value">{props.leave}</span></div>
    </div>
  )
}

export function attendanceSentence(records: Record<string, string>): string {
  const byStatus = (s: string) => Object.keys(records).filter((d) => records[d] === s).sort()
  const parts: string[] = []
  const absent = byStatus('absent')
  const leave = byStatus('leave')
  if (absent.length) parts.push(`You were absent on ${absent.map(fmtDate).join(', ')}.`)
  if (leave.length) parts.push(`You were on leave on ${leave.map(fmtDate).join(', ')}.`)
  parts.push(`Total present this month: ${byStatus('present').length} day${byStatus('present').length === 1 ? '' : 's'}.`)
  return parts.join(' ')
}

// ---------- profile form ----------

export type ProfileMode = 'complete' | 'self' | 'admin'

export function ProfileForm(props: { user: User; sections: Section[]; mode: ProfileMode; action: string; errors?: string[] }) {
  const u = props.user
  const lockCore = props.mode === 'self' // name, section, DOJ are locked for teachers after onboarding
  return (
    <form method="post" action={props.action} enctype="multipart/form-data" class="card form-grid">
      {props.errors && props.errors.length ? (
        <div class="flash flash-err span-2">
          {props.errors.map((e) => <div>{e}</div>)}
        </div>
      ) : null}

      <div class="span-2 photo-row">
        {u.photo_key ? <img class="avatar avatar-lg" src={`/photo/${u.id}?v=${encodeURIComponent(u.photo_key)}`} alt="" /> : <span class="avatar avatar-lg avatar-initials">?</span>}
        <label>
          Photo {props.mode === 'complete' && !u.photo_key ? <span class="req">*</span> : null}
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required={props.mode === 'complete' && !u.photo_key} />
          <span class="hint">JPG / PNG / WebP, up to 3 MB. A clear passport-style photo.</span>
        </label>
      </div>

      <label>
        Full Name <span class="req">*</span>
        <input name="full_name" required maxlength={100} value={u.full_name} readonly={lockCore} />
      </label>
      <label>
        ITS Number
        {props.mode === 'admin'
          ? <input name="its" required pattern="\d{8}" maxlength={8} value={u.its} />
          : <input value={u.its} readonly disabled />}
      </label>
      <label>
        Contact Number <span class="req">*</span>
        <input name="phone" type="tel" required pattern="[0-9+\- ]{10,15}" value={u.phone ?? ''} placeholder="10-digit mobile" />
      </label>
      <label>
        Email <span class="req">*</span>
        <input name="email" type="email" required maxlength={120} value={u.email ?? ''} />
      </label>
      <label>
        Section / Department <span class="req">*</span>
        {lockCore ? (
          <input value={u.section_name ?? '—'} readonly disabled />
        ) : (
          <select name="section_id" required>
            <option value="">— Select —</option>
            {props.sections.map((s) => <option value={String(s.id)} selected={u.section_id === s.id}>{s.name}</option>)}
          </select>
        )}
      </label>
      <label>
        Date of Joining <span class="req">*</span>
        <input name="date_of_joining" type="date" required value={u.date_of_joining ?? ''} readonly={lockCore} />
      </label>
      <label>
        Qualification <span class="req">*</span>
        <input name="qualification" required maxlength={200} value={u.qualification ?? ''} placeholder="e.g. M.Sc. B.Ed." />
      </label>
      <label>
        Designation
        <input name="designation" maxlength={100} value={u.designation ?? ''} placeholder="e.g. PGT Physics" />
      </label>
      <label class="span-2">
        Subjects Taught
        <input name="subjects" maxlength={200} value={u.subjects ?? ''} placeholder="e.g. Physics, Mathematics" />
      </label>
      <label class="span-2">
        Address <span class="req">*</span>
        <textarea name="address" required rows={3} maxlength={500}>{u.address ?? ''}</textarea>
      </label>
      <div class="span-2">
        <button class="btn btn-primary" type="submit">{props.mode === 'complete' ? 'Complete Profile' : 'Save changes'}</button>
      </div>
    </form>
  )
}
