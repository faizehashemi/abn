import { Hono } from 'hono'
import type { AppEnv, PointRow, User } from '../types'
import { page, PageHead, Avatar, Empty, StatusPill } from '../views/layout'
import { AttendanceCalendar, AttendanceSummary, PointsTable, ProfileForm, ScoreCards } from '../views/components'
import { canGivePoints, canViewTeacher, getUserById, requireRole } from '../lib/auth'
import { attendanceCounts, listSections, scoreboard, teacherTotals } from '../lib/queries'
import { back, currentMonth, fmtDate, isISODate, isMonth, monthBounds, str, todayISO } from '../lib/util'
import { notifyPointsApproved } from './admin'

const app = new Hono<AppEnv>()

// ---------- section head: my team ----------

app.get('/team', requireRole('head'), async (c) => {
  const user = c.get('user')
  if (user.section_id == null) {
    return page(c, 'My Team', <><PageHead title="My Team" /><Empty>You have not been assigned a section yet. Please contact the Main Coordinator.</Empty></>)
  }
  const rows = await scoreboard(c.env, user.section_id)
  const { results: requests } = await c.env.DB.prepare(
    `SELECT p.*, t.full_name AS teacher_name FROM points p JOIN users t ON t.id = p.teacher_id
      WHERE p.requested_by = ? ORDER BY p.created_at DESC LIMIT 30`,
  ).bind(user.id).all<PointRow>()
  return page(c, 'My Team',
    <>
      <PageHead title={`My Team · ${user.section_name}`} sub="Select a teacher to view their full record or to add merit / demerit points." />
      <div class="card table-wrap">
        {rows.length === 0 ? <Empty>No teachers in your section yet.</Empty> : (
          <table class="table">
            <thead><tr><th>Teacher</th><th>ITS</th><th class="num">Merits</th><th class="num">Demerits</th><th class="num">Score</th><th>Rank</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td class="who-cell"><Avatar id={r.id} name={r.full_name} photo={r.photo_key} size={30} /><a href={`/teachers/${r.id}`}>{r.full_name}</a>{r.id === user.id ? <span class="pill pill-me">You</span> : null}</td>
                  <td>{r.its}</td>
                  <td class="num merit">+{r.merits}</td>
                  <td class="num demerit">−{r.demerits}</td>
                  <td class="num"><b>{r.score}</b></td>
                  <td>#{r.rank}</td>
                  <td class="row-actions">
                    {r.id !== user.id ? (
                      <>
                        <a class="btn btn-sm btn-merit" href={`/teachers/${r.id}?give=merit#give`}>+ Merit</a>
                        <a class="btn btn-sm btn-demerit" href={`/teachers/${r.id}?give=demerit#give`}>− Demerit</a>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <section class="card">
        <h2>My recent requests</h2>
        {requests.length === 0 ? <Empty>You have not submitted any merit/demerit requests yet.</Empty> : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Date</th><th>Teacher</th><th>Points</th><th>Reason</th><th>Status</th></tr></thead>
              <tbody>
                {requests.map((p) => (
                  <tr>
                    <td>{fmtDate(p.event_date)}</td>
                    <td><a href={`/teachers/${p.teacher_id}`}>{p.teacher_name}</a></td>
                    <td class={p.kind}>{p.kind === 'merit' ? '+' : '−'}{p.points} {p.kind}</td>
                    <td>{p.reason}{p.review_note ? <div class="muted small">Coordinator: {p.review_note}</div> : null}</td>
                    <td><StatusPill status={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>,
  )
})

// ---------- teacher detail (coordinator: anyone; head: own section) ----------

async function loadVisible(c: any): Promise<{ viewer: User; target: User } | Response> {
  const viewer = c.get('user') as User
  const id = Number(c.req.param('id'))
  const target = Number.isInteger(id) ? await getUserById(c.env, id) : null
  if (!target || target.role === 'coordinator') return c.notFound()
  if (viewer.id === target.id) return c.redirect('/my/points', 303)
  if (!canViewTeacher(viewer, target)) return c.text('Forbidden: this teacher is not in your section.', 403)
  return { viewer, target }
}

app.get('/teachers/:id', async (c) => {
  const r = await loadVisible(c)
  if (r instanceof Response) return r
  const { viewer, target: t } = r
  const tz = c.env.TIMEZONE
  const month = isMonth(c.req.query('month')) ? c.req.query('month')! : currentMonth(tz)
  const { start, end } = monthBounds(month)
  const isCoord = viewer.role === 'coordinator'

  const [totals, pts, att, monthCounts, allCounts] = await Promise.all([
    teacherTotals(c.env, t.id),
    c.env.DB.prepare(
      `SELECT p.*, u.full_name AS requester_name FROM points p JOIN users u ON u.id = p.requested_by
        WHERE p.teacher_id = ? ORDER BY p.event_date DESC, p.id DESC`,
    ).bind(t.id).all<PointRow>(),
    c.env.DB.prepare('SELECT date, status FROM attendance WHERE teacher_id = ? AND date BETWEEN ? AND ?').bind(t.id, start, end).all<{ date: string; status: string }>(),
    attendanceCounts(c.env, t.id, start, end),
    attendanceCounts(c.env, t.id),
  ])
  const records = Object.fromEntries(att.results.map((x) => [x.date, x.status]))
  const give = c.req.query('give') === 'demerit' ? 'demerit' : 'merit'
  const sections = isCoord ? await listSections(c.env) : []

  return page(c, t.full_name,
    <>
      <div class="profile-head card">
        <Avatar id={t.id} name={t.full_name} photo={t.photo_key} size={84} />
        <div class="grow">
          <h1>{t.full_name}</h1>
          <p class="muted">ITS {t.its} · {t.role === 'head' ? 'Section Head' : 'Teacher'} · {t.section_name ?? 'No section'} · <StatusPill status={t.status} /></p>
          <div class="kv-grid">
            <div><span>Phone</span>{t.phone ? <a href={`tel:${t.phone}`}>{t.phone}</a> : '—'}</div>
            <div><span>Email</span>{t.email ? <a href={`mailto:${t.email}`}>{t.email}</a> : '—'}</div>
            <div><span>Date of joining</span>{fmtDate(t.date_of_joining)}</div>
            <div><span>Qualification</span>{t.qualification ?? '—'}</div>
            <div><span>Designation</span>{t.designation ?? '—'}</div>
            <div><span>Subjects</span>{t.subjects ?? '—'}</div>
            <div class="span-all"><span>Address</span>{t.address ?? '—'}</div>
          </div>
        </div>
      </div>

      <ScoreCards {...totals} />

      <div class="grid-2">
        {canGivePoints(viewer, t) ? (
          <section class="card" id="give">
            <h2>Add Merit / Demerit</h2>
            <p class="muted small">{isCoord ? 'As Main Coordinator your entry is approved immediately.' : 'Your request will be sent to the Main Coordinator for approval.'}</p>
            <form method="post" action={`/teachers/${t.id}/points`} class="stack">
              <div class="segmented">
                <label><input type="radio" name="kind" value="merit" checked={give === 'merit'} /> <span>+ Merit</span></label>
                <label><input type="radio" name="kind" value="demerit" checked={give === 'demerit'} /> <span>− Demerit</span></label>
              </div>
              <label>Number of points<input type="number" name="points" min={1} max={100} value="1" required /></label>
              <label>Date<input type="date" name="event_date" value={todayISO(tz)} max={todayISO(tz)} required /></label>
              <label>Reason<textarea name="reason" rows={2} maxlength={300} required placeholder="e.g. late coming, excellent board results"></textarea></label>
              <button class="btn btn-primary" type="submit">{isCoord ? 'Add entry' : 'Send for approval'}</button>
            </form>
          </section>
        ) : null}
        <section class="card">
          <h2>Attendance</h2>
          <AttendanceSummary {...monthCounts} label="month" />
          <AttendanceCalendar month={month} records={records} baseUrl={`/teachers/${t.id}`} today={todayISO(tz)} />
          <p class="muted small">All-time: {allCounts.present} present · {allCounts.absent} absent · {allCounts.leave} leave</p>
        </section>
      </div>

      <section class="card">
        <h2>Merit / Demerit history</h2>
        <PointsTable rows={pts.results} showStatus showRequester />
      </section>

      {isCoord ? (
        <>
          <section class="card">
            <h2>Account &amp; permissions</h2>
            <form method="post" action={`/admin/teachers/${t.id}/access`} class="form-grid">
              <label>Role
                <select name="role">
                  <option value="teacher" selected={t.role === 'teacher'}>Teacher</option>
                  <option value="head" selected={t.role === 'head'}>Section Head</option>
                </select>
              </label>
              <label>Section
                <select name="section_id">
                  <option value="">— None —</option>
                  {sections.map((s) => <option value={String(s.id)} selected={t.section_id === s.id}>{s.name}</option>)}
                </select>
              </label>
              <label>Attendance rights (Section Heads)
                <select name="attendance_scope">
                  <option value="none" selected={t.attendance_scope === 'none'}>None</option>
                  <option value="section" selected={t.attendance_scope === 'section'}>Own section</option>
                  <option value="all" selected={t.attendance_scope === 'all'}>All teachers</option>
                </select>
              </label>
              <label>Account status
                <select name="status">
                  <option value="active" selected={t.status === 'active'}>Active</option>
                  <option value="disabled" selected={t.status === 'disabled'}>Disabled</option>
                </select>
              </label>
              <div class="span-2"><button class="btn btn-primary" type="submit">Save access</button></div>
            </form>
            <div class="row-actions" style="margin-top:12px">
              <form method="post" action={`/admin/teachers/${t.id}/reset-password`} data-confirm={`Reset ${t.full_name}'s password to their first name?`}>
                <button class="btn btn-sm">Reset password to default</button>
              </form>
            </div>
          </section>
          <details class="card">
            <summary><h2 style="display:inline">Edit profile details</h2></summary>
            <ProfileForm user={t} sections={sections} mode="admin" action={`/admin/teachers/${t.id}/profile`} />
          </details>
        </>
      ) : null}
    </>,
  )
})

app.post('/teachers/:id/points', async (c) => {
  const r = await loadVisible(c)
  if (r instanceof Response) return r
  const { viewer, target } = r
  const url = `/teachers/${target.id}`
  if (!canGivePoints(viewer, target)) return back(c, url, 'err', 'You cannot give points to this teacher.')

  const body = await c.req.parseBody()
  const kind = body.kind === 'demerit' ? 'demerit' : body.kind === 'merit' ? 'merit' : null
  const points = Number(body.points)
  const date = str(body.event_date, 10)
  const reason = str(body.reason, 300)
  if (!kind) return back(c, url, 'err', 'Choose Merit or Demerit.')
  if (!Number.isInteger(points) || points < 1 || points > 100) return back(c, url, 'err', 'Points must be a whole number between 1 and 100.')
  if (!isISODate(date) || date > todayISO(c.env.TIMEZONE)) return back(c, url, 'err', 'Enter a valid date (not in the future).')
  if (!reason) return back(c, url, 'err', 'Please give a reason.')

  if (viewer.role === 'coordinator') {
    const res = await c.env.DB.prepare(
      `INSERT INTO points (teacher_id, kind, points, reason, event_date, status, requested_by, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, datetime('now'))`,
    ).bind(target.id, kind, points, reason, date, viewer.id, viewer.id).run()
    c.executionCtx.waitUntil(notifyPointsApproved(c.env, [Number(res.meta.last_row_id)]))
    return back(c, url, 'ok', `${kind === 'merit' ? '+' : '−'}${points} ${kind} added to ${target.full_name}.`)
  }
  await c.env.DB.prepare(
    `INSERT INTO points (teacher_id, kind, points, reason, event_date, status, requested_by) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).bind(target.id, kind, points, reason, date, viewer.id).run()
  return back(c, url, 'ok', `Request sent to the Main Coordinator: ${kind === 'merit' ? '+' : '−'}${points} ${kind} for ${target.full_name}.`)
})

export default app
