#!/usr/bin/env node
// Creates (or updates) the Main Coordinator account.
//
//   node scripts/create-admin.mjs --local  --its 12345678 --name "Your Full Name" [--password secret]
//   node scripts/create-admin.mjs --remote --its 12345678 --name "Your Full Name"
//
// Without --password, the default rule applies: password = first name, lowercase.
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { webcrypto as crypto } from 'node:crypto'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }

const target = flag('remote') ? '--remote' : '--local'
const rl = createInterface({ input: process.stdin, output: process.stdout })
const its = opt('its') ?? (await rl.question('Coordinator ITS number (8 digits): ')).trim()
const name = opt('name') ?? (await rl.question('Coordinator full name: ')).trim()
rl.close()

if (!/^\d{8}$/.test(its)) { console.error('ITS must be exactly 8 digits.'); process.exit(1) }
if (name.length < 3) { console.error('Name is required.'); process.exit(1) }

const firstName = name.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '') || its
const password = opt('password') ?? firstName

// Same format as src/lib/crypto.ts: pbkdf2$<iter>$<salt>$<hash>
const ITER = 50_000
const salt = crypto.getRandomValues(new Uint8Array(16))
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256)
const hash = `pbkdf2$${ITER}$${Buffer.from(salt).toString('base64')}$${Buffer.from(bits).toString('base64')}`
const usingDefault = opt('password') ? 0 : 1

const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const sql = `INSERT INTO users (its, full_name, password_hash, using_default_password, role, status, consent_at, profile_complete, approved_at)
VALUES (${q(its)}, ${q(name)}, ${q(hash)}, ${usingDefault}, 'coordinator', 'active', datetime('now'), 1, datetime('now'))
ON CONFLICT(its) DO UPDATE SET full_name = excluded.full_name, password_hash = excluded.password_hash,
  using_default_password = excluded.using_default_password, role = 'coordinator', status = 'active';`

execFileSync('npx', ['wrangler', 'd1', 'execute', 'abn-teacher-portal-db', target, '--command', sql], { stdio: 'inherit' })
console.log(`\n✔ Main Coordinator ready (${target.slice(2)}).  Login ID: ${its}   Password: ${opt('password') ? '(the one you chose)' : password}`)
