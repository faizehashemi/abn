import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { AppEnv, AttendanceStatus } from '../types'

// ---------- dates (all "today" logic runs in the school's timezone) ----------

export function todayISO(tz: string): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

export function currentMonth(tz: string): string {
  return todayISO(tz).slice(0, 7)
}

export function isISODate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export function isMonth(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function monthBounds(month: string): { start: string; end: string } {
  return { start: `${month}-01`, end: `${month}-${String(daysInMonth(month)).padStart(2, '0')}` }
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return d.toISOString().slice(0, 7)
}

/** 0 = Monday … 6 = Sunday */
export function weekdayMon0(iso: string): number {
  return (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "2026-09-10" -> "10 Sep 2026" */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/** "2026-09" -> "September 2026" */
export function fmtMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${MONTHS_LONG[m - 1]} ${y}`
}

/** SQLite UTC timestamp -> local date+time string */
export function fmtDateTime(sqliteTs: string | null | undefined, tz: string): string {
  if (!sqliteTs) return '—'
  const d = new Date(sqliteTs.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return sqliteTs
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)
}

// ---------- flash messages (one-shot cookie) ----------

export type Flash = { type: 'ok' | 'err'; msg: string }

export function flash(c: Context<AppEnv>, type: Flash['type'], msg: string) {
  setCookie(c, 'abn_flash', JSON.stringify({ type, msg }), { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60 })
}

export function takeFlash(c: Context<AppEnv>): Flash | null {
  const raw = getCookie(c, 'abn_flash')
  if (!raw) return null
  deleteCookie(c, 'abn_flash', { path: '/' })
  try {
    const f = JSON.parse(raw)
    if ((f.type === 'ok' || f.type === 'err') && typeof f.msg === 'string') return f
  } catch {}
  return null
}

export function back(c: Context<AppEnv>, fallback: string, type: Flash['type'], msg: string) {
  flash(c, type, msg)
  return c.redirect(fallback, 303)
}

// ---------- validation & parsing ----------

export const ITS_RE = /^\d{8}$/
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export function parseAttendanceStatus(v: string): AttendanceStatus | null {
  const s = v.trim().toLowerCase()
  if (s === 'p' || s === 'present') return 'present'
  if (s === 'a' || s === 'absent') return 'absent'
  if (s === 'l' || s === 'leave') return 'leave'
  return null
}

/** Minimal CSV parser: handles quoted fields, commas, CRLF. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((f) => f.trim() !== '')) rows.push(row.map((f) => f.trim()))
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row.map((f) => f.trim()))
  return rows
}

export function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Normalise dates like 05/09/2026 or 5-9-2026 (DD/MM/YYYY) to ISO. */
export function normaliseDate(s: string): string | null {
  const t: string = s.trim()
  if (isISODate(t as unknown)) return t
  const m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/)
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
    return isISODate(iso) ? iso : null
  }
  return null
}
