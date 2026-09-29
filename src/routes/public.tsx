import { Hono } from 'hono'
import type { AppEnv, User } from '../types'
import { barePage } from '../views/layout'
import { createSession, currentUser, destroySession } from '../lib/auth'
import { defaultPassword, hashPassword, verifyPassword } from '../lib/crypto'
import { ITS_RE, str, flash } from '../lib/util'
import { listSections } from '../lib/queries'

const app = new Hono<AppEnv>()

function AuthCard(props: { children: any; wide?: boolean }) {
  return (
    <div class={`auth-wrap${props.wide ? ' wide' : ''}`}>
      <div class="auth-card">
        <div class="auth-crest">
          <img src="/logo.jpg" alt="Ammar Baughe Nounehaal crest" />
          <h1>ABN Teacher Portal</h1>
          <p class="muted">Ammar Baughe Nounehaal Higher Secondary School, Indore</p>
          <p class="motto" lang="ar" dir="rtl">العلم تاج للفتى</p>
        </div>
        {props.children}
      </div>
    </div>
  )
}

app.get('/', async (c) => {
  const user = await currentUser(c)
  return c.redirect(user ? '/dashboard' : '/login', 303)
})

// ---------- login ----------

function LoginForm(props: { its?: string; error?: string; info?: string }) {
  return (
    <AuthCard>
      {props.error ? <div class="flash flash-err">{props.error}</div> : null}
      {props.info ? <div class="flash flash-info">{props.info}</div> : null}
      <form method="post" action="/login" class="stack">
        <label>
          ITS Number
          <input name="its" inputmode="numeric" pattern="\d{8}" maxlength={8} required autofocus value={props.its ?? ''} placeholder="8-digit ITS" autocomplete="username" />
        </label>
        <label>
          Password
          <input name="password" type="password" required autocomplete="current-password" />
        </label>
        <p class="hint">First login? Your password is your <b>first name</b> in lowercase — for <i>M Huzaifa Master</i> it is <code>huzaifa</code>.</p>
        <button class="btn btn-primary btn-block" type="submit">Log in</button>
      </form>
      <div class="auth-alt">
        New teacher? <a href="/join" class="btn btn-gold">Join as Teacher</a>
      </div>
    </AuthCard>
  )
}

app.get('/login', async (c) => {
  if (await currentUser(c)) return c.redirect('/dashboard', 303)
  return barePage(c, 'Log in', <LoginForm />)
})

app.post('/login', async (c) => {
  const body = await c.req.parseBody()
  const its = str(body.its, 20)
  const password = typeof body.password === 'string' ? body.password : ''
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE its = ?').bind(its).first<User>()

  let ok = false
  if (user) {
    ok = await verifyPassword(password, user.password_hash)
    // Default passwords are case-insensitive so "Huzaifa" works as well as "huzaifa".
    if (!ok && user.using_default_password && password !== password.toLowerCase()) {
      ok = await verifyPassword(password.toLowerCase(), user.password_hash)
    }
  }
  if (!user || !ok) {
    return barePage(c, 'Log in', <LoginForm its={its} error="Incorrect ITS number or password." />, 401)
  }
  if (user.status === 'pending') {
    return barePage(c, 'Pending approval', <LoginForm its={its} info="Your joining request is Pending Approval by the Main Coordinator. Please try again once it has been approved." />, 403)
  }
  if (user.status === 'rejected') {
    return barePage(c, 'Log in', <LoginForm its={its} error="Your joining request was not approved. Please contact the Main Coordinator." />, 403)
  }
  if (user.status === 'disabled') {
    return barePage(c, 'Log in', <LoginForm its={its} error="This account has been disabled. Please contact the Main Coordinator." />, 403)
  }
  await createSession(c, user.id)
  return c.redirect('/dashboard', 303)
})

app.post('/logout', async (c) => {
  await destroySession(c)
  flash(c, 'ok', 'You have been logged out.')
  return c.redirect('/login', 303)
})

// ---------- join (registration request) ----------

function JoinForm(props: { sections: { id: number; name: string }[]; values?: Record<string, string>; error?: string }) {
  const v = props.values ?? {}
  return (
    <AuthCard>
      <h2 class="auth-title">Join as Teacher</h2>
      {props.error ? <div class="flash flash-err">{props.error}</div> : null}
      <form method="post" action="/join" class="stack">
        <label>
          ITS Number
          <input name="its" inputmode="numeric" pattern="\d{8}" maxlength={8} required value={v.its ?? ''} placeholder="8-digit ITS" />
        </label>
        <label>
          Full Name
          <input name="full_name" required minlength={3} maxlength={100} value={v.full_name ?? ''} placeholder="e.g. M Huzaifa Master" />
        </label>
        <label>
          Section / Department
          <select name="section_id">
            <option value="">— Select (optional) —</option>
            {props.sections.map((s) => (
              <option value={String(s.id)} selected={v.section_id === String(s.id)}>{s.name}</option>
            ))}
          </select>
        </label>
        <p class="hint">
          Your login ID will be your ITS number and your initial password will be your <b>first name in lowercase</b> (M / Mulla / Shk prefixes are skipped — <i>M Taha Kamlapur</i> → <code>taha</code>).
          You can change it later from Settings.
        </p>
        <button class="btn btn-primary btn-block" type="submit">Submit joining request</button>
      </form>
      <div class="auth-alt">Already approved? <a href="/login">Log in</a></div>
    </AuthCard>
  )
}

app.get('/join', async (c) => {
  if (await currentUser(c)) return c.redirect('/dashboard', 303)
  return barePage(c, 'Join as Teacher', <JoinForm sections={await listSections(c.env)} />)
})

app.post('/join', async (c) => {
  const body = await c.req.parseBody()
  const its = str(body.its, 20)
  const fullName = str(body.full_name, 100).replace(/\s+/g, ' ')
  const sectionRaw = str(body.section_id, 10)
  const sectionId = sectionRaw ? Number(sectionRaw) : null
  const values = { its, full_name: fullName, section_id: sectionRaw }
  const sections = await listSections(c.env)

  const fail = (error: string) => barePage(c, 'Join as Teacher', <JoinForm sections={sections} values={values} error={error} />, 400)
  if (!ITS_RE.test(its)) return fail('ITS number must be exactly 8 digits.')
  if (fullName.length < 3) return fail('Please enter your full name.')
  if (sectionId != null && !sections.some((s) => s.id === sectionId)) return fail('Please choose a valid section.')

  const existing = await c.env.DB.prepare('SELECT id, status FROM users WHERE its = ?').bind(its).first<{ id: number; status: string }>()
  const hash = await hashPassword(defaultPassword(fullName, its))
  if (existing) {
    if (existing.status !== 'rejected') {
      return fail(existing.status === 'pending'
        ? 'A joining request for this ITS number is already pending approval.'
        : 'This ITS number is already registered. Please log in.')
    }
    // A previously rejected person may request again.
    await c.env.DB.prepare(
      `UPDATE users SET status = 'pending', full_name = ?, section_id = ?, password_hash = ?, using_default_password = 1, created_at = datetime('now') WHERE id = ?`,
    ).bind(fullName, sectionId, hash, existing.id).run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO users (its, full_name, section_id, password_hash, role, status) VALUES (?, ?, ?, ?, 'teacher', 'pending')`,
    ).bind(its, fullName, sectionId, hash).run()
  }

  return barePage(
    c,
    'Request submitted',
    <AuthCard>
      <div class="status-block">
        <span class="pill pill-pending">Pending Approval</span>
        <h2>Request submitted</h2>
        <p>
          Thank you, <b>{fullName}</b>. Your joining request has been sent to the Main Coordinator.
        </p>
        <p>Once approved, log in with:</p>
        <table class="kv">
          <tr><th>ITS Number</th><td>{its}</td></tr>
          <tr><th>Password</th><td><code>{defaultPassword(fullName, its)}</code></td></tr>
        </table>
        <a href="/login" class="btn btn-primary btn-block">Go to login</a>
      </div>
    </AuthCard>,
  )
})

export default app
