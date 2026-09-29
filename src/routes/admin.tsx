import { Hono } from 'hono'
import type { AppEnv, Env, PointRow, User } from '../types'
import { page, PageHead, Avatar, Empty, StatusPill } from '../views/layout'
import { ProfileForm } from '../views/components'
import { USER_SELECT, getUserById, requireRole } from '../lib/auth'
import { defaultPassword, hashPassword } from '../lib/crypto'
import { listSections, scoreboard } from '../lib/queries'
import { saveProfile } from '../lib/profile'
import { sendMails, wrapHtml, escapeHtml, emailProvider } from '../lib/email'
import { ITS_RE, back, csvCell, fmtDate, fmtDateTime, parseCSV, str } from '../lib/util'
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

async function notifyAnnouncement(env: Env, id: number) {
  const a = await env.DB.prepare('SELECT * FROM announcements WHERE id = ?').bind(id).first<{ title: string; body: string }>()
  if (!a) return
  const { results } = await env.DB.prepare(
    `SELECT email, full_name FROM users WHERE status = 'active' AND role != 'coordinator' AND email IS NOT NULL AND email != ''`,
  ).all<{ email: string; full_name: string }>()
  await sendMails(env, results.map((u) => ({
    to: u.email,
    subject: 'New Important Update on Portal - Please check',
    text: `Dear ${u.full_name},\n\nA new important update has been posted on the ABN Teacher Portal:\n\n${a.title}\n\n${a.body}\n\nPlease log in to check: ${env.APP_URL}/dashboard`,
    html: wrapHtml(env, 'New Important Update on Portal', `<p>Dear ${escapeHtml(u.full_name)},</p><p>A new important update has been posted. Please check the portal.</p><div style="border-left:4px solid #b08d3c;padding:8px 14px;background:#faf7ef"><b>${escapeHtml(a.title)}</b><div style="white-space:pre-wrap;margin-top:6px">${escapeHtml(a.body)}</div></div>`),
  })))
  await env.DB.prepare('UPDATE announcements SET email_sent = ? WHERE id = ?').bind(results.length, id).run()
}

// ---------- approval queue ----------

app.get('/approvals', async (c) => {
  const sections = await listSections(c.env)
  const { results: users } = await c.env.DB.prepare(`${USER_SELECT} WHERE u.status = 'pending' ORDER BY u.created_at`).all<User>()
  const { results: pts } = await c.env.DB.prepare(
    `SELECT p.*, t.full_name AS teacher_name, t.its AS teacher_its, r.full_name AS requester_name, s.name AS section_name
       FROM points p JOIN users t ON t.id = p.teacher_id JOIN users r ON r.id = p.requested_by
       LEFT JOIN sections s ON s.id = t.section_id
      WHERE p.status = 'pending' ORDER BY p.created_at`,
  ).all<PointRow>()
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
                <form method="post" action={`/admin/users/${u.id}/approve`} class="inline-form">
                  <select name="section_id" aria-label="Section">
                    <option value="">Section…</option>
                    {sections.map((s) => <option value={String(s.id)} selected={u.section_id === s.id}>{s.name}</option>)}
                  </select>
                  <select name="role" aria-label="Role">
                    <option value="teacher">Teacher</option>
                    <option value="head">Section Head</option>
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
                    Section Head <b>{p.requester_name}</b> wants to give <b>{p.kind === 'merit' ? '+' : '−'}{p.points} {p.kind === 'merit' ? 'Merit' : 'Demerit'}</b> to{' '}
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
    </>,
  )
})

app.post('/users/:id/approve', async (c) => {
  const me = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  const sectionId = Number(str(body.section_id, 10)) || null
  const role = body.role === 'head' ? 'head' : 'teacher'
  const res = await c.env.DB.prepare(
    `UPDATE users SET status = 'active', role = ?, section_id = COALESCE(?, section_id), approved_at = datetime('now'), approved_by = ?
      WHERE id = ? AND status = 'pending'`,
  ).bind(role, sectionId, me.id, id).run()
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
  const sectionId = Number(c.req.query('section')) || null
  const status = ['active', 'pending', 'rejected', 'disabled'].includes(c.req.query('status') ?? '') ? c.req.query('status')! : 'active'
  const where: string[] = [`u.role != 'coordinator'`, 'u.status = ?']
  const args: unknown[] = [status]
  if (sectionId) { where.push('u.section_id = ?'); args.push(sectionId) }
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
        <select name="section">
          <option value="">All sections</option>
          {sections.map((s) => <option value={String(s.id)} selected={s.id === sectionId}>{s.name}</option>)}
        </select>
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
                    <td>{u.role === 'head' ? <span class="pill pill-head">Section Head{u.attendance_scope !== 'none' ? ' · Att.' : ''}</span> : 'Teacher'}</td>
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
  return page(c, 'Add teachers',
    <>
      <PageHead title="Add teachers" sub="Teachers added here skip the approval queue. They log in with their ITS number and first name as password." />
      <div class="grid-2">
        <section class="card">
          <h2>Add one teacher</h2>
          <form method="post" action="/admin/teachers/new" class="stack">
            <label>ITS Number<input name="its" required pattern="\d{8}" maxlength={8} inputmode="numeric" /></label>
            <label>Full Name<input name="full_name" required minlength={3} maxlength={100} /></label>
            <label>Section
              <select name="section_id">
                <option value="">— None —</option>
                {sections.map((s) => <option value={String(s.id)}>{s.name}</option>)}
              </select>
            </label>
            <label>Role
              <select name="role"><option value="teacher">Teacher</option><option value="head">Section Head</option></select>
            </label>
            <button class="btn btn-primary">Add teacher</button>
          </form>
        </section>
        <section class="card">
          <h2>Bulk import (CSV)</h2>
          <p class="muted small">One teacher per line: <code>ITS,Full Name,Section,Role</code>. Section and Role are optional; unknown sections are created automatically. Role is <code>teacher</code> or <code>head</code>. A header row is ignored.</p>
          <form method="post" action="/admin/teachers/import" enctype="multipart/form-data" class="stack">
            <label>CSV file<input type="file" name="file" accept=".csv,text/csv" /></label>
            <label>…or paste rows
              <textarea name="text" rows={7} placeholder={'30412345,M Huzaifa Master,Primary,teacher\n30498765,M Taha Kamlapur,Secondary,head'}></textarea>
            </label>
            <button class="btn btn-primary">Import</button>
          </form>
        </section>
      </div>
    </>,
  )
})

async function addTeacher(env: Env, approverId: number, its: string, fullName: string, sectionId: number | null, role: 'teacher' | 'head'): Promise<string | null> {
  if (!ITS_RE.test(its)) return `${its || '(blank)'}: ITS must be 8 digits`
  if (fullName.length < 3) return `${its}: name is required`
  const exists = await env.DB.prepare('SELECT status FROM users WHERE its = ?').bind(its).first<{ status: string }>()
  if (exists && exists.status !== 'rejected') return `${its}: already registered (${exists.status})`
  const hash = await hashPassword(defaultPassword(fullName, its))
  if (exists) {
    await env.DB.prepare(
      `UPDATE users SET full_name = ?, section_id = ?, role = ?, password_hash = ?, using_default_password = 1, status = 'active', approved_at = datetime('now'), approved_by = ? WHERE its = ?`,
    ).bind(fullName, sectionId, role, hash, approverId, its).run()
  } else {
    await env.DB.prepare(
      `INSERT INTO users (its, full_name, section_id, role, password_hash, status, approved_at, approved_by) VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), ?)`,
    ).bind(its, fullName, sectionId, role, hash, approverId).run()
  }
  return null
}

app.post('/teachers/new', async (c) => {
  const body = await c.req.parseBody()
  const its = str(body.its, 20)
  const name = str(body.full_name, 100).replace(/\s+/g, ' ')
  const sectionId = Number(str(body.section_id, 10)) || null
  const err = await addTeacher(c.env, c.get('user').id, its, name, sectionId, body.role === 'head' ? 'head' : 'teacher')
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
  for (const [its = '', name = '', sectionName = '', role = ''] of rows) {
    let sectionId: number | null = null
    if (sectionName) {
      sectionId = sections.get(sectionName.toLowerCase()) ?? null
      if (sectionId == null) {
        const res = await c.env.DB.prepare('INSERT INTO sections (name) VALUES (?)').bind(sectionName).run()
        sectionId = Number(res.meta.last_row_id)
        sections.set(sectionName.toLowerCase(), sectionId)
      }
    }
    const err = await addTeacher(c.env, c.get('user').id, its, name.replace(/\s+/g, ' '), sectionId, role.toLowerCase() === 'head' ? 'head' : 'teacher')
    if (err) errors.push(err); else added++
  }
  const msg = `Imported ${added} teacher${added === 1 ? '' : 's'}.` + (errors.length ? ` Skipped ${errors.length}: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? '…' : ''}` : '')
  return back(c, '/admin/teachers/new', errors.length && !added ? 'err' : 'ok', msg)
})

app.post('/teachers/:id/access', async (c) => {
  const id = Number(c.req.param('id'))
  const target = await getUserById(c.env, id)
  if (!target || target.role === 'coordinator') return c.notFound()
  const body = await c.req.parseBody()
  const role = body.role === 'head' ? 'head' : 'teacher'
  const sectionId = Number(str(body.section_id, 10)) || null
  const scope = role === 'head' && (body.attendance_scope === 'section' || body.attendance_scope === 'all') ? body.attendance_scope : 'none'
  const status = body.status === 'disabled' ? 'disabled' : 'active'
  await c.env.DB.prepare('UPDATE users SET role = ?, section_id = ?, attendance_scope = ?, status = ? WHERE id = ?')
    .bind(role, sectionId, scope, status, id).run()
  if (status === 'disabled') await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run()
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
  const body = await c.req.parseBody()
  const errors = await saveProfile(c.env, target, body, 'admin')
  if (errors.length) {
    return page(c, 'Edit profile',
      <><PageHead title={`Edit ${target.full_name}`} /><ProfileForm user={{ ...target, ...pickText(body) }} sections={await listSections(c.env)} mode="admin" action={`/admin/teachers/${id}/profile`} errors={errors} /></>, 400)
  }
  return back(c, `/teachers/${id}`, 'ok', 'Profile updated.')
})

// ---------- sections ----------

app.get('/sections', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name,
            (SELECT COUNT(*) FROM users u WHERE u.section_id = s.id AND u.status = 'active') AS members,
            (SELECT GROUP_CONCAT(full_name, ', ') FROM users u WHERE u.section_id = s.id AND u.role = 'head' AND u.status = 'active') AS heads
       FROM sections s ORDER BY s.name COLLATE NOCASE`,
  ).all<{ id: number; name: string; members: number; heads: string | null }>()
  return page(c, 'Sections',
    <>
      <PageHead title="Sections / Departments" sub="Assign a Section Head from the teacher's page (Account & permissions)." />
      <section class="card narrow">
        <form method="post" action="/admin/sections" class="inline-form">
          <input name="name" required maxlength={60} placeholder="New section name, e.g. Primary" />
          <button class="btn btn-primary btn-sm">Add section</button>
        </form>
      </section>
      <div class="card table-wrap">
        {results.length === 0 ? <Empty>No sections yet. Add your first section above.</Empty> : (
          <table class="table">
            <thead><tr><th>Section</th><th>Section Head(s)</th><th class="num">Active members</th><th></th></tr></thead>
            <tbody>
              {results.map((s) => (
                <tr>
                  <td>
                    <form method="post" action={`/admin/sections/${s.id}`} class="inline-form">
                      <input name="name" value={s.name} required maxlength={60} />
                      <button class="btn btn-sm">Rename</button>
                    </form>
                  </td>
                  <td>{s.heads ?? <span class="muted">—</span>}</td>
                  <td class="num"><a href={`/admin/teachers?section=${s.id}`}>{s.members}</a></td>
                  <td>
                    <form method="post" action={`/admin/sections/${s.id}/delete`} data-confirm={`Delete section "${s.name}"? Its teachers will become unassigned.`}>
                      <button class="btn btn-sm btn-demerit">Delete</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>,
  )
})

app.post('/sections', async (c) => {
  const name = str((await c.req.parseBody()).name, 60)
  if (!name) return back(c, '/admin/sections', 'err', 'Name is required.')
  const res = await c.env.DB.prepare('INSERT OR IGNORE INTO sections (name) VALUES (?)').bind(name).run()
  return back(c, '/admin/sections', res.meta.changes ? 'ok' : 'err', res.meta.changes ? `Section "${name}" added.` : 'A section with that name already exists.')
})

app.post('/sections/:id', async (c) => {
  const name = str((await c.req.parseBody()).name, 60)
  if (!name) return back(c, '/admin/sections', 'err', 'Name is required.')
  try {
    await c.env.DB.prepare('UPDATE sections SET name = ? WHERE id = ?').bind(name, Number(c.req.param('id'))).run()
  } catch {
    return back(c, '/admin/sections', 'err', 'A section with that name already exists.')
  }
  return back(c, '/admin/sections', 'ok', 'Section renamed.')
})

app.post('/sections/:id/delete', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET section_id = NULL WHERE section_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM sections WHERE id = ?').bind(id),
  ])
  return back(c, '/admin/sections', 'ok', 'Section deleted.')
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

app.get('/email-log', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 300').all<any>()
  const provider = emailProvider(c.env)
  return page(c, 'Email Log',
    <>
      <PageHead title="Email Log" sub={provider === 'log'
        ? 'Email delivery is not configured — messages are recorded here only. Add SMTP or Resend settings to send real emails.'
        : `Delivering via ${provider.toUpperCase()}.`} />
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
