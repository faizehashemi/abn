import { Hono } from 'hono'
import type { AppEnv, AttendanceStatus, User } from '../types'
import { page, PageHead, Avatar, Empty } from '../views/layout'
import { attendanceScope } from '../lib/auth'
import { SECTION_NAMES_SQL, inSections, listSections } from '../lib/queries'
import {
  ATTENDANCE, ATT_CODE, ATT_LABEL, back, csvCell, currentMonth, daysInMonth, fmtDate, fmtMonth, isISODate, isMonth, monthBounds,
  normaliseDate, parseAttendanceStatus, parseCSV, shiftMonth, str, todayISO, weekdayMon0,
} from '../lib/util'

const app = new Hono<AppEnv>()

type Roster = Pick<User, 'id' | 'its' | 'full_name' | 'photo_key'> & { section_name: string | null }

/** Days that may be recorded ahead of time (planned absences). */
const FUTURE_OK: AttendanceStatus[] = ['casual_leave', 'eval_absent']

/** Teachers whose attendance `user` may mark / view, optionally narrowed to one section. */
async function roster(c: any, user: User, sectionFilter: number | null, forView = false): Promise<Roster[] | null> {
  let scope = attendanceScope(user)
  // Every section head may *view* their own sections' attendance, even without marking rights.
  if (scope == null && forView && user.role === 'head' && user.section_ids.length) scope = user.section_ids
  if (scope == null) return null
  const where = [`u.status = 'active'`, `u.role != 'coordinator'`]
  const args: unknown[] = []
  // A head limited to some sections can still narrow to one of them.
  const ids = scope === 'all' ? (sectionFilter ? [sectionFilter] : null) : (sectionFilter && scope.includes(sectionFilter) ? [sectionFilter] : scope)
  if (ids) { const f = inSections(ids); where.push(f.sql); args.push(...f.args) }
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.its, u.full_name, u.photo_key, ${SECTION_NAMES_SQL} AS section_name
       FROM users u
      WHERE ${where.join(' AND ')} ORDER BY section_name COLLATE NOCASE, u.full_name COLLATE NOCASE`,
  ).bind(...args).all()
  return results as Roster[]
}

/** Sections the user can pick in the filter: all for 'all' scope, otherwise their own (when more than one). */
async function filterSections(c: any, user: User, forView = false) {
  const scope = attendanceScope(user) ?? (forView && user.role === 'head' ? user.section_ids : null)
  const all = await listSections(c.env)
  if (scope === 'all') return all
  if (!scope || scope.length < 2) return []
  return all.filter((s) => scope.includes(s.id))
}

function Tabs(props: { active: 'mark' | 'report' }) {
  return (
    <div class="tabs">
      <a href="/attendance/mark" class={props.active === 'mark' ? 'active' : ''}>Mark / Edit</a>
      <a href="/attendance/report" class={props.active === 'report' ? 'active' : ''}>Monthly Report</a>
    </div>
  )
}

// ---------- mark / edit a day ----------

app.get('/mark', async (c) => {
  const user = c.get('user')
  const tz = c.env.TIMEZONE
  const today = todayISO(tz)
  const date = isISODate(c.req.query('date')) ? c.req.query('date')! : today
  const sectionFilter = Number(c.req.query('section')) || null
  const list = await roster(c, user, sectionFilter)
  if (!list) return c.text('You do not have attendance rights. Ask the Main Coordinator.', 403)
  const sections = await filterSections(c, user)
  const canFilter = sections.length > 0

  const { results } = await c.env.DB.prepare('SELECT teacher_id, status, leave_id FROM attendance WHERE date = ?').bind(date).all<{ teacher_id: number; status: string; leave_id: number | null }>()
  const existing = new Map(results.map((r) => [r.teacher_id, r.status]))
  const fromLeave = new Set(results.filter((r) => r.leave_id).map((r) => r.teacher_id))
  const markedHere = list.filter((t) => existing.has(t.id)).length
  const prevDay = new Date(Date.parse(date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)
  const nextDay = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  const qs = (d: string) => `/attendance/mark?date=${d}${sectionFilter ? `&section=${sectionFilter}` : ''}`

  return page(c, 'Attendance',
    <>
      <PageHead title="Attendance" sub={attendanceScope(user) === 'all' ? 'All teachers' : `Section(s): ${user.section_name}`} />
      <Tabs active="mark" />
      <div class="card">
        <form method="get" class="filters">
          <a class="btn btn-sm" href={qs(prevDay)}>‹</a>
          <input type="date" name="date" value={date} />
          <a class="btn btn-sm" href={qs(nextDay)}>›</a>
          {canFilter ? (
            <select name="section">
              <option value="">All sections</option>
              {sections.map((s) => <option value={String(s.id)} selected={s.id === sectionFilter}>{s.name}</option>)}
            </select>
          ) : null}
          <button class="btn btn-sm">Go</button>
          {date !== today ? <a class="btn btn-sm" href={qs(today)}>Today</a> : null}
        </form>
        <p class="muted">
          <b>{fmtDate(date)}</b> ({['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weekdayMon0(date)]}) · {markedHere}/{list.length} marked
          {date > today ? ' · future date: only CL and EA can be recorded' : ''}
        </p>
      </div>

      {list.length === 0 ? <Empty>No active teachers in scope.</Empty> : (
        <form method="post" action="/attendance/mark" class="card">
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="section" value={sectionFilter ? String(sectionFilter) : ''} />
          <div class="bulk-actions">
            <span class="muted small">Set everyone to:</span>
            <button type="button" class="btn btn-sm" data-mark-all="present">All Present</button>
            <button type="button" class="btn btn-sm" data-mark-all="absent">All Absent</button>
            <button type="button" class="btn btn-sm" data-mark-all="">Clear</button>
          </div>
          <ul class="att-list">
            {list.map((t) => {
              const cur = existing.get(t.id) ?? ''
              return (
                <li>
                  <input type="hidden" name="id" value={String(t.id)} />
                  <div class="who-cell grow">
                    <Avatar id={t.id} name={t.full_name} photo={t.photo_key} size={32} />
                    <span>
                      {t.full_name}<small class="muted"> · {t.its}{canFilter && !sectionFilter ? ` · ${t.section_name ?? '—'}` : ''}</small>
                      {fromLeave.has(t.id) ? <span class="pill pill-leave">approved leave</span> : null}
                    </span>
                  </div>
                  <div class="att-choice" role="radiogroup">
                    {[...ATTENDANCE.map((a) => [a.status, a.code, a.label] as const), ['', '–', 'not marked'] as const].map(([v, code, label]) => (
                      <label class={`chip chip-${v || 'none'}`} title={label}>
                        <input type="radio" name={`s_${t.id}`} value={v} checked={cur === v} />
                        <span>{code}</span>
                      </label>
                    ))}
                  </div>
                </li>
              )
            })}
          </ul>
          <div class="sticky-save"><button class="btn btn-primary">Save attendance for {fmtDate(date)}</button></div>
        </form>
      )}

      <section class="card">
        <h2>Bulk upload (CSV)</h2>
        <p class="muted small">
          One row per entry: <code>ITS,Date,Status</code> — Date as <code>2026-09-05</code> or <code>05/09/2026</code>, Status as <code>P</code> / <code>A</code> / <code>CL</code> / <code>EA</code> (or Present / Absent / Casual Leave / Evaluation Absent).
          If every row is for the same day you can pick the date below and use <code>ITS,Status</code>. Existing entries are overwritten.
        </p>
        <form method="post" action="/attendance/upload" enctype="multipart/form-data" class="stack">
          <div class="form-grid">
            <label>CSV file<input type="file" name="file" accept=".csv,text/csv" /></label>
            <label>Default date (for 2-column rows)<input type="date" name="date" value={date} /></label>
          </div>
          <label>…or paste rows<textarea name="text" rows={5} placeholder={'30412345,2026-09-05,P\n30498765,2026-09-05,CL\n30411111,2026-09-05,EA'}></textarea></label>
          <button class="btn btn-primary">Upload</button>
        </form>
      </section>
    </>,
  )
})

app.post('/mark', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody({ all: true })
  const date = str(body.date, 10)
  const section = str(body.section, 10)
  const url = `/attendance/mark?date=${date}${section ? `&section=${section}` : ''}`
  if (!isISODate(date)) return back(c, '/attendance/mark', 'err', 'Invalid date.')
  const future = date > todayISO(c.env.TIMEZONE)

  const allowed = new Set((await roster(c, user, null))?.map((t) => t.id) ?? [])
  const ids = ([] as unknown[]).concat(body.id ?? []).map(Number).filter((id) => allowed.has(id))
  const stmts: D1PreparedStatement[] = []
  let skipped = 0
  for (const id of ids) {
    const raw = body[`s_${id}`]
    const v = typeof raw === 'string' ? raw : ''
    if (v === '') {
      stmts.push(c.env.DB.prepare('DELETE FROM attendance WHERE teacher_id = ? AND date = ?').bind(id, date))
    } else {
      const status = parseAttendanceStatus(v)
      if (!status) continue
      if (future && !FUTURE_OK.includes(status)) { skipped++; continue }
      stmts.push(upsert(c, id, date, status, user.id))
    }
  }
  if (stmts.length) await c.env.DB.batch(stmts)
  return back(c, url, skipped ? 'err' : 'ok', `Attendance saved for ${fmtDate(date)}.${skipped ? ` ${skipped} future P/A entries were ignored (only CL and EA can be recorded ahead).` : ''}`)
})

function upsert(c: any, teacherId: number, date: string, status: AttendanceStatus, by: number): D1PreparedStatement {
  return c.env.DB.prepare(
    `INSERT INTO attendance (teacher_id, date, status, marked_by, leave_id, updated_at) VALUES (?, ?, ?, ?, NULL, datetime('now'))
     ON CONFLICT(teacher_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by, leave_id = NULL, updated_at = excluded.updated_at`,
  ).bind(teacherId, date, status, by)
}

app.post('/upload', async (c) => {
  const user = c.get('user')
  const list = await roster(c, user, null)
  if (!list) return c.text('Forbidden', 403)
  const body = await c.req.parseBody()
  let text = typeof body.text === 'string' ? body.text : ''
  if (body.file instanceof File && body.file.size > 0) text = await body.file.text()
  const defaultDate = isISODate(body.date) ? body.date : null
  const rows = parseCSV(text).filter((r) => !/^its/i.test(r[0] ?? ''))
  if (!rows.length) return back(c, '/attendance/mark', 'err', 'No rows found.')
  if (rows.length > 3000) return back(c, '/attendance/mark', 'err', 'Please upload at most 3000 rows at a time.')

  const byIts = new Map(list.map((t) => [t.its, t.id]))
  const today = todayISO(c.env.TIMEZONE)
  const errors: string[] = []
  const stmts: D1PreparedStatement[] = []
  rows.forEach((r, i) => {
    const line = i + 1
    const [its, a, b] = r
    const dateRaw = r.length >= 3 ? a : defaultDate ?? ''
    const statusRaw = r.length >= 3 ? b : a ?? ''
    const id = byIts.get(its ?? '')
    const date = normaliseDate(dateRaw ?? '')
    const status = parseAttendanceStatus(statusRaw ?? '')
    if (!id) return errors.push(`row ${line}: ITS ${its} not found in your scope`)
    if (!date) return errors.push(`row ${line}: bad date "${dateRaw}"`)
    if (!status) return errors.push(`row ${line}: bad status "${statusRaw}"`)
    if (date > today && !FUTURE_OK.includes(status)) return errors.push(`row ${line}: future date (only CL/EA allowed)`)
    stmts.push(upsert(c, id, date, status, user.id))
  })
  for (let i = 0; i < stmts.length; i += 100) await c.env.DB.batch(stmts.slice(i, i + 100))
  const msg = `Uploaded ${stmts.length} entr${stmts.length === 1 ? 'y' : 'ies'}.` + (errors.length ? ` Skipped ${errors.length}: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? '…' : ''}` : '')
  return back(c, '/attendance/mark', stmts.length ? 'ok' : 'err', msg)
})

// ---------- monthly report ----------

async function reportData(c: any) {
  const user = c.get('user') as User
  const month = isMonth(c.req.query('month')) ? c.req.query('month')! : currentMonth(c.env.TIMEZONE)
  const sectionFilter = Number(c.req.query('section')) || null
  const list = await roster(c, user, sectionFilter, true)
  if (!list) return null
  const { start, end } = monthBounds(month)
  const { results } = await c.env.DB.prepare('SELECT teacher_id, date, status FROM attendance WHERE date BETWEEN ? AND ?')
    .bind(start, end).all()
  const grid = new Map<number, Record<string, string>>()
  for (const r of results as { teacher_id: number; date: string; status: string }[]) {
    if (!grid.has(r.teacher_id)) grid.set(r.teacher_id, {})
    grid.get(r.teacher_id)![r.date] = r.status
  }
  return { user, month, sectionFilter, list, grid, days: daysInMonth(month) }
}

app.get('/report', async (c) => {
  const data = await reportData(c)
  if (!data) return c.text('Forbidden', 403)
  const { user, month, sectionFilter, list, grid, days } = data
  const sections = await filterSections(c, user, true)
  const canFilter = sections.length > 0
  const dayNums = Array.from({ length: days }, (_, i) => i + 1)
  const q = (m: string) => `/attendance/report?month=${m}${sectionFilter ? `&section=${sectionFilter}` : ''}`
  const count = (rec: Record<string, string>, s: string) => Object.values(rec).filter((v) => v === s).length

  return page(c, 'Attendance report',
    <>
      <PageHead title="Attendance" sub={fmtMonth(month)} actions={<a class="btn btn-sm" href={`/attendance/export?month=${month}${sectionFilter ? `&section=${sectionFilter}` : ''}`}>Export CSV</a>} />
      {attendanceScope(user) != null ? <Tabs active="report" /> : null}
      <p class="legend">{ATTENDANCE.map((a) => <span><i class={`dot dot-${a.status}`}></i>{a.code} · {a.label}</span>)}</p>
      <form method="get" class="filters card">
        <a class="btn btn-sm" href={q(shiftMonth(month, -1))}>‹</a>
        <input type="month" name="month" value={month} />
        <a class="btn btn-sm" href={q(shiftMonth(month, 1))}>›</a>
        {canFilter ? (
          <select name="section">
            <option value="">All sections</option>
            {sections.map((s) => <option value={String(s.id)} selected={s.id === sectionFilter}>{s.name}</option>)}
          </select>
        ) : null}
        <button class="btn btn-sm">Show</button>
      </form>
      <div class="card table-wrap">
        {list.length === 0 ? <Empty>No teachers in scope.</Empty> : (
          <table class="table att-matrix">
            <thead>
              <tr>
                <th class="sticky-col">Teacher</th>
                {dayNums.map((d) => {
                  const wd = weekdayMon0(`${month}-${String(d).padStart(2, '0')}`)
                  return <th class={wd === 6 ? 'sun' : ''}>{d}<small>{'MTWTFSS'[wd]}</small></th>
                })}
                {ATTENDANCE.map((a) => <th class="num" title={a.label}>{a.code}</th>)}
              </tr>
            </thead>
            <tbody>
              {list.map((t) => {
                const rec = grid.get(t.id) ?? {}
                return (
                  <tr>
                    <td class="sticky-col"><a href={`/teachers/${t.id}?month=${month}`}>{t.full_name}</a><small class="muted"> {t.section_name ?? ''}</small></td>
                    {dayNums.map((d) => {
                      const st = rec[`${month}-${String(d).padStart(2, '0')}`]
                      return <td class={st ? `m-${st}` : ''} title={st ? ATT_LABEL[st] : undefined}>{st ? ATT_CODE[st] : ''}</td>
                    })}
                    {ATTENDANCE.map((a) => <td class="num">{count(rec, a.status)}</td>)}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </>,
  )
})

app.get('/export', async (c) => {
  const data = await reportData(c)
  if (!data) return c.text('Forbidden', 403)
  const { month, list, grid, days } = data
  const dates = Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
  const lines = [['ITS', 'Name', 'Section', ...dates, ...ATTENDANCE.map((a) => `${a.label} (${a.code})`)].join(',')]
  for (const t of list) {
    const rec = grid.get(t.id) ?? {}
    const vals = Object.values(rec)
    lines.push([t.its, t.full_name, t.section_name ?? '', ...dates.map((d) => (rec[d] ? ATT_CODE[rec[d]] : '')),
      ...ATTENDANCE.map((a) => vals.filter((v) => v === a.status).length)].map(csvCell).join(','))
  }
  return c.body(lines.join('\r\n'), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="abn-attendance-${month}.csv"`,
  })
})

export default app
