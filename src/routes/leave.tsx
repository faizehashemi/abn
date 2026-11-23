import { Hono } from 'hono'
import type { AppEnv, Env, LeaveKind, LeaveRow, User } from '../types'
import { page, PageHead, Empty, StatusPill } from '../views/layout'
import { AwayList, LEAVE_LABEL, leaveDates } from '../views/components'
import { requireRole } from '../lib/auth'
import { SECTION_NAMES_SQL, approvedLeaveBetween } from '../lib/queries'
import { escapeHtml, sendMails, wrapHtml } from '../lib/email'
import { notifyAnnouncement } from '../lib/notify'
import { ATT_CODE, addDays, back, dateRange, fmtDateTime, isISODate, str, todayISO, weekdayMon0 } from '../lib/util'

// Leave workflow
//   Teacher / Section Head applies (CL or EA, a date range, a reason)  -> pending
//   Main Coordinator approves                                          -> approved
//     · attendance for each day in the range (Sundays skipped) is set to CL / EA, linked by leave_id
//     · an Important announcement tells everyone who is away, so classes can be covered
//       (pop-up on dashboards + email); the teacher's reason is NOT broadcast
//   Coordinator may revoke an approved leave -> cancelled, attendance rows from it removed, everyone told
//   The applicant may withdraw a request while it is still pending.

const MAX_DAYS = 31

const app = new Hono<AppEnv>()

const LEAVE_SELECT = `SELECT l.*, u.full_name AS teacher_name, ${SECTION_NAMES_SQL} AS section_name
  FROM leave_requests l JOIN users u ON u.id = l.teacher_id`

export async function pendingLeave(env: Env): Promise<LeaveRow[]> {
  const { results } = await env.DB.prepare(`${LEAVE_SELECT} WHERE l.status = 'pending' ORDER BY l.start_date, l.created_at`).all<LeaveRow>()
  return results
}

/** Working days in a leave (Sundays are not counted). */
function workingDays(l: Pick<LeaveRow, 'start_date' | 'end_date'>): string[] {
  return dateRange(l.start_date, l.end_date).filter((d) => weekdayMon0(d) !== 6)
}

function dayCount(l: Pick<LeaveRow, 'start_date' | 'end_date'>): string {
  const n = workingDays(l).length
  return `${n} day${n === 1 ? '' : 's'}`
}

// ---------- coordinator queue (rendered on /admin/approvals) ----------

export function LeaveQueue(props: { rows: LeaveRow[]; tz: string }) {
  return (
    <section class="card" id="leave">
      <div class="card-head"><h2>Leave applications <span class="badge">{props.rows.length}</span></h2><a href="/leave">All leave</a></div>
      {props.rows.length === 0 ? <Empty>No pending leave applications.</Empty> : (
        <div class="queue">
          {props.rows.map((l) => (
            <div class="queue-item">
              <span class={`code-chip code-${l.kind}`}>{ATT_CODE[l.kind]}</span>
              <div class="grow">
                <div>
                  <a href={`/teachers/${l.teacher_id}`}><b>{l.teacher_name}</b></a> requests <b>{LEAVE_LABEL[l.kind]}</b> for <b>{leaveDates(l)}</b> ({dayCount(l)})
                </div>
                <div class="muted small">Reason: {l.reason}</div>
                <div class="muted small">{l.section_name ?? 'No section'} · applied {fmtDateTime(l.created_at, props.tz)}</div>
              </div>
              <form method="post" action={`/leave/${l.id}/review`} class="inline-form">
                <input name="note" placeholder="Note (optional)" maxlength={200} />
                <button class="btn btn-sm btn-merit" name="decision" value="approved">Approve</button>
                <button class="btn btn-sm btn-demerit" name="decision" value="rejected">Reject</button>
              </form>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ---------- leave page (everyone) ----------

app.get('/', async (c) => {
  const user = c.get('user')
  const tz = c.env.TIMEZONE
  const today = todayISO(tz)
  const isCoord = user.role === 'coordinator'
  const upcoming = await approvedLeaveBetween(c.env, today, addDays(today, 30))

  let mine: LeaveRow[] = []
  let decided: LeaveRow[] = []
  if (isCoord) {
    decided = (await c.env.DB.prepare(`${LEAVE_SELECT} WHERE l.status != 'pending' ORDER BY l.start_date DESC LIMIT 60`).all<LeaveRow>()).results
  } else {
    mine = (await c.env.DB.prepare(`${LEAVE_SELECT} WHERE l.teacher_id = ? ORDER BY l.start_date DESC LIMIT 60`).bind(user.id).all<LeaveRow>()).results
  }

  return page(c, 'Leave',
    <>
      <PageHead title="Leave" sub={isCoord ? 'Approve applications on the Approvals page. Approved leave is announced to all staff.' : 'Apply for Casual Leave (CL) or Evaluation Absent (EA). Once approved, all staff are told so your classes can be covered.'}
        actions={isCoord ? <a class="btn btn-primary btn-sm" href="/admin/approvals#leave">Pending applications</a> : null} />

      <div class="grid-2">
        {!isCoord ? (
          <section class="card">
            <h2>Apply for leave</h2>
            <form method="post" action="/leave" class="stack">
              <div class="segmented">
                <label><input type="radio" name="kind" value="casual_leave" checked /> <span>CL · Casual Leave</span></label>
                <label><input type="radio" name="kind" value="eval_absent" /> <span>EA · Evaluation Absent</span></label>
              </div>
              <div class="form-grid">
                <label>From<input type="date" name="start_date" min={today} value={today} required /></label>
                <label>To<input type="date" name="end_date" min={today} value={today} required /></label>
              </div>
              <label>Reason<textarea name="reason" rows={2} maxlength={300} required placeholder="Seen only by the Main Coordinator"></textarea></label>
              <p class="hint">Up to {MAX_DAYS} days per application. Sundays are not counted.</p>
              <button class="btn btn-primary" type="submit">Send for approval</button>
            </form>
          </section>
        ) : null}

        <section class="card">
          <h2>Who's away · next 30 days</h2>
          <AwayList rows={upcoming} today={today} empty="No approved leave in the next 30 days." />
        </section>
      </div>

      {!isCoord ? (
        <section class="card">
          <h2>My applications</h2>
          {mine.length === 0 ? <Empty>You have not applied for leave yet.</Empty> : <LeaveTable rows={mine} tz={tz} today={today} viewer={user} />}
        </section>
      ) : (
        <section class="card">
          <h2>Decided applications</h2>
          {decided.length === 0 ? <Empty>No leave decided yet.</Empty> : <LeaveTable rows={decided} tz={tz} today={today} viewer={user} showName />}
        </section>
      )}
    </>,
  )
})

function LeaveTable(props: { rows: LeaveRow[]; tz: string; today: string; viewer: User; showName?: boolean }) {
  return (
    <div class="table-wrap">
      <table class="table">
        <thead><tr>{props.showName ? <th>Teacher</th> : null}<th>Type</th><th>Dates</th><th>Reason</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {props.rows.map((l) => (
            <tr>
              {props.showName ? <td><a href={`/teachers/${l.teacher_id}`}>{l.teacher_name}</a></td> : null}
              <td><span class={`code-chip code-${l.kind}`}>{ATT_CODE[l.kind]}</span></td>
              <td>{leaveDates(l)}<div class="muted small">{dayCount(l)}</div></td>
              <td>{l.reason}{l.review_note ? <div class="muted small">Coordinator: {l.review_note}</div> : null}</td>
              <td><StatusPill status={l.status} /></td>
              <td>
                {l.status === 'pending' && l.teacher_id === props.viewer.id ? (
                  <form method="post" action={`/leave/${l.id}/cancel`} data-confirm="Withdraw this leave application?"><button class="btn btn-sm">Withdraw</button></form>
                ) : null}
                {l.status === 'approved' && props.viewer.role === 'coordinator' && l.end_date >= props.today ? (
                  <form method="post" action={`/leave/${l.id}/revoke`} data-confirm={`Cancel ${l.teacher_name}'s approved leave? Staff will be told.`}><button class="btn btn-sm btn-demerit">Cancel leave</button></form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------- apply / withdraw (teachers & section heads) ----------

app.post('/', async (c) => {
  const user = c.get('user')
  if (user.role === 'coordinator') return c.redirect('/leave', 303)
  const body = await c.req.parseBody()
  const kind: LeaveKind | null = body.kind === 'casual_leave' || body.kind === 'eval_absent' ? body.kind : null
  const start = str(body.start_date, 10)
  const end = str(body.end_date, 10)
  const reason = str(body.reason, 300)
  const today = todayISO(c.env.TIMEZONE)

  if (!kind) return back(c, '/leave', 'err', 'Choose CL or EA.')
  if (!isISODate(start) || !isISODate(end)) return back(c, '/leave', 'err', 'Enter valid dates.')
  if (start < today) return back(c, '/leave', 'err', 'Leave can only be applied for today or later. Ask the Coordinator to record past days.')
  if (end < start) return back(c, '/leave', 'err', '"To" date must be on or after the "From" date.')
  if (dateRange(start, end).length > MAX_DAYS) return back(c, '/leave', 'err', `Apply for at most ${MAX_DAYS} days at a time.`)
  if (!workingDays({ start_date: start, end_date: end }).length) return back(c, '/leave', 'err', 'The dates you chose are all Sundays.')
  if (!reason) return back(c, '/leave', 'err', 'Please give a reason.')

  const overlap = await c.env.DB.prepare(
    `SELECT id FROM leave_requests WHERE teacher_id = ? AND status IN ('pending', 'approved') AND start_date <= ? AND end_date >= ?`,
  ).bind(user.id, end, start).first()
  if (overlap) return back(c, '/leave', 'err', 'You already have a pending or approved leave that overlaps these dates.')

  await c.env.DB.prepare('INSERT INTO leave_requests (teacher_id, kind, start_date, end_date, reason) VALUES (?, ?, ?, ?, ?)')
    .bind(user.id, kind, start, end, reason).run()
  return back(c, '/leave', 'ok', `Leave application sent to the Main Coordinator: ${LEAVE_LABEL[kind]}, ${leaveDates({ start_date: start, end_date: end })}.`)
})

app.post('/:id/cancel', async (c) => {
  const user = c.get('user')
  const res = await c.env.DB.prepare(`UPDATE leave_requests SET status = 'cancelled' WHERE id = ? AND teacher_id = ? AND status = 'pending'`)
    .bind(Number(c.req.param('id')), user.id).run()
  return back(c, '/leave', res.meta.changes ? 'ok' : 'err', res.meta.changes ? 'Leave application withdrawn.' : 'Only pending applications can be withdrawn.')
})

// ---------- coordinator: approve / reject / revoke ----------

async function getLeave(env: Env, id: number) {
  return env.DB.prepare(`${LEAVE_SELECT} WHERE l.id = ?`).bind(id).first<LeaveRow & { email?: string }>()
}

/** Pop-up announcement + email to everyone, without the teacher's private reason. */
async function broadcast(env: Env, by: number, title: string, text: string) {
  const res = await env.DB.prepare('INSERT INTO announcements (title, body, important, created_by) VALUES (?, ?, 1, ?)').bind(title, text, by).run()
  await notifyAnnouncement(env, Number(res.meta.last_row_id), title)
}

async function tellApplicant(env: Env, l: LeaveRow, decision: string, note: string | null) {
  const u = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(l.teacher_id).first<{ email: string | null }>()
  if (!u?.email) return
  const what = `${LEAVE_LABEL[l.kind]} for ${leaveDates(l)}`
  await sendMails(env, [{
    to: u.email,
    subject: `Leave ${decision}: ${what}`,
    text: `Dear ${l.teacher_name},\n\nYour application for ${what} has been ${decision}.${note ? `\nNote: ${note}` : ''}\n\n${env.APP_URL}/leave`,
    html: wrapHtml(env, `Leave ${decision}`, `<p>Dear ${escapeHtml(l.teacher_name ?? '')},</p><p>Your application for <b>${escapeHtml(what)}</b> has been <b>${decision}</b>.</p>${note ? `<p>Note: ${escapeHtml(note)}</p>` : ''}`),
  }])
}

app.post('/:id/review', requireRole('coordinator'), async (c) => {
  const me = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : null
  const note = str(body.note, 200) || null
  const l = await getLeave(c.env, id)
  if (!decision || !l || l.status !== 'pending') return back(c, '/admin/approvals#leave', 'err', 'This application is no longer pending.')

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(`UPDATE leave_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ? AND status = 'pending'`)
      .bind(decision, me.id, note, id),
  ]
  if (decision === 'approved') {
    for (const d of workingDays(l)) {
      stmts.push(c.env.DB.prepare(
        `INSERT INTO attendance (teacher_id, date, status, marked_by, leave_id, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(teacher_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by, leave_id = excluded.leave_id, updated_at = excluded.updated_at`,
      ).bind(l.teacher_id, d, l.kind, me.id, id))
    }
  }
  await c.env.DB.batch(stmts)

  c.executionCtx.waitUntil((async () => {
    await tellApplicant(c.env, l, decision, note)
    if (decision === 'approved') {
      const who = `${l.teacher_name}${l.section_name ? ` (${l.section_name})` : ''}`
      await broadcast(c.env, me.id,
        `On leave: ${l.teacher_name} · ${leaveDates(l)}`,
        `${who} will be away on ${leaveDates(l)} (${dayCount(l)}) — ${LEAVE_LABEL[l.kind]}.\n\nPlease make the necessary arrangements to cover their classes and duties.`)
    }
  })())
  return back(c, '/admin/approvals#leave', 'ok', decision === 'approved'
    ? `Leave approved for ${l.teacher_name}. Attendance marked ${ATT_CODE[l.kind]} and all staff notified.`
    : `Leave rejected for ${l.teacher_name}.`)
})

app.post('/:id/revoke', requireRole('coordinator'), async (c) => {
  const me = c.get('user')
  const id = Number(c.req.param('id'))
  const l = await getLeave(c.env, id)
  if (!l || l.status !== 'approved') return back(c, '/leave', 'err', 'Only approved leave can be cancelled.')
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE leave_requests SET status = 'cancelled', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`).bind(me.id, id),
    c.env.DB.prepare('DELETE FROM attendance WHERE leave_id = ?').bind(id),
  ])
  c.executionCtx.waitUntil((async () => {
    await tellApplicant(c.env, l, 'cancelled', null)
    await broadcast(c.env, me.id,
      `Leave cancelled: ${l.teacher_name} · ${leaveDates(l)}`,
      `${l.teacher_name}'s leave for ${leaveDates(l)} has been cancelled. They are expected on duty as normal.`)
  })())
  return back(c, '/leave', 'ok', `Leave cancelled for ${l.teacher_name}. Attendance entries removed and staff notified.`)
})

export default app
