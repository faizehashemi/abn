import { Hono } from 'hono'
import type { AppEnv, PointRow } from '../types'
import { page, barePage, PageHead, Avatar, Empty } from '../views/layout'
import { AttendanceCalendar, AttendanceSummary, PointsTable, ProfileForm, ScoreCards, attendanceSentence } from '../views/components'
import { attendanceCounts, getSetting, listSections, pendingCounts, scoreboard, teacherTotals } from '../lib/queries'
import { canViewTeacher, getUserById, attendanceScope } from '../lib/auth'
import { hashPassword, verifyPassword } from '../lib/crypto'
import { saveProfile } from '../lib/profile'
import { back, currentMonth, fmtDate, fmtDateTime, isMonth, monthBounds, todayISO } from '../lib/util'

const app = new Hono<AppEnv>()

// ---------- onboarding: policies & consent ----------

app.get('/policies', async (c) => {
  const user = c.get('user')
  const policies = await getSetting(c.env, 'policies')
  const body = (
    <div class="auth-wrap wide">
      <div class="auth-card">
        <div class="auth-crest compact">
          <img src="/logo.jpg" alt="" />
          <h1>Organization Policies</h1>
          <p class="muted">Welcome, {user.full_name}. Please read carefully before continuing.</p>
        </div>
        <div class="policy-text">{policies}</div>
        {user.consent_at ? (
          <p class="muted">You gave consent on {fmtDateTime(user.consent_at, c.env.TIMEZONE)}.</p>
        ) : (
          <form method="post" action="/policies" class="stack">
            <label class="check">
              <input type="checkbox" name="agree" value="1" required /> I have read and understood the policies above.
            </label>
            <button class="btn btn-primary btn-block" type="submit">I Agree &amp; Give Consent</button>
          </form>
        )}
        <form method="post" action="/logout" class="center"><button class="linklike">Log out</button></form>
      </div>
    </div>
  )
  return user.consent_at ? page(c, 'Policies', body) : barePage(c, 'Policies', body)
})

app.post('/policies', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  if (body.agree !== '1') return back(c, '/policies', 'err', 'Please tick the box to confirm you have read the policies.')
  await c.env.DB.prepare(`UPDATE users SET consent_at = datetime('now') WHERE id = ? AND consent_at IS NULL`).bind(user.id).run()
  return c.redirect(user.profile_complete ? '/dashboard' : '/profile/complete', 303)
})

// ---------- onboarding: complete profile ----------

app.get('/profile/complete', async (c) => {
  const user = c.get('user')
  if (user.profile_complete) return c.redirect('/profile', 303)
  return barePage(
    c,
    'Complete your profile',
    <div class="onboard">
      <div class="onboard-head">
        <img src="/logo.jpg" alt="" />
        <div>
          <h1>Complete your profile</h1>
          <p class="muted">These details are filled once. After this you are officially added to the portal.</p>
        </div>
      </div>
      <ProfileForm user={user} sections={await listSections(c.env)} mode="complete" action="/profile/complete" />
    </div>,
  )
})

app.post('/profile/complete', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const errors = await saveProfile(c.env, user, body, 'complete')
  if (errors.length) {
    const draft = { ...user, ...pickText(body) }
    return barePage(c, 'Complete your profile',
      <div class="onboard"><ProfileForm user={draft} sections={await listSections(c.env)} mode="complete" action="/profile/complete" errors={errors} /></div>, 400)
  }
  return back(c, '/dashboard', 'ok', 'Welcome aboard! Your profile is complete.')
})

/** Keeps the user's typed values when re-rendering a form with errors. */
export function pickText(body: Record<string, string | File>) {
  const out: Record<string, any> = {}
  for (const k of ['full_name', 'phone', 'email', 'date_of_joining', 'qualification', 'designation', 'subjects', 'address']) {
    if (typeof body[k] === 'string') out[k] = body[k]
  }
  if (typeof body.section_id === 'string' && body.section_id) out.section_id = Number(body.section_id)
  return out
}

// ---------- dashboard ----------

app.get('/dashboard', async (c) => {
  const user = c.get('user')
  const tz = c.env.TIMEZONE
  const today = todayISO(tz)
  const month = currentMonth(tz)

  const { results: notices } = await c.env.DB.prepare(
    `SELECT a.*, u.full_name AS author, r.read_at FROM announcements a
       JOIN users u ON u.id = a.created_by
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
      ORDER BY a.created_at DESC LIMIT 5`,
  ).bind(user.id).all<any>()
  const unreadImportant = notices.filter((n) => n.important && !n.read_at && user.role !== 'coordinator')

  const noticeBoard = (
    <section class="card">
      <div class="card-head"><h2>Notice Board</h2><a href={user.role === 'coordinator' ? '/admin/announcements' : '/announcements'}>View all</a></div>
      {notices.length === 0 ? <Empty>No announcements yet.</Empty> : (
        <ul class="notices">
          {notices.map((n) => (
            <li class={n.important ? 'important' : ''}>
              <div class="notice-title">{n.important ? <span class="pill pill-important">Important</span> : null} {n.title}</div>
              <div class="notice-body clamp">{n.body}</div>
              <div class="muted small">{fmtDateTime(n.created_at, tz)} · {n.author}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )

  const popup = unreadImportant.length ? (
    <dialog class="modal" id="announcement-modal" open>
      <div class="modal-head">
        <img src="/logo.jpg" alt="" />
        <h2>Important Update{unreadImportant.length > 1 ? 's' : ''}</h2>
      </div>
      {unreadImportant.map((n) => (
        <article class="modal-item">
          <h3>{n.title}</h3>
          <div class="notice-body">{n.body}</div>
          <div class="muted small">{fmtDateTime(n.created_at, tz)}</div>
        </article>
      ))}
      <form method="post" action="/announcements/read">
        {unreadImportant.map((n) => <input type="hidden" name="id" value={String(n.id)} />)}
        <button class="btn btn-primary btn-block" type="submit">I have read this</button>
      </form>
    </dialog>
  ) : null

  if (user.role === 'coordinator') {
    const pending = await pendingCounts(c.env)
    const stats = await c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE status = 'active' AND role != 'coordinator') AS teachers,
              (SELECT COUNT(*) FROM sections) AS sections,
              (SELECT COUNT(*) FROM attendance WHERE date = ? AND status = 'present') AS present,
              (SELECT COUNT(*) FROM attendance WHERE date = ? AND status = 'absent') AS absent,
              (SELECT COUNT(*) FROM attendance WHERE date = ? AND status = 'leave') AS leave`,
    ).bind(today, today, today).first<any>()
    const board = (await scoreboard(c.env)).slice(0, 5)
    return page(c, 'Dashboard',
      <>
        <PageHead title={`Salaam, ${user.full_name}`} sub={`Main Coordinator · ${fmtDate(today)}`} />
        <div class="stats">
          <a class="stat stat-link" href="/admin/approvals"><span class="stat-label">Joining requests</span><span class="stat-value">{pending.users}</span></a>
          <a class="stat stat-link" href="/admin/approvals#points"><span class="stat-label">Merit/Demerit to approve</span><span class="stat-value">{pending.points}</span></a>
          <a class="stat stat-link" href="/admin/teachers"><span class="stat-label">Active teachers</span><span class="stat-value">{stats.teachers}</span></a>
          <a class="stat stat-link" href="/attendance/mark"><span class="stat-label">Today P / A / L</span><span class="stat-value">{stats.present} / {stats.absent} / {stats.leave}</span></a>
        </div>
        <div class="grid-2">
          <section class="card">
            <div class="card-head"><h2>Top of the Leaderboard</h2><a href="/leaderboard">Full leaderboard</a></div>
            <MiniBoard rows={board} />
          </section>
          {noticeBoard}
        </div>
      </>,
    )
  }

  const [totals, board, monthCounts] = await Promise.all([
    teacherTotals(c.env, user.id),
    scoreboard(c.env),
    attendanceCounts(c.env, user.id, monthBounds(month).start, monthBounds(month).end),
  ])
  const me = board.find((r) => r.id === user.id)
  let headPanel = null
  if (user.role === 'head') {
    const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM points WHERE requested_by = ? AND status = 'pending'`).bind(user.id).first<{ n: number }>()
    const team = user.section_id != null ? await scoreboard(c.env, user.section_id) : []
    headPanel = (
      <section class="card">
        <div class="card-head"><h2>My Team · {user.section_name ?? 'No section'}</h2><a href="/team">Manage team</a></div>
        <p class="muted">{team.length} teacher{team.length === 1 ? '' : 's'} · {row?.n ?? 0} of your merit/demerit requests awaiting coordinator approval</p>
        <MiniBoard rows={team.slice(0, 5)} />
        {attendanceScope(user) != null ? <a class="btn btn-sm" href="/attendance/mark">Mark today's attendance</a> : null}
      </section>
    )
  }

  return page(c, 'Dashboard',
    <>
      {popup}
      {user.using_default_password ? (
        <div class="flash flash-info">You are still using your default password. <a href="/settings">Change it in Settings</a>.</div>
      ) : null}
      <PageHead title={`Salaam, ${user.full_name}`} sub={`${user.section_name ?? ''} · ${fmtDate(today)}`} />
      <ScoreCards {...totals} rank={me?.rank ?? null} of={board.length} />
      <div class="grid-2">
        <div class="stack">
          {headPanel}
          <section class="card">
            <div class="card-head"><h2>Attendance · this month</h2><a href="/my/attendance">Calendar</a></div>
            <AttendanceSummary {...monthCounts} />
          </section>
        </div>
        {noticeBoard}
      </div>
    </>,
  )
})

function MiniBoard(props: { rows: Awaited<ReturnType<typeof scoreboard>> }) {
  if (!props.rows.length) return <Empty>No scores yet.</Empty>
  return (
    <ol class="mini-board">
      {props.rows.map((r) => (
        <li>
          <span class="rank">{r.rank}</span>
          <Avatar id={r.id} name={r.full_name} photo={r.photo_key} size={30} />
          <span class="grow">{r.full_name}<small class="muted"> · {r.section_name ?? '—'}</small></span>
          <b>{r.score}</b>
        </li>
      ))}
    </ol>
  )
}

// ---------- leaderboard ----------

app.get('/leaderboard', async (c) => {
  const user = c.get('user')
  const sections = await listSections(c.env)
  const sectionParam = c.req.query('section')
  const sectionId = sectionParam ? Number(sectionParam) : null
  const rows = await scoreboard(c.env, sectionId)
  const podium = sectionId == null ? rows.filter((r) => r.rank <= 3).slice(0, 3) : []
  return page(c, 'Leaderboard',
    <>
      <PageHead title="Leaderboard" sub="Ranked by Final Score = Total Merits − Total Demerits" actions={
        <form method="get" class="inline-form">
          <select name="section" onchange="this.form.submit()">
            <option value="">All sections</option>
            {sections.map((s) => <option value={String(s.id)} selected={s.id === sectionId}>{s.name}</option>)}
          </select>
          <noscript><button class="btn btn-sm">Filter</button></noscript>
        </form>
      } />
      {podium.length === 3 ? (
        <div class="podium">
          {[podium[1], podium[0], podium[2]].map((r, i) => (
            <div class={`podium-spot p${[2, 1, 3][i]}`}>
              <Avatar id={r.id} name={r.full_name} photo={r.photo_key} size={[56, 72, 56][i]} />
              <div class="podium-name">{r.full_name}</div>
              <div class="podium-score">{r.score}</div>
              <div class="podium-block">#{r.rank}</div>
            </div>
          ))}
        </div>
      ) : null}
      <div class="card table-wrap">
        {rows.length === 0 ? <Empty>No teachers on the leaderboard yet.</Empty> : (
          <table class="table">
            <thead><tr><th>Rank</th><th>Teacher</th><th class="hide-sm">Section</th><th class="num hide-sm">Merits</th><th class="num hide-sm">Demerits</th><th class="num">Score</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const link = canViewTeacher(user, r) && user.id !== r.id ? `/teachers/${r.id}` : null
                return (
                  <tr class={r.id === user.id ? 'me' : ''}>
                    <td><span class={`rank rank-${r.rank <= 3 ? r.rank : 'n'}`}>{r.rank}</span></td>
                    <td class="who-cell">
                      <Avatar id={r.id} name={r.full_name} photo={r.photo_key} size={30} />
                      {link ? <a href={link}>{r.full_name}</a> : <span>{r.full_name}</span>}
                      {r.id === user.id ? <span class="pill pill-me">You</span> : null}
                    </td>
                    <td class="hide-sm">{r.section_name ?? '—'}</td>
                    <td class="num merit hide-sm">+{r.merits}</td>
                    <td class="num demerit hide-sm">−{r.demerits}</td>
                    <td class="num"><b>{r.score}</b></td>
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

// ---------- my points ----------

app.get('/my/points', async (c) => {
  const user = c.get('user')
  if (user.role === 'coordinator') return c.redirect('/leaderboard', 303)
  const totals = await teacherTotals(c.env, user.id)
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, u.full_name AS requester_name FROM points p JOIN users u ON u.id = p.requested_by
      WHERE p.teacher_id = ? AND p.status = 'approved' ORDER BY p.event_date DESC, p.id DESC`,
  ).bind(user.id).all<PointRow>()
  return page(c, 'My Points',
    <>
      <PageHead title="My Merits & Demerits" sub="Only entries approved by the Main Coordinator are shown and counted." />
      <ScoreCards {...totals} />
      <section class="card"><h2>History</h2><PointsTable rows={results} you showRequester /></section>
    </>,
  )
})

// ---------- my attendance ----------

app.get('/my/attendance', async (c) => {
  const user = c.get('user')
  if (user.role === 'coordinator') return c.redirect('/attendance/report', 303)
  const tz = c.env.TIMEZONE
  const month = isMonth(c.req.query('month')) ? c.req.query('month')! : currentMonth(tz)
  const { start, end } = monthBounds(month)
  const { results } = await c.env.DB.prepare('SELECT date, status FROM attendance WHERE teacher_id = ? AND date BETWEEN ? AND ?')
    .bind(user.id, start, end).all<{ date: string; status: string }>()
  const records = Object.fromEntries(results.map((r) => [r.date, r.status]))
  const monthCounts = await attendanceCounts(c.env, user.id, start, end)
  const allTime = await attendanceCounts(c.env, user.id)
  return page(c, 'My Attendance',
    <>
      <PageHead title="My Attendance" />
      <AttendanceSummary {...monthCounts} label="this month" />
      <p class="summary-line">{attendanceSentence(records)}</p>
      <section class="card"><AttendanceCalendar month={month} records={records} baseUrl="/my/attendance" today={todayISO(tz)} /></section>
      <p class="muted">All-time: {allTime.present} present · {allTime.absent} absent · {allTime.leave} leave</p>
    </>,
  )
})

// ---------- announcements (teacher view) ----------

app.get('/announcements', async (c) => {
  const user = c.get('user')
  if (user.role === 'coordinator') return c.redirect('/admin/announcements', 303)
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, u.full_name AS author, r.read_at FROM announcements a
       JOIN users u ON u.id = a.created_by
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
      ORDER BY a.created_at DESC LIMIT 200`,
  ).bind(user.id).all<any>()
  const unread = results.filter((r) => !r.read_at).map((r) => r.id)
  return page(c, 'Announcements',
    <>
      <PageHead title="Announcements" actions={unread.length ? (
        <form method="post" action="/announcements/read">
          {unread.map((id) => <input type="hidden" name="id" value={String(id)} />)}
          <button class="btn btn-sm">Mark all as read</button>
        </form>
      ) : null} />
      {results.length === 0 ? <Empty>No announcements yet.</Empty> : (
        <div class="stack">
          {results.map((a) => (
            <article class={`card notice-card${a.important ? ' important' : ''}${a.read_at ? '' : ' unread'}`}>
              <div class="notice-title">
                {a.important ? <span class="pill pill-important">Important</span> : null}
                {!a.read_at ? <span class="pill pill-new">New</span> : null} {a.title}
              </div>
              <div class="notice-body">{a.body}</div>
              <div class="muted small">{fmtDateTime(a.created_at, c.env.TIMEZONE)} · {a.author}</div>
            </article>
          ))}
        </div>
      )}
    </>,
  )
})

app.post('/announcements/read', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody({ all: true })
  const ids = ([] as unknown[]).concat(body.id ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  if (ids.length) {
    await c.env.DB.batch(ids.map((id) =>
      c.env.DB.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id) SELECT id, ? FROM announcements WHERE id = ?').bind(user.id, id)))
  }
  return c.redirect(c.req.header('Referer')?.includes('/announcements') ? '/announcements' : '/dashboard', 303)
})

// ---------- own profile ----------

app.get('/profile', async (c) => {
  const user = c.get('user')
  if (user.role === 'coordinator') return c.redirect('/settings', 303)
  return page(c, 'My Profile',
    <>
      <PageHead title="My Profile" sub="Name, section and date of joining can only be changed by the Main Coordinator." />
      <ProfileForm user={user} sections={[]} mode="self" action="/profile" />
    </>,
  )
})

app.post('/profile', async (c) => {
  const user = c.get('user')
  if (user.role === 'coordinator') return c.redirect('/settings', 303)
  const body = await c.req.parseBody()
  const errors = await saveProfile(c.env, user, body, 'self')
  if (errors.length) {
    return page(c, 'My Profile', <><PageHead title="My Profile" /><ProfileForm user={{ ...user, ...pickText(body), full_name: user.full_name, section_id: user.section_id }} sections={[]} mode="self" action="/profile" errors={errors} /></>, 400)
  }
  return back(c, '/profile', 'ok', 'Profile updated.')
})

// ---------- settings: change password ----------

app.get('/settings', async (c) => {
  const user = c.get('user')
  return page(c, 'Settings',
    <>
      <PageHead title="Settings" />
      <section class="card narrow">
        <h2>Change password</h2>
        <p class="muted">Login ID: <b>{user.its}</b>{user.using_default_password ? ' · currently using the default password (your first name)' : ''}</p>
        <form method="post" action="/settings/password" class="stack">
          <label>Current password<input type="password" name="current" required autocomplete="current-password" /></label>
          <label>New password<input type="password" name="next" required minlength={8} autocomplete="new-password" /></label>
          <label>Confirm new password<input type="password" name="confirm" required minlength={8} autocomplete="new-password" /></label>
          <button class="btn btn-primary" type="submit">Update password</button>
        </form>
      </section>
    </>,
  )
})

app.post('/settings/password', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const current = typeof body.current === 'string' ? body.current : ''
  const next = typeof body.next === 'string' ? body.next : ''
  const confirm = typeof body.confirm === 'string' ? body.confirm : ''
  let ok = await verifyPassword(current, user.password_hash)
  if (!ok && user.using_default_password) ok = await verifyPassword(current.toLowerCase(), user.password_hash)
  if (!ok) return back(c, '/settings', 'err', 'Current password is incorrect.')
  if (next.length < 8) return back(c, '/settings', 'err', 'New password must be at least 8 characters.')
  if (next !== confirm) return back(c, '/settings', 'err', 'New passwords do not match.')
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, using_default_password = 0 WHERE id = ?').bind(await hashPassword(next), user.id).run()
  return back(c, '/settings', 'ok', 'Password updated.')
})

// ---------- photos (stored in D1, login required) ----------

app.get('/photo/:id', async (c) => {
  const viewer = c.get('user')
  const target = await getUserById(c.env, Number(c.req.param('id')))
  // Everyone may see leaderboard avatars; full records are guarded elsewhere.
  if (!target?.photo_key || !viewer) return c.notFound()
  const row = await c.env.DB.prepare('SELECT content_type, data FROM photos WHERE user_id = ?').bind(target.id).first<{ content_type: string; data: number[] | ArrayBuffer }>()
  if (!row) return c.notFound()
  return new Response(new Uint8Array(row.data as ArrayBuffer), {
    headers: {
      'Content-Type': row.content_type,
      'Cache-Control': 'private, max-age=3600',
    },
  })
})

export default app
