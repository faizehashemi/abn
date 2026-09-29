#!/usr/bin/env node
// Fills the LOCAL database with demo sections, teachers, points and attendance
// so every screen can be tried out. Never run this against production.
//
//   npm run seed:demo
//
// Demo logins (password = first name, "M" prefix skipped):
//   Section Head (Primary):   10000001 / huzaifa   (M Huzaifa Master)
//   Section Head (Secondary): 10000002 / taha      (M Taha Kamlapur, has attendance rights for own section)
//   Teacher:                  10000003 / mustafa   (M Mustafa Kapadia)
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto as crypto } from 'node:crypto'
import { defaultPassword } from './names.mjs'

async function hash(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 50_000 }, key, 256)
  return `pbkdf2$50000$${Buffer.from(salt).toString('base64')}$${Buffer.from(bits).toString('base64')}`
}
const q = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`)

const sections = ['Primary', 'Secondary', 'Higher Secondary', 'Administration']
const people = [
  ['10000001', 'M Huzaifa Master', 1, 'head', 'none'],
  ['10000002', 'M Taha Kamlapur', 2, 'head', 'section'],
  ['10000003', 'M Mustafa Kapadia', 1, 'teacher'],
  ['10000004', 'M Murtaza Rangwala', 1, 'teacher'],
  ['10000005', 'M Hussain Lokhandwala', 2, 'teacher'],
  ['10000006', 'M Qaidjohar Jamali', 2, 'teacher'],
  ['10000007', 'M Burhanuddin Poonawala', 3, 'teacher'],
  ['10000008', 'M Aliasgar Saifee', 3, 'teacher'],
  ['10000009', 'M Moiz Hakimuddin', 4, 'teacher'],
  ['10000010', 'M Yusuf Ezzi', 2, 'teacher'],
]
const pending = [['10000011', 'M Shabbir Bohra', 1], ['10000012', 'M Juzer Taher', null]]

const lines = []
sections.forEach((s, i) => lines.push(`INSERT OR IGNORE INTO sections (id, name) VALUES (${i + 1}, ${q(s)});`))
for (const [its, name, sec, role, scope = 'none'] of people) {
  const pw = defaultPassword(name)
  lines.push(`INSERT OR IGNORE INTO users (its, full_name, password_hash, role, status, section_id, attendance_scope, consent_at, profile_complete, phone, email, date_of_joining, qualification, designation, subjects, address, approved_at)
VALUES (${q(its)}, ${q(name)}, ${q(await hash(pw))}, ${q(role)}, 'active', ${sec}, ${q(scope)}, datetime('now'), 1, '98260${its.slice(-5)}', ${q(pw + '@example.com')}, '2019-06-1${its.slice(-1)}', 'M.A. B.Ed.', ${q(role === 'head' ? 'Section Head' : 'Teacher')}, 'English', 'Saifee Nagar, Indore', datetime('now'));`)
}
for (const [its, name, sec] of pending) {
  lines.push(`INSERT OR IGNORE INTO users (its, full_name, password_hash, status, section_id) VALUES (${q(its)}, ${q(name)}, ${q(await hash(defaultPassword(name)))}, 'pending', ${sec ?? 'NULL'});`)
}

const coord = `(SELECT id FROM users WHERE role = 'coordinator' ORDER BY id LIMIT 1)`
const uid = (its) => `(SELECT id FROM users WHERE its = '${its}')`
const pts = [
  ['10000003', 'merit', 5, 'Excellent board exam results', '10000001', 'approved'],
  ['10000003', 'demerit', 2, 'late coming', '10000001', 'approved'],
  ['10000004', 'merit', 3, 'Organised the science exhibition', '10000001', 'approved'],
  ['10000005', 'merit', 8, '100% syllabus completion before time', '10000002', 'approved'],
  ['10000006', 'demerit', 1, 'Register not submitted on time', '10000002', 'approved'],
  ['10000006', 'merit', 4, 'Parent feedback appreciation', '10000002', 'approved'],
  ['10000010', 'merit', 2, 'Covered substitution classes', '10000002', 'pending'],
  ['10000004', 'demerit', 1, 'late coming', '10000001', 'pending'],
]
pts.forEach(([t, kind, n, reason, by, status], i) => {
  lines.push(`INSERT INTO points (teacher_id, kind, points, reason, event_date, status, requested_by, reviewed_by, reviewed_at)
SELECT ${uid(t)}, '${kind}', ${n}, ${q(reason)}, date('now', '-${i + 2} days'), '${status}', ${uid(by)}, ${status === 'approved' ? coord : 'NULL'}, ${status === 'approved' ? "datetime('now')" : 'NULL'}
WHERE NOT EXISTS (SELECT 1 FROM points WHERE reason = ${q(reason)} AND teacher_id = ${uid(t)});`)
})

// ~3 weeks of attendance, skipping Sundays
for (let d = 1; d <= 21; d++) {
  for (const [its] of people) {
    const r = (Number(its.slice(-2)) * 7 + d * 13) % 20
    const status = r === 0 ? 'absent' : r === 1 ? 'leave' : 'present'
    lines.push(`INSERT OR IGNORE INTO attendance (teacher_id, date, status, marked_by)
SELECT ${uid(its)}, date('now', '-${d} days'), '${status}', ${coord} WHERE strftime('%w', date('now', '-${d} days')) != '0';`)
  }
}
lines.push(`INSERT INTO announcements (title, body, important, created_by)
SELECT 'Welcome to the new Teacher Portal', 'Assalamu Alaikum. All updates, attendance and merit records will now be shared here instead of WhatsApp. Please complete your profile and change your password from Settings.', 1, ${coord}
WHERE NOT EXISTS (SELECT 1 FROM announcements) AND ${coord} IS NOT NULL;`)

const dir = mkdtempSync(join(tmpdir(), 'abn-seed-'))
const file = join(dir, 'seed.sql')
writeFileSync(file, lines.join('\n'))
execFileSync('npx', ['wrangler', 'd1', 'execute', 'abn-teacher-portal-db', '--local', '--file', file], { stdio: 'inherit' })
console.log('\n✔ Demo data loaded. Try 10000001 / huzaifa (Section Head) or 10000003 / mustafa (Teacher).')
