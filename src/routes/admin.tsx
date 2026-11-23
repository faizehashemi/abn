import { Hono } from 'hono'
import type { AppEnv, Env, PointRow, User } from '../types'
import { page, PageHead, Avatar, Empty, StatusPill } from '../views/layout'
import { ProfileForm, RoleOptions, SectionChecks, SectionSelect } from '../views/components'
import { USER_SELECT, getUserById, hydrateUser, parseRoleChoice, requireRole, roleLabel } from '../lib/auth'
import { defaultPassword, hashPassword } from '../lib/crypto'
import { SECTION_NAMES_SQL, headTitleSql, inSections, listSections, listWings, parseSectionFilter, scoreboard, setUserSections, validSectionIds } from '../lib/queries'
import { idList, one, saveProfile } from '../lib/profile'
import { LeaveQueue, pendingLeave } from './leave'
import { sendMails, wrapHtml, escapeHtml, emailProvider } from '../lib/email'
import { notifyAnnouncement } from '../lib/notify'
import { EMAIL_RE, ITS_RE, back, csvCell, fmtDate, fmtDateTime, parseCSV, str } from '../lib/util'
import { pickText } from './me'

const app = new Hono<AppEnv>()
app.use('*', requireRole('coordinator'))

// ---------- email helpers ----------

export async function notifyPointsApproved(env: Env, ids: number[]) {
  if (!ids.length) return
  const { results } = await env.DB.prepare(
    `SELECT p.*, u.email, u.full_name AS teacher_name FROM points p JOIN users u ON u.id = p.teacher_id
      WHERE p.id IN (${ids.map(() => '?').join(',')}) AND p.status = 'approved' AND u.email IS NOT NULL`,
  ).bind(...ids).all<PointRow & { email: string }>()
  await sendMails(env, results.map((p) => {
    const label = `${p.kind === 'merit' ? '+' : '−'}${p.points} ${p.kind === 'merit' ? 'Merit' : 'Demerit'}`
    const text = `Dear ${p.teacher_name},\n\nYou received ${label} on ${fmtDate(p.event_date)} for: ${p.reason}.\n\nView your record: ${env.APP_URL}/my/points`
    return {
      to: p.email,
      subject: `${label} recorded on the ABN Teacher Portal`,
      text,
      html: wrapHtml(env, `${label} recorded`, `<p>Dear ${escapeHtml(p.teacher_name ?? '')},</p><p>You received <b>${label}</b> on ${fmtDate(p.event_date)} for: <i>${escapeHtml(p.reason)}</i>.</p>`),
    }
  }))
}

// ---------- approval queue ----------

app.get('/approvals', async (c) => {
  const sections = await listSections(c.env)
  const wings = await listWings(c.env)
  const users = (await c.env.DB.prepare(`${USER_SELECT} WHERE u.status = 'pending' ORDER BY u.created_at`).all<any>()).results.map((r) => hydrateUser(r))
  const { results: pts } = await c.env.DB.prepare(
    `SELECT p.*, u.full_name AS teacher_name, u.its AS teacher_its, r.full_name AS requester_name, r.role AS requester_role, r.head_level AS requester_level, ${headTitleSql('r')} AS requester_title, ${SECTION_NAMES_SQL} AS section_name
       FROM points p JOIN users u ON u.id = p.teacher_id JOIN users r ON r.id = p.requested_by
      WHERE p.status = 'pending' ORDER BY p.created_at`,
  ).all<PointRow & { requester_role: string; requester_level: string | null; requester_title: string | null }>()
  const leave = await pendingLeave(c.env)
  const tz = c.env.TIMEZONE

  return page(c, 'Approvals',
    <>
      <PageHead title="Approval Queue" />
      <section class="card">
        <div class="card-head"><h2>New joining requests <span class="badge">{users.length}</span></h2></div>
        {users.length === 0 ? <Empty>No pending joining requests.</Empty> : (
          <div class="queue">
            {users.map((u) => (
              <div class="queue-item">
                <div class="grow">
                  <b>{u.full_name}</b> <span class="muted">· ITS {u.its}</span>
                  <div class="muted small">Requested {fmtDateTime(u.created_at, tz)}{u.section_name ? ` · wants ${u.section_name}` : ''}</div>
                </div>
                <form method="post" action={`/admin/users/${u.id}/approve`} class="inline-form approve-form">
                  <SectionChecks sections={sections} selected={u.section_ids} />
                  <select name="role" aria-label="Role">
                    <RoleOptions wings={wings} />
                  </select>
                  <button class="btn btn-sm btn-merit">Approve</button>
                </form>
                <form method="post" action={`/admin/users/${u.id}/reject`} data-confirm={`Reject ${u.full_name}'s request?`}>
                  <button class="btn btn-sm btn-demerit">Reject</button>
                </form>
              </div>
            ))}
          </div>
        )}
      </section>

      <section class="card" id="points">
        <div class="card-head">
          <h2>Merit / Demerit requests <span class="badge">{pts.length}</span></h2>
          {pts.length > 1 ? (
            <form method="post" action="/admin/points/review" data-confirm={`Approve all ${pts.length} requests?`}>
              {pts.map((p) => <input type="hidden" name="id" value={String(p.id)} />)}
              <input type="hidden" name="decision" value="approved" />
              <button class="btn btn-sm">Approve all</button>
            </form>
          ) : null}
        </div>
        {pts.length === 0 ? <Empty>No pending merit/demerit requests.</Empty> : (
          <div class="queue">
            {pts.map((p) => (
              <div class={`queue-item point-${p.kind}`}>
                <span class={`point-amount ${p.kind}`}>{p.kind === 'merit' ? '+' : '−'}{p.points}</span>
                <div class="grow">
                  <div>
                    {roleLabel({ role: p.requester_role, head_level: p.requester_level, head_title: p.requester_title })} <b>{p.requester_name}</b> wants to give <b>{p.kind === 'merit' ? '+' : '−'}{p.points} {p.kind === 'merit' ? 'Merit' : 'Demerit'}</b> to{' '}
                    <a href={`/teachers/${p.teacher_id}`}><b>{p.teacher_name}</b></a> for <i>{p.reason}</i>
                  </div>
                  <div class="muted small">{p.section_name ?? 'No section'} · event on {fmtDate(p.event_date)} · requested {fmtDateTime(p.created_at, tz)}</div>
                </div>
                <form method="post" action="/admin/points/review" class="inline-form">
                  <input type="hidden" name="id" value={String(p.id)} />
                  <input name="note" placeholder="Note (optional)" maxlength={200} />
                  <button class="btn btn-sm btn-merit" name="decision" value="approved">Approve</button>
                  <button class="btn btn-sm btn-demerit" name="decision" value="rejected">Reject</button>
                </form>
              </div>
            ))}
          </div>
        )}
      </section>

      <LeaveQueue rows={leave} tz={tz} />
    </>,
  )
})

app.post('/users/:id/approve', async (c) => {
  const me = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody({ all: true })
  const sectionIds = await validSectionIds(c.env, idList(body, 'section_ids'))
  const { role, head_level } = parseRoleChoice(one(body, 'role'))
  const res = await c.env.DB.prepare(
    `UPDATE users SET status = 'active', role = ?, head_level = ?, approved_at = datetime('now'), approved_by = ? WHERE id = ? AND status = 'pending'`,
  ).bind(role, head_level, me.id, id).run()
  if (res.meta.changes) await c.env.DB.batch(setUserSections(c.env, id, sectionIds))
  return back(c, '/admin/approvals', res.meta.changes ? 'ok' : 'err', res.meta.changes ? 'Teacher approved. They can now log in.' : 'Request not found.')
})

app.post('/users/:id/reject', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare(`UPDATE users SET status = 'rejected' WHERE id = ? AND status = 'pending'`).bind(id).run()
  return back(c, '/admin/approvals', 'ok', 'Request rejected.')
})

app.post('/points/review', async (c) => {
  const me = c.get('user')
  const body = await c.req.parseBody({ all: true })
  const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : null
  const ids = ([] as unknown[]).concat(body.id ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  const note = str(Array.isArray(body.note) ? body.note[0] : body.note, 200) || null
  if (!decision || !ids.length) return back(c, '/admin/approvals#points', 'err', 'Nothing to review.')
  await c.env.DB.batch(ids.map((id) =>
    c.env.DB.prepare(
      `UPDATE points SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ? AND status = 'pending'`,
    ).bind(decision, me.id, note, id)))
  if (decision === 'approved') c.executionCtx.waitUntil(notifyPointsApproved(c.env, ids))
  return back(c, '/admin/approvals#points', 'ok', `${ids.length} request${ids.length === 1 ? '' : 's'} ${decision}.`)
})

// ---------- teachers ----------

app.get('/teachers', async (c) => {
  const sections = await listSections(c.env)
  const q = str(c.req.query('q'), 100)
  const sectionParam = c.req.query('section') ?? ''
  const filterIds = parseSectionFilter(sectionParam, sections)
  const status = ['active', 'pending', 'rejected', 'disabled'].includes(c.req.query('status') ?? '') ? c.req.query('status')! : 'active'
  const where: string[] = [`u.role != 'coordinator'`, 'u.status = ?']
  const args: unknown[] = [status]
  if (filterIds) { const f = inSections(filterIds); where.push(f.sql); args.push(...f.args) }
  if (q) { where.push('(u.full_name LIKE ? OR u.its LIKE ?)'); args.push(`%${q}%`, `%${q}%`) }
  const { results } = await c.env.DB.prepare(`${USER_SELECT} WHERE ${where.join(' AND ')} ORDER BY u.full_name COLLATE NOCASE`).bind(...args).all<User>()
  const scores = new Map((await scoreboard(c.env)).map((r) => [r.id, r]))

  return page(c, 'Teachers',
    <>
      <PageHead title="Teachers" sub={`${results.length} shown`} actions={
        <>
          <a class="btn btn-primary btn-sm" href="/admin/teachers/new">+ Add teachers</a>
          <a class="btn btn-sm" href="/admin/teachers/export">Export CSV</a>
        </>
      } />
      <form method="get" class="filters card">
        <input name="q" value={q} placeholder="Search name or ITS" />
        <SectionSelect sections={sections} value={sectionParam} />
        <select name="status">
          {['active', 'pending', 'disabled', 'rejected'].map((s) => <option value={s} selected={s === status}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
        <button class="btn btn-sm">Filter</button>
      </form>
      <div class="card table-wrap">
        {results.length === 0 ? <Empty>No teachers match.</Empty> : (
          <table class="table">
            <thead><tr><th>Teacher</th><th>ITS</th><th>Section</th><th>Role</th><th>Onboarding</th><th class="num">Score</th></tr></thead>
            <tbody>
              {results.map((u) => {
                const s = scores.get(u.id)
                return (
                  <tr>
                    <td class="who-cell"><Avatar id={u.id} name={u.full_name} photo={u.photo_key} size={30} /><a href={`/teachers/${u.id}`}>{u.full_name}</a></td>
                    <td>{u.its}</td>
                    <td>{u.section_name ?? '—'}</td>
                    <td>{u.role === 'head' ? <span class="pill pill-head">{roleLabel(u)}{u.attendance_scope !== 'none' ? ' · Att.' : ''}</span> : 'Teacher'}</td>
                    <td>{u.profile_complete ? <span class="pill pill-approved">Complete</span> : u.consent_at ? <span class="pill pill-pending">Profile pending</span> : <span class="pill pill-pending">Not consented</span>}</td>
                    <td class="num">{s ? <b>{s.score}</b> : '—'}</td>
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

app.get('/teachers/export', async (c) => {
  const { results } = await c.env.DB.prepare(`${USER_SELECT} WHERE u.role != 'coordinator' ORDER BY u.full_name`).all<User>()
  const scores = new Map((await scoreboard(c.env)).map((r) => [r.id, r]))
  const head = ['ITS', 'Full Name', 'Section', 'Role', 'Status', 'Phone', 'Email', 'Date of Joining', 'Qualification', 'Designation', 'Subjects', 'Address', 'Merits', 'Demerits', 'Score']
  const lines = [head.join(',')].concat(results.map((u) => {
    const s = scores.get(u.id)
    return [u.its, u.full_name, u.section_name, u.role, u.status, u.phone, u.email, u.date_of_joining, u.qualification, u.designation, u.subjects, u.address, s?.merits ?? 0, s?.demerits ?? 0, s?.score ?? 0].map(csvCell).join(',')
  }))
  return c.body(lines.join('\r\n'), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="abn-teachers.csv"' })
})

app.get('/teachers/new', async (c) => {
  const sections = await listSections(c.env)
  const wings = await listWings(c.env)
  return page(c, 'Add teachers',
    <>
      <PageHead title="Add teachers" sub="Teachers added here skip the approval queue. They log in with their ITS number and first name as password." />
      <div class="grid-2">
        <section class="card">
          <h2>Add one teacher</h2>
          <form method="post" action="/admin/teachers/new" class="stack">
            <label>ITS Number<input name="its" required pattern="\d{8}" maxlength={8} inputmode="numeric" /></label>
            <label>Full Name<input name="full_name" required minlength={3} maxlength={100} /></label>
            <fieldset class="fieldset">
              <legend>Section(s)</legend>
              <SectionChecks sections={sections} selected={[]} />
            </fieldset>
            <label>Role
              <select name="role"><RoleOptions wings={wings} /></select>
            </label>
            <button class="btn btn-primary">Add teacher</button>
          </form>
        </section>
        <section class="card">
          <h2>Bulk import (CSV)</h2>
          <p class="muted small">One teacher per line: <code>ITS,Full Name,Section,Role</code>. Section and Role are optional; Role is <code>teacher</code>, <code>awwal</code> (1st in charge) or <code>saani</code> (2nd in charge); for several sections separate them with <code>;</code> (e.g. <code>Hifz Stage 1;Hifz Stage 2</code>). Unknown sections are created automatically. A header row is ignored.</p>
          <form method="post" action="/admin/teachers/import" enctype="multipart/form-data" class="stack">
            <label>CSV file<input type="file" name="file" accept=".csv,text/csv" /></label>
            <label>…or paste rows
              <textarea name="text" rows={7} placeholder={'30412345,M Huzaifa Master,Hadi ashar,awwal\n30498765,M Taha Kamlapur,Hadi ashar;awwala alif,saani\n30411111,M Mustafa Kapadia,awwala alif,teacher'}></textarea>
            </label>
            <button class="btn btn-primary">Import</button>
          </form>
        </section>
      </div>
    </>,
  )
})

/** CSV role column: teacher | head / awwal | deputy / saani. */
function csvRole(v: string): string {
  const r = v.trim().toLowerCase().replace(/[^a-z]/g, '')
  if (r === 'head' || r === 'awwal' || r === 'masoolawwal') return 'head'
  if (r === 'deputy' || r === 'saani' || r === 'masoolsaani' || r === 'head2') return 'head2'
  return 'teacher'
}

async function addTeacher(env: Env, approverId: number, its: string, fullName: string, sectionIds: number[], choice: string): Promise<string | null> {
  const { role, head_level } = parseRoleChoice(choice)
  if (!ITS_RE.test(its)) return `${its || '(blank)'}: ITS must be 8 digits`
  if (fullName.length < 3) return `${its}: name is required`
  const exists = await env.DB.prepare('SELECT status FROM users WHERE its = ?').bind(its).first<{ status: string }>()
  if (exists && exists.status !== 'rejected') return `${its}: already registered (${exists.status})`
  const hash = await hashPassword(defaultPassword(fullName, its))
  if (exists) {
    await env.DB.prepare(
      `UPDATE users SET full_name = ?, role = ?, head_level = ?, password_hash = ?, using_default_password = 1, status = 'active', approved_at = datetime('now'), approved_by = ? WHERE its = ?`,
    ).bind(fullName, role, head_level, hash, approverId, its).run()
  } else {
    await env.DB.prepare(
      `INSERT INTO users (its, full_name, role, head_level, password_hash, status, approved_at, approved_by) VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), ?)`,
    ).bind(its, fullName, role, head_level, hash, approverId).run()
  }
  const user = await env.DB.prepare('SELECT id FROM users WHERE its = ?').bind(its).first<{ id: number }>()
  await env.DB.batch(setUserSections(env, user!.id, sectionIds))
  return null
}

app.post('/teachers/new', async (c) => {
  const body = await c.req.parseBody({ all: true })
  const its = str(one(body, 'its'), 20)
  const name = str(one(body, 'full_name'), 100).replace(/\s+/g, ' ')
  const sectionIds = await validSectionIds(c.env, idList(body, 'section_ids'))
  const err = await addTeacher(c.env, c.get('user').id, its, name, sectionIds, String(one(body, 'role') ?? 'teacher'))
  if (err) return back(c, '/admin/teachers/new', 'err', err)
  return back(c, '/admin/teachers/new', 'ok', `${name} added. Login: ${its} / ${defaultPassword(name, its)}`)
})

app.post('/teachers/import', async (c) => {
  const body = await c.req.parseBody()
  let text = typeof body.text === 'string' ? body.text : ''
  if (body.file instanceof File && body.file.size > 0) text = await body.file.text()
  const rows = parseCSV(text).filter((r) => !/^its/i.test(r[0] ?? ''))
  if (!rows.length) return back(c, '/admin/teachers/new', 'err', 'No rows found.')
  if (rows.length > 500) return back(c, '/admin/teachers/new', 'err', 'Please import at most 500 rows at a time.')

  const sections = new Map((await listSections(c.env)).map((s) => [s.name.toLowerCase(), s.id]))
  const errors: string[] = []
  let added = 0
  for (const [its = '', name = '', sectionNames = '', role = ''] of rows) {
    const sectionIds: number[] = []
    for (const sectionName of sectionNames.split(/[;|]/).map((s) => s.trim()).filter(Boolean)) {
      let sectionId = sections.get(sectionName.toLowerCase())
      if (sectionId == null) {
        const res = await c.env.DB.prepare('INSERT INTO sections (name) VALUES (?)').bind(sectionName).run()
        sectionId = Number(res.meta.last_row_id)
        sections.set(sectionName.toLowerCase(), sectionId)
      }
      sectionIds.push(sectionId)
    }
    const err = await addTeacher(c.env, c.get('user').id, its, name.replace(/\s+/g, ' '), sectionIds, csvRole(role))
    if (err) errors.push(err); else added++
  }
  const msg = `Imported ${added} teacher${added === 1 ? '' : 's'}.` + (errors.length ? ` Skipped ${errors.length}: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? '…' : ''}` : '')
  return back(c, '/admin/teachers/new', errors.length && !added ? 'err' : 'ok', msg)
})

app.post('/teachers/:id/access', async (c) => {
  const id = Number(c.req.param('id'))
  const target = await getUserById(c.env, id)
  if (!target || target.role === 'coordinator') return c.notFound()
  const raw = await c.req.parseBody({ all: true })
  const body = Object.fromEntries(Object.keys(raw).map((k) => [k, one(raw, k)]))
  const { role, head_level } = parseRoleChoice(body.role, true)
  const sectionIds = await validSectionIds(c.env, idList(raw, 'section_ids'))
  const scope = role === 'head' && (body.attendance_scope === 'section' || body.attendance_scope === 'all') ? body.attendance_scope : 'none'
  const status = body.status === 'disabled' ? 'disabled' : 'active'
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET role = ?, head_level = ?, attendance_scope = ?, status = ? WHERE id = ?').bind(role, head_level, scope, status, id),
    ...setUserSections(c.env, id, sectionIds),
  ])
  if (status === 'disabled') await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run()
  if (role === 'coordinator') return back(c, '/settings', 'ok', `${target.full_name} now has Principal (full) access. Manage Principals here.`)
  return back(c, `/teachers/${id}`, 'ok', 'Access updated.')
})

app.post('/teachers/:id/reset-password', async (c) => {
  const id = Number(c.req.param('id'))
  const target = await getUserById(c.env, id)
  if (!target || target.role === 'coordinator') return c.notFound()
  const pw = defaultPassword(target.full_name, target.its)
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, using_default_password = 1 WHERE id = ?').bind(await hashPassword(pw), id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
  ])
  return back(c, `/teachers/${id}`, 'ok', `Password reset. ${target.full_name} can log in with "${pw}".`)
})

app.post('/teachers/:id/profile', async (c) => {
  const id = Number(c.req.param('id'))
  const target = await getUserById(c.env, id)
  if (!target || target.role === 'coordinator') return c.notFound()
  const body = await c.req.parseBody({ all: true })
  const errors = await saveProfile(c.env, target, body, 'admin')
  if (errors.length) {
    return page(c, 'Edit profile',
      <><PageHead title={`Edit ${target.full_name}`} /><ProfileForm user={{ ...target, ...pickText(body) }} sections={await listSections(c.env)} mode="admin" action={`/admin/teachers/${id}/profile`} errors={errors} /></>, 400)
  }
  return back(c, `/teachers/${id}`, 'ok', 'Profile updated.')
})

// ---------- principals ----------

app.post('/principals/:id/remove', async (c) => {
  const me = c.get('user')
  const id = Number(c.req.param('id'))
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'coordinator' AND status = 'active'`).first<{ n: number }>()
  if ((count?.n ?? 0) <= 1) return back(c, '/settings', 'err', 'There must always be at least one Principal.')
  const res = await c.env.DB.prepare(`UPDATE users SET role = 'teacher', head_level = NULL WHERE id = ? AND role = 'coordinator'`).bind(id).run()
  if (!res.meta.changes) return back(c, '/settings', 'err', 'Not found.')
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run()
  if (id === me.id) return c.redirect('/login', 303)
  return back(c, '/settings', 'ok', 'Principal access removed.')
})

// ---------- wings & sections ----------
// Hierarchy: Principal → Wing (e.g. Tahfeez, Academics) → Section (with Section Head) → Teachers.

app.get('/sections', async (c) => {
  const wings = await listWings(c.env)
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.wing_id, s.grades, s.sort, w.name AS wing_name, w.active AS wing_active,
            (SELECT COUNT(*) FROM user_sections us JOIN users u ON u.id = us.user_id WHERE us.section_id = s.id AND u.status = 'active') AS members,
            (SELECT GROUP_CONCAT(label, ', ') FROM (
               SELECT u.full_name || ' (' || CASE WHEN u.head_level = 'saani' THEN COALESCE(w.deputy_title, 'Deputy Section Head') ELSE COALESCE(w.head_title, 'Section Head') END || ')' AS label
                 FROM user_sections us JOIN users u ON u.id = us.user_id
                WHERE us.section_id = s.id AND u.role = 'head' AND u.status = 'active'
                ORDER BY CASE WHEN u.head_level = 'saani' THEN 2 ELSE 1 END, u.full_name)) AS heads
       FROM sections s LEFT JOIN wings w ON w.id = s.wing_id
      ORDER BY COALESCE(w.sort, 999), w.name, s.sort, s.name COLLATE NOCASE`,
  ).all<any>()
  const groups = [
    ...wings.map((w) => ({ wing: w, rows: results.filter((r) => r.wing_id === w.id) })),
    ...(results.some((r) => r.wing_id == null) ? [{ wing: null, rows: results.filter((r) => r.wing_id == null) }] : []),
  ]
  const WingSelect = (p: { value: number | null }) => (
    <select name="wing_id" aria-label="Wing">
      {wings.map((w) => <option value={String(w.id)} selected={p.value === w.id}>{w.name}</option>)}
    </select>
  )

  return page(c, 'Sections',
    <>
      <PageHead title="Wings & Sections" sub="Principal → Wing → Section (1st and 2nd in charge, e.g. Mas'ool Awwal / Mas'ool Saani) → Teachers. Assign heads from the teacher's page (Account & permissions)." />

      <div class="grid-2">
        <section class="card">
          <h2>Add a section</h2>
          <form method="post" action="/admin/sections" class="stack">
            <div class="form-grid">
              <label>Section name<input name="name" required maxlength={60} placeholder="e.g. Junior" /></label>
              <label>Classes<input name="grades" maxlength={60} placeholder="e.g. Nursery – 2nd" /></label>
            </div>
            <label>Wing<WingSelect value={wings.find((w) => w.active)?.id ?? null} /></label>
            <button class="btn btn-primary btn-sm">Add section</button>
          </form>
        </section>
        <section class="card">
          <h2>Wings</h2>
          <ul class="wing-list">
            {wings.map((w) => (
              <li>
                <form method="post" action={`/admin/wings/${w.id}`} class="inline-form">
                  <input name="name" value={w.name} required maxlength={60} aria-label="Wing name" />
                  <label class="check"><input type="checkbox" name="active" value="1" checked={!!w.active} /> Active</label>
                  <button class="btn btn-sm">Save</button>
                  <div class="title-row">
                    <label>1st in charge title<input name="head_title" value={w.head_title} required maxlength={40} /></label>
                    <label>2nd in charge title<input name="deputy_title" value={w.deputy_title} required maxlength={40} /></label>
                  </div>
                </form>
              </li>
            ))}
          </ul>
          <p class="hint">An inactive wing is shown as "in development": its sections are not offered when choosing sections.</p>
          <form method="post" action="/admin/wings" class="inline-form" style="margin-top:12px">
            <input name="name" required maxlength={60} placeholder="New wing name" />
            <button class="btn btn-sm">Add wing</button>
          </form>
        </section>
      </div>

      {groups.map(({ wing, rows }) => (
        <section class="card">
          <div class="card-head">
            <h2>{wing ? wing.name : 'Not in a wing'} {wing && !wing.active ? <span class="pill pill-pending">In development</span> : null}</h2>
            {wing ? <a href={`/admin/teachers?section=w${wing.id}`}>Teachers in {wing.name}</a> : null}
          </div>
          {rows.length === 0 ? <Empty>{wing && !wing.active ? `${wing.name} will be developed later. Add its sections when ready.` : 'No sections yet.'}</Empty> : (
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Section · classes · wing</th><th>Heads</th><th class="num">Members</th><th></th></tr></thead>
                <tbody>
                  {rows.map((s: any) => (
                    <tr>
                      <td>
                        <form method="post" action={`/admin/sections/${s.id}`} class="inline-form">
                          <input name="name" value={s.name} required maxlength={60} aria-label="Section name" />
                          <input name="grades" value={s.grades ?? ''} maxlength={60} placeholder="Classes" aria-label="Classes" />
                          <WingSelect value={s.wing_id} />
                          <button class="btn btn-sm">Save</button>
                        </form>
                      </td>
                      <td>{s.heads ?? <span class="muted">No head yet</span>}</td>
                      <td class="num"><a href={`/admin/teachers?section=${s.id}`}>{s.members}</a></td>
                      <td>
                        <form method="post" action={`/admin/sections/${s.id}/delete`} data-confirm={`Delete section "${s.name}"? Its teachers will be removed from it.`}>
                          <button class="btn btn-sm btn-demerit">Delete</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </>,
  )
})

async function wingIdFrom(env: Env, raw: unknown): Promise<number | null> {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) return null
  return (await env.DB.prepare('SELECT id FROM wings WHERE id = ?').bind(id).first<{ id: number }>())?.id ?? null
}

app.post('/sections', async (c) => {
  const body = await c.req.parseBody()
  const name = str(body.name, 60)
  if (!name) return back(c, '/admin/sections', 'err', 'Name is required.')
  const res = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO sections (name, grades, wing_id, sort) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM sections))`,
  ).bind(name, str(body.grades, 60) || null, await wingIdFrom(c.env, body.wing_id)).run()
  return back(c, '/admin/sections', res.meta.changes ? 'ok' : 'err', res.meta.changes ? `Section "${name}" added.` : 'A section with that name already exists.')
})

app.post('/sections/:id', async (c) => {
  const body = await c.req.parseBody()
  const name = str(body.name, 60)
  if (!name) return back(c, '/admin/sections', 'err', 'Name is required.')
  try {
    await c.env.DB.prepare('UPDATE sections SET name = ?, grades = ?, wing_id = ? WHERE id = ?')
      .bind(name, str(body.grades, 60) || null, await wingIdFrom(c.env, body.wing_id), Number(c.req.param('id'))).run()
  } catch {
    return back(c, '/admin/sections', 'err', 'A section with that name already exists.')
  }
  return back(c, '/admin/sections', 'ok', 'Section saved.')
})

app.post('/sections/:id/delete', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sections WHERE id = ?').bind(id), // user_sections rows cascade
    // Re-point the legacy "primary" section at one of the user's remaining sections.
    c.env.DB.prepare('UPDATE users SET section_id = (SELECT MIN(section_id) FROM user_sections us WHERE us.user_id = users.id) WHERE section_id IS NULL OR section_id = ?').bind(id),
  ])
  return back(c, '/admin/sections', 'ok', 'Section deleted.')
})

app.post('/wings', async (c) => {
  const name = str((await c.req.parseBody()).name, 60)
  if (!name) return back(c, '/admin/sections', 'err', 'Wing name is required.')
  const res = await c.env.DB.prepare('INSERT OR IGNORE INTO wings (name, active, sort) VALUES (?, 1, (SELECT COALESCE(MAX(sort), 0) + 1 FROM wings))').bind(name).run()
  return back(c, '/admin/sections', res.meta.changes ? 'ok' : 'err', res.meta.changes ? `Wing "${name}" added.` : 'A wing with that name already exists.')
})

app.post('/wings/:id', async (c) => {
  const body = await c.req.parseBody()
  const name = str(body.name, 60)
  if (!name) return back(c, '/admin/sections', 'err', 'Wing name is required.')
  try {
    await c.env.DB.prepare('UPDATE wings SET name = ?, active = ?, head_title = ?, deputy_title = ? WHERE id = ?')
      .bind(name, body.active === '1' ? 1 : 0, str(body.head_title, 40) || 'Section Head', str(body.deputy_title, 40) || 'Deputy Section Head', Number(c.req.param('id'))).run()
  } catch {
    return back(c, '/admin/sections', 'err', 'A wing with that name already exists.')
  }
  return back(c, '/admin/sections', 'ok', 'Wing saved.')
})

// ---------- announcements ----------

app.get('/announcements', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, u.full_name AS author, (SELECT COUNT(*) FROM announcement_reads r WHERE r.announcement_id = a.id) AS reads
       FROM announcements a JOIN users u ON u.id = a.created_by ORDER BY a.created_at DESC`,
  ).all<any>()
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND role != 'coordinator'`).first<{ n: number }>()
  const provider = emailProvider(c.env)
  return page(c, 'Announcements',
    <>
      <PageHead title="Announcements" />
      <section class="card">
        <h2>Post an announcement</h2>
        <form method="post" action="/admin/announcements" class="stack">
          <label>Title<input name="title" required maxlength={150} /></label>
          <label>Message<textarea name="body" required rows={5} maxlength={5000}></textarea></label>
          <label class="check"><input type="checkbox" name="important" value="1" checked /> Important — show as a pop-up on every teacher's dashboard</label>
          <label class="check"><input type="checkbox" name="email" value="1" checked /> Send email notification to all teachers</label>
          {provider === 'log' ? <p class="hint">Email is not configured yet, so emails will only be recorded in the Email Log. See README → Email.</p> : null}
          <button class="btn btn-primary">Publish</button>
        </form>
      </section>
      <section class="card">
        <h2>Published</h2>
        {results.length === 0 ? <Empty>Nothing published yet.</Empty> : (
          <ul class="notices">
            {results.map((a) => (
              <li class={a.important ? 'important' : ''}>
                <div class="notice-title">{a.important ? <span class="pill pill-important">Important</span> : null} {a.title}</div>
                <div class="notice-body">{a.body}</div>
                <div class="muted small">
                  {fmtDateTime(a.created_at, c.env.TIMEZONE)} · {a.author} · read by {a.reads}/{total?.n ?? 0}{a.email_sent ? ` · emailed ${a.email_sent}` : ''}
                </div>
                <form method="post" action={`/admin/announcements/${a.id}/delete`} data-confirm="Delete this announcement?">
                  <button class="btn btn-sm btn-demerit">Delete</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>,
  )
})

app.post('/announcements', async (c) => {
  const body = await c.req.parseBody()
  const title = str(body.title, 150)
  const text = str(body.body, 5000)
  if (!title || !text) return back(c, '/admin/announcements', 'err', 'Title and message are required.')
  const res = await c.env.DB.prepare('INSERT INTO announcements (title, body, important, created_by) VALUES (?, ?, ?, ?)')
    .bind(title, text, body.important === '1' ? 1 : 0, c.get('user').id).run()
  if (body.email === '1') c.executionCtx.waitUntil(notifyAnnouncement(c.env, Number(res.meta.last_row_id)))
  return back(c, '/admin/announcements', 'ok', `Announcement published${body.email === '1' ? ' and emails queued' : ''}.`)
})

app.post('/announcements/:id/delete', async (c) => {
  await c.env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(Number(c.req.param('id'))).run()
  return back(c, '/admin/announcements', 'ok', 'Announcement deleted.')
})

// ---------- policies ----------

app.get('/policies', async (c) => {
  const row = await c.env.DB.prepare(`SELECT value FROM settings WHERE key = 'policies'`).first<{ value: string }>()
  const consented = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE consent_at IS NOT NULL AND role != 'coordinator'`).first<{ n: number }>()
  return page(c, 'Policies',
    <>
      <PageHead title="Organization Policies" sub={`Shown to every teacher on first login. ${consented?.n ?? 0} teachers have given consent.`} />
      <form method="post" action="/admin/policies" class="card stack">
        <textarea name="policies" rows={20} required>{row?.value ?? ''}</textarea>
        <label class="check"><input type="checkbox" name="reconsent" value="1" /> Ask all teachers to read and consent again on their next visit</label>
        <button class="btn btn-primary">Save policies</button>
      </form>
    </>,
  )
})

app.post('/policies', async (c) => {
  const body = await c.req.parseBody()
  const text = str(body.policies, 20000)
  if (!text) return back(c, '/admin/policies', 'err', 'Policies cannot be empty.')
  const stmts = [c.env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('policies', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(text)]
  if (body.reconsent === '1') stmts.push(c.env.DB.prepare(`UPDATE users SET consent_at = NULL WHERE role != 'coordinator'`))
  await c.env.DB.batch(stmts)
  return back(c, '/admin/policies', 'ok', body.reconsent === '1' ? 'Policies saved. Teachers will be asked to consent again.' : 'Policies saved.')
})

// ---------- email log ----------

app.post('/email-log/test', async (c) => {
  const to = str((await c.req.parseBody()).to, 120)
  if (!EMAIL_RE.test(to)) return back(c, '/admin/email-log', 'err', 'Enter a valid email address.')
  await sendMails(c.env, [{
    to,
    subject: 'Test email from the ABN Teacher Portal',
    text: `This is a test email from ${c.env.APP_URL}. If you received it, email notifications are working.`,
    html: wrapHtml(c.env, 'Email is working', '<p>This is a test email from the ABN Teacher Portal. If you received it, announcements, leave and merit notifications will be delivered.</p>'),
  }])
  const last = await c.env.DB.prepare('SELECT status, error FROM email_log WHERE to_addr = ? ORDER BY id DESC LIMIT 1').bind(to).first<{ status: string; error: string | null }>()
  if (last?.status === 'sent') return back(c, '/admin/email-log', 'ok', `Test email sent to ${to}. Check the inbox (and spam folder).`)
  if (last?.status === 'logged') return back(c, '/admin/email-log', 'err', 'Not sent: email delivery is not active yet (SMTP_PASS secret missing). It was only recorded below.')
  return back(c, '/admin/email-log', 'err', `Sending failed: ${last?.error ?? 'unknown error'}`)
})

app.get('/email-log', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 300').all<any>()
  const provider = emailProvider(c.env)
  return page(c, 'Email Log',
    <>
      <PageHead title="Email Log" sub={provider === 'log'
        ? `Email delivery is not active yet — messages are recorded here only.${c.env.SMTP_HOST ? ' SMTP is configured but the SMTP_PASS secret (Google App Password) has not been added.' : ''}`
        : `Sending as ${c.env.MAIL_FROM || c.env.SMTP_USER} via ${provider === 'smtp' ? c.env.SMTP_HOST : 'Resend'}.`} />
      <section class="card narrow">
        <h2>Send a test email</h2>
        <form method="post" action="/admin/email-log/test" class="inline-form">
          <input type="email" name="to" required maxlength={120} value={c.get('user').email || c.env.MAIL_FROM || ''} placeholder="you@example.com" />
          <button class="btn btn-primary btn-sm">Send test</button>
        </form>
      </section>
      <div class="card table-wrap">
        {results.length === 0 ? <Empty>No emails yet.</Empty> : (
          <table class="table">
            <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
            <tbody>
              {results.map((e) => (
                <tr>
                  <td>{fmtDateTime(e.created_at, c.env.TIMEZONE)}</td>
                  <td>{e.to_addr}</td>
                  <td>{e.subject}</td>
                  <td><StatusPill status={e.status} />{e.error ? <div class="muted small">{e.error}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>,
  )
})

export default app
