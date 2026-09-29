#!/usr/bin/env node
// End-to-end smoke test against a running local dev server (npm run dev).
// Expects a fresh local DB with the coordinator 12345678 / "main" and demo data.
//   node scripts/e2e.mjs [appUrl]
const APP = new URL(process.argv[2] ?? 'http://127.0.0.1:8787/abn')
const BASE = APP.origin
const P = APP.pathname.replace(/\/$/, '') // "/abn"
const strip = (l) => (l && P && l.startsWith(P + '/') ? l.slice(P.length) : l)
let failures = 0
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) failures++ }

function client() {
  const jar = new Map()
  async function req(method, path, form) {
    const headers = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), Origin: BASE }
    let body
    if (form instanceof FormData) body = form
    else if (form) { body = new URLSearchParams(form); headers['Content-Type'] = 'application/x-www-form-urlencoded' }
    const res = await fetch(BASE + P + path, { method, headers, body, redirect: 'manual' })
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';')
      const [k, v] = pair.split('=')
      if (attrs.some((a) => /max-age=0/i.test(a)) || v === '') jar.delete(k); else jar.set(k, v)
    }
    const text = await res.text()
    return { status: res.status, location: strip(res.headers.get('location')), text }
  }
  const c = {
    get: (p) => req('GET', p),
    post: (p, f) => req('POST', p, f),
    async follow(p, f) {
      let r = f ? await c.post(p, f) : await c.get(p)
      for (let i = 0; i < 5 && r.location; i++) r = await c.get(r.location)
      return r
    },
  }
  return c
}

const its = String(Math.floor(20000000 + Math.random() * 9999999))

// 1. Join
const guest = client()
let r = await guest.post('/join', { its, full_name: 'M Qasim Test', section_id: '1' })
ok(r.status === 200 && r.text.includes('Pending Approval') && r.text.includes('qasim'), 'join request shows pending + default password')
r = await guest.post('/login', { its, password: 'qasim' })
ok(r.status === 403 && r.text.includes('Pending Approval'), 'pending user cannot log in')

// 2. Coordinator approves
const admin = client()
r = await admin.post('/login', { its: '12345678', password: 'Main' })
ok(r.status === 303 && r.location === '/dashboard', 'coordinator logs in (case-insensitive default password)')
r = await admin.get('/admin/approvals')
ok(r.text.includes('M Qasim Test'), 'join request appears in approval queue')
const qasimBlock = r.text.split('queue-item').find((b) => b.includes('M Qasim Test'))
const qid = qasimBlock.match(/\/admin\/users\/(\d+)\/approve/)[1]
r = await admin.post(`/admin/users/${qid}/approve`, { section_id: '1', role: 'teacher' })
ok(r.status === 303, 'coordinator approves')

// 3. Teacher: consent -> profile
const t = client()
r = await t.post('/login', { its, password: 'qasim' })
ok(r.location === '/dashboard', 'approved teacher logs in')
r = await t.get('/dashboard')
ok(r.location === '/policies', 'first login redirects to policies')
r = await t.follow('/policies', { agree: '1' })
ok(r.text.includes('Complete your profile'), 'consent leads to profile completion')
r = await t.get('/leaderboard')
ok(r.location === '/profile/complete', 'cannot skip profile completion')
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0))
const fd = new FormData()
Object.entries({ full_name: 'M Qasim Test', phone: '9826012345', email: 'qasim@example.com', section_id: '1', date_of_joining: '2020-07-01', qualification: 'B.Sc. B.Ed.', address: 'Indore' }).forEach(([k, v]) => fd.append(k, v))
fd.append('photo', new Blob([png], { type: 'image/png' }), 'me.png')
r = await t.post('/profile/complete', fd)
ok(r.status === 303 && r.location === '/dashboard', 'profile completed with photo')
r = await t.get('/dashboard')
ok(r.status === 200 && r.text.includes('Final Score') && r.text.includes('Important Update'), 'dashboard shows score + important announcement pop-up')
r = await t.get(`/photo/${qid}`)
ok(r.status === 200, 'photo served from R2')

// 4. Section head (Primary) gives a merit
const head = client()
r = await head.post('/login', { its: '10000001', password: 'huzaifa' })
ok(r.location === '/dashboard', 'section head logs in')
r = await head.get('/team')
ok(r.text.includes('M Qasim Test'), 'new teacher appears in head\'s team')
r = await head.post(`/teachers/${qid}/points`, { kind: 'merit', points: '5', event_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10), reason: 'Great PTM' })
ok(r.status === 303, 'head submits merit request')
r = await head.get('/teachers/9999')
ok(r.status === 404, 'unknown teacher 404')
const secondaryTeacher = await head.get('/admin/teachers')
ok(secondaryTeacher.status === 403, 'head cannot open admin pages')

// 5. Coordinator approves the merit
r = await admin.get('/admin/approvals')
ok(r.text.includes('wants to give') && r.text.includes('Great PTM'), 'merit request in approval queue')
const pid = r.text.split('queue-item').find((b) => b.includes('Great PTM')).match(/name="id" value="(\d+)"/)[1]
r = await admin.post('/admin/points/review', { id: pid, decision: 'approved' })
ok(r.status === 303, 'coordinator approves merit')
r = await t.get('/my/points')
ok(r.text.includes('You got 5 Merits') && r.text.includes('Great PTM'), 'teacher sees "You got 5 Merits … for Great PTM"')
r = await t.get('/leaderboard')
ok(r.text.includes('M Qasim Test') && r.text.includes('Leaderboard'), 'teacher on leaderboard')

// 6. Attendance
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
r = await admin.post('/attendance/mark', { date: today, id: qid, [`s_${qid}`]: 'absent' })
ok(r.status === 303, 'coordinator marks attendance')
r = await admin.post('/attendance/upload', { text: `${its},${today},P`, date: today })
ok(r.status === 303, 'bulk CSV upload')
r = await t.get('/my/attendance')
ok(r.text.includes('Total present this month: 1 day'), 'teacher sees attendance summary')
r = await t.get('/attendance/mark')
ok(r.status === 403, 'teacher cannot mark attendance')
const head2 = client()
await head2.post('/login', { its: '10000002', password: 'taha' })
r = await head2.get('/attendance/mark')
ok(r.status === 200 && !r.text.includes('M Qasim Test'), 'authorised head marks only own section')
r = await admin.get(`/attendance/report?section=1`)
ok(r.text.includes('M Qasim Test') && r.text.includes('att-matrix'), 'monthly report with section filter')

// 7. Announcement + email log
r = await admin.post('/admin/announcements', { title: 'E2E notice', body: 'Hello', important: '1', email: '1' })
ok(r.status === 303, 'announcement posted')
await new Promise((res) => setTimeout(res, 1500))
r = await admin.get('/admin/email-log')
ok(r.text.includes('New Important Update on Portal'), 'email recorded in email log')
r = await t.get('/dashboard')
ok(r.text.includes('E2E notice') && r.text.includes('announcement-modal'), 'announcement pops up for teacher')
const ids = [...r.text.matchAll(/<input type="hidden" name="id" value="(\d+)"/g)].map((m) => m[1])
for (const i of ids) await t.post('/announcements/read', { id: i })
r = await t.get('/dashboard')
ok(!r.text.includes('announcement-modal'), 'pop-up gone after "I have read this"')

// 8. Password change
r = await t.post('/settings/password', { current: 'qasim', next: 'newpass123', confirm: 'newpass123' })
ok(r.status === 303, 'password changed')
const t2 = client()
r = await t2.post('/login', { its, password: 'qasim' })
ok(r.status === 401, 'old default password no longer works')
r = await t2.post('/login', { its, password: 'newpass123' })
ok(r.location === '/dashboard', 'new password works')

// 9. CSRF guard
r = await fetch(BASE + P + '/login', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'its=1&password=1', redirect: 'manual' })
ok(r.status === 403, 'cross-site POST blocked')

// 10. Sub-path hosting
if (P) {
  r = await fetch(BASE + P + '/styles.css')
  ok(r.status === 200 && (await r.text()).includes('--navy'), `static assets served under ${P}/`)
  r = await fetch(BASE + '/', { redirect: 'manual' })
  ok(r.status === 302 && r.headers.get('location').endsWith(P + '/'), `root redirects into ${P}/`)
  const login = await (await fetch(BASE + P + '/login')).text()
  ok(login.includes(`action="${P}/login"`) && login.includes(`href="${P}/styles.css"`), 'links and forms carry the prefix')
  const res = await fetch(BASE + P + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'its=12345678&password=main', redirect: 'manual' })
  ok(res.headers.get('location') === P + '/dashboard' && /Path=\/abn/i.test(res.headers.get('set-cookie')), 'redirect + cookie scoped to prefix')
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
