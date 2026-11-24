import { Hono } from 'hono'
import type { AppEnv, User } from '../types'
import { page, PageHead, Avatar, Empty } from '../views/layout'
import { SectionSelect } from '../views/components'
import { attendanceScope, canViewTeacher, getUserById } from '../lib/auth'
import { SECTION_NAMES_SQL, inSections, listSections, parseSectionFilter } from '../lib/queries'
import { back, fmtDate, fmtDateTime, isISODate, todayISO } from '../lib/util'

// Selfie self check-in.
//   1. The teacher punches on the X990 machine; the machine pushes the punch to /iclock.
//   2. Once today's punch for their machine ID has arrived, /checkin unlocks the front camera.
//   3. The live selfie (with GPS when allowed) is saved and today's attendance becomes Present.
// Photos are small JPEGs kept for 90 days (see the daily clean-up in index.tsx); the record stays.

const MAX_PHOTO = 300 * 1024

const app = new Hono<AppEnv>()

type Punch = { id: number; punch_time: string; device_sn: string; verify: string | null }

async function todaysPunch(c: any, user: User, today: string): Promise<Punch | null> {
  return c.env.DB.prepare('SELECT id, punch_time, device_sn, verify FROM punches WHERE user_id = ? AND punch_date = ? ORDER BY punch_time LIMIT 1')
    .bind(user.id, today).first()
}

const hhmm = (t: string | null | undefined) => (t ? t.slice(11, 16) : '—')

// ---------- teacher: check in ----------

app.get('/', async (c) => {
  const user = c.get('user')
  if (user.role === 'coordinator') return c.redirect('/attendance/checkins', 303)
  const today = todayISO(c.env.TIMEZONE)
  const punch = await todaysPunch(c, user, today)
  const done = await c.env.DB.prepare('SELECT created_at, lat, lng, source FROM checkins WHERE user_id = ? AND date = ?')
    .bind(user.id, today).first<{ created_at: string; lat: number | null; lng: number | null; source: string }>()

  let body
  if (!user.device_pin) {
    body = <Empty>Your machine ID has not been set yet. Please ask the Principal to add it to your profile.</Empty>
  } else if (!punch) {
    body = (
      <div class="checkin-wait">
        <div class="big-icon" aria-hidden="true">☝</div>
        <h2>Punch on the machine first</h2>
        <p class="muted">Use the fingerprint machine at the entrance. This page unlocks automatically as soon as your punch reaches the portal (usually within a minute).</p>
        <a class="btn btn-sm" href="/checkin">Check again</a>
        <meta http-equiv="refresh" content="30" />
      </div>
    )
  } else {
    body = (
      <form method="post" action="/checkin" enctype="multipart/form-data" class="checkin" id="checkin-form">
        <p class="punch-ok">✓ Punch received at <b>{hhmm(punch.punch_time)}</b></p>
        {done ? (
          <div class="flash flash-ok">
            You checked in at {fmtDateTime(done.created_at, c.env.TIMEZONE)}. Your selfie is saved — you can retake it if needed.
            <div><img class="checkin-photo" src={`/checkin/photo/${user.id}/${today}`} alt="Your check-in selfie" /></div>
          </div>
        ) : null}
        <div class="camera">
          <video id="cam" autoplay playsinline muted></video>
          <canvas id="shot" hidden></canvas>
          <img id="preview" alt="" hidden />
        </div>
        <p class="hint" id="cam-msg">Allow camera access, look at the camera and tap <b>Take selfie</b>.</p>
        <input type="file" name="photo" id="photo-file" accept="image/*" capture="user" hidden />
        <input type="hidden" name="lat" id="lat" />
        <input type="hidden" name="lng" id="lng" />
        <input type="hidden" name="accuracy" id="accuracy" />
        <div class="cam-actions">
          <button type="button" class="btn btn-primary" id="snap">Take selfie</button>
          <button type="button" class="btn" id="retake" hidden>Retake</button>
          <button type="submit" class="btn btn-merit" id="send" hidden>{done ? 'Replace check-in' : 'Check in'}</button>
        </div>
      </form>
    )
  }

  return page(c, 'Self check-in',
    <>
      <PageHead title="Self check-in" sub={fmtDate(today)} />
      <section class="card narrow">{body}</section>
      <script src="/checkin.js" defer></script>
    </>,
  )
})

app.post('/', async (c) => {
  const user = c.get('user')
  if (user.role === 'coordinator') return c.redirect('/attendance/checkins', 303)
  const today = todayISO(c.env.TIMEZONE)
  const punch = await todaysPunch(c, user, today)
  if (!punch) return back(c, '/checkin', 'err', 'No punch from the machine yet today — punch first, then check in.')

  const body = await c.req.parseBody()
  const photo = body.photo
  if (!(photo instanceof File) || photo.size === 0) return back(c, '/checkin', 'err', 'Please take a selfie first.')
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo.type)) return back(c, '/checkin', 'err', 'The selfie must be an image.')
  if (photo.size > MAX_PHOTO) return back(c, '/checkin', 'err', 'The selfie is too large. Please retake it.')
  const num = (v: unknown, min: number, max: number) => {
    const n = Number(v)
    return typeof v === 'string' && v !== '' && Number.isFinite(n) && n >= min && n <= max ? n : null
  }
  const lat = num(body.lat, -90, 90)
  const lng = num(body.lng, -180, 180)
  const accuracy = num(body.accuracy, 0, 100000)
  const source = /ABNApp\//.test(c.req.header('User-Agent') ?? '') ? 'app' : 'browser'

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO checkins (user_id, date, punch_id, photo, lat, lng, accuracy, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, date) DO UPDATE SET punch_id = excluded.punch_id, photo = excluded.photo, lat = excluded.lat,
         lng = excluded.lng, accuracy = excluded.accuracy, source = excluded.source, created_at = excluded.created_at`,
    ).bind(user.id, today, punch.id, await photo.arrayBuffer(), lat, lng, accuracy, source),
    // They are here: today's attendance becomes Present.
    c.env.DB.prepare(
      `INSERT INTO attendance (teacher_id, date, status, marked_by, leave_id, note, updated_at) VALUES (?, ?, 'present', ?, NULL, 'self check-in', datetime('now'))
       ON CONFLICT(teacher_id, date) DO UPDATE SET status = 'present', marked_by = excluded.marked_by, leave_id = NULL, note = excluded.note, updated_at = excluded.updated_at`,
    ).bind(user.id, today, user.id),
  ])
  return back(c, '/checkin', 'ok', `Checked in — marked Present for ${fmtDate(today)}.`)
})

app.get('/photo/:id/:date', async (c) => {
  const viewer = c.get('user')
  const date = c.req.param('date')
  const target = await getUserById(c.env, Number(c.req.param('id')))
  if (!target || !isISODate(date) || !canViewTeacher(viewer, target)) return c.notFound()
  const row = await c.env.DB.prepare('SELECT photo FROM checkins WHERE user_id = ? AND date = ?').bind(target.id, date).first<{ photo: number[] | ArrayBuffer | null }>()
  if (!row?.photo) return c.notFound()
  return new Response(new Uint8Array(row.photo as ArrayBuffer), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=600' } })
})

// ---------- Principal / heads: check-ins report (mounted under /attendance) ----------

export const checkinsReport = new Hono<AppEnv>()

checkinsReport.get('/', async (c) => {
  const user = c.get('user')
  let scope = attendanceScope(user)
  if (scope == null && user.role === 'head' && user.section_ids.length) scope = user.section_ids
  if (scope == null) return c.text('Forbidden', 403)
  const tz = c.env.TIMEZONE
  const date = isISODate(c.req.query('date')) ? c.req.query('date')! : todayISO(tz)
  const all = await listSections(c.env)
  const sections = scope === 'all' ? all : all.filter((s) => (scope as number[]).includes(s.id))
  const sectionParam = c.req.query('section') ?? ''
  const picked = parseSectionFilter(sectionParam, sections)
  const ids = scope === 'all' ? picked : (picked ? picked.filter((id) => (scope as number[]).includes(id)) : scope)
  const where = [`u.status = 'active'`, `u.role != 'coordinator'`]
  const args: unknown[] = [date, date, date]
  if (ids) { const f = inSections(ids); where.push(f.sql); args.push(...f.args) }

  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.full_name, u.its, u.photo_key, u.device_pin, ${SECTION_NAMES_SQL} AS section_name,
            (SELECT MIN(punch_time) FROM punches p WHERE p.user_id = u.id AND p.punch_date = ?) AS first_punch,
            ch.created_at AS checkin_at, ch.lat, ch.lng, ch.accuracy, ch.source, (ch.photo IS NOT NULL) AS has_photo,
            (SELECT status FROM attendance a WHERE a.teacher_id = u.id AND a.date = ?) AS att
       FROM users u LEFT JOIN checkins ch ON ch.user_id = u.id AND ch.date = ?
      WHERE ${where.join(' AND ')}
      ORDER BY (ch.created_at IS NULL), first_punch IS NULL, u.full_name COLLATE NOCASE`,
  ).bind(...args).all<any>()
  const punched = results.filter((r) => r.first_punch).length
  const checked = results.filter((r) => r.checkin_at).length

  return page(c, 'Check-ins',
    <>
      <PageHead title="Self check-ins" sub={`${fmtDate(date)} · ${punched} punched on the machine · ${checked} checked in with a selfie · ${results.length} teachers`} />
      <div class="tabs">
        {attendanceScope(user) != null ? <a href="/attendance/mark">Mark / Edit</a> : null}
        <a href="/attendance/report">Monthly Report</a>
        <a href="/attendance/checkins" class="active">Check-ins</a>
      </div>
      <form method="get" class="filters card">
        <input type="date" name="date" value={date} />
        {sections.length > 1 ? <SectionSelect sections={sections} value={sectionParam} /> : null}
        <button class="btn btn-sm">Show</button>
      </form>
      <div class="card table-wrap">
        {results.length === 0 ? <Empty>No teachers in scope.</Empty> : (
          <table class="table">
            <thead><tr><th>Teacher</th><th>Machine ID</th><th>Punch</th><th>Check-in</th><th>Selfie</th><th>Location</th></tr></thead>
            <tbody>
              {results.map((r) => (
                <tr>
                  <td><div class="who-cell"><Avatar id={r.id} name={r.full_name} photo={r.photo_key} size={30} /><span><a href={`/teachers/${r.id}`}>{r.full_name}</a><small class="muted"> {r.section_name ?? ''}</small></span></div></td>
                  <td>{r.device_pin ?? <span class="muted">not set</span>}</td>
                  <td>{r.first_punch ? hhmm(r.first_punch) : <span class="muted">—</span>}</td>
                  <td>{r.checkin_at ? <>{fmtDateTime(r.checkin_at, tz).split(', ').pop()} <small class="muted">{r.source}</small></> : <span class="muted">{r.att === 'casual_leave' ? 'CL' : r.att === 'eval_absent' ? 'EA' : '—'}</span>}</td>
                  <td>{r.has_photo ? <a href={`/checkin/photo/${r.id}/${date}`} target="_blank"><img class="selfie-thumb" src={`/checkin/photo/${r.id}/${date}`} alt={`Selfie of ${r.full_name}`} loading="lazy" /></a> : r.checkin_at ? <span class="muted small">expired</span> : null}</td>
                  <td>{r.lat != null ? <a href={`https://maps.google.com/?q=${r.lat},${r.lng}`} target="_blank" rel="noopener">Map</a> : <span class="muted">—</span>}{r.accuracy != null ? <small class="muted"> ±{Math.round(r.accuracy)} m</small> : null}</td>
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
