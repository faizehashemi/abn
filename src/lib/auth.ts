import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { AppEnv, Env, Role, User } from '../types'
import { randomToken, sha256Hex } from './crypto'

const COOKIE = 'abn_session'
const SESSION_DAYS = 30

export const USER_SELECT = `SELECT u.*, s.name AS section_name FROM users u LEFT JOIN sections s ON s.id = u.section_id`

export async function getUserById(env: Env, id: number): Promise<User | null> {
  return env.DB.prepare(`${USER_SELECT} WHERE u.id = ?`).bind(id).first<User>()
}

export async function createSession(c: Context<AppEnv>, userId: number) {
  const token = randomToken()
  const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), userId, expires)
    .run()
  setCookie(c, COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: SESSION_DAYS * 86400,
  })
}

export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, COOKIE)
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run()
  deleteCookie(c, COOKIE, { path: '/' })
}

async function sessionUser(c: Context<AppEnv>): Promise<User | null> {
  const token = getCookie(c, COOKIE)
  if (!token) return null
  const row = await c.env.DB.prepare(
    `${USER_SELECT} JOIN sessions se ON se.user_id = u.id WHERE se.token_hash = ? AND se.expires_at > ?`,
  )
    .bind(await sha256Hex(token), Math.floor(Date.now() / 1000))
    .first<User>()
  if (!row || row.status !== 'active') return null
  return row
}

/** Rejects cross-site form posts (defence in depth on top of SameSite=Lax cookies). */
export const originCheck: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('Origin')
    if (origin && origin !== 'null' && new URL(origin).host !== new URL(c.req.url).host) {
      return c.text('Cross-site request blocked', 403)
    }
  }
  await next()
}

/** Requires a logged-in active user and enforces the onboarding order: consent → profile. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await sessionUser(c)
  if (!user) return c.redirect('/login', 303)
  c.set('user', user)

  if (user.role !== 'coordinator') {
    const path = c.req.path
    const exempt = path === '/logout' || path.startsWith('/photo/')
    if (!exempt) {
      if (!user.consent_at && path !== '/policies') return c.redirect('/policies', 303)
      if (user.consent_at && !user.profile_complete && path !== '/profile/complete') return c.redirect('/profile/complete', 303)
    }
  }
  await next()
}

export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!roles.includes(c.get('user').role)) return c.text('Forbidden', 403)
    await next()
  }
}

export async function currentUser(c: Context<AppEnv>): Promise<User | null> {
  return sessionUser(c)
}

// ---------- access rules ----------

export const isCoordinator = (u: User) => u.role === 'coordinator'
export const isHead = (u: User) => u.role === 'head'

/** Can `viewer` see the full record (profile, points history, attendance) of `target`? */
export function canViewTeacher(viewer: User, target: Pick<User, 'id' | 'section_id'>): boolean {
  if (viewer.role === 'coordinator') return true
  if (viewer.id === target.id) return true
  return viewer.role === 'head' && viewer.section_id != null && viewer.section_id === target.section_id
}

/** Can `viewer` give merit/demerit to `target`? (Heads: own section, never themselves.) */
export function canGivePoints(viewer: User, target: Pick<User, 'id' | 'section_id' | 'role'>): boolean {
  if (target.role === 'coordinator' || viewer.id === target.id) return false
  if (viewer.role === 'coordinator') return true
  return viewer.role === 'head' && viewer.section_id != null && viewer.section_id === target.section_id
}

/** Which section's attendance a user may mark: 'all', a section id, or null (none). */
export function attendanceScope(u: User): 'all' | number | null {
  if (u.role === 'coordinator') return 'all'
  if (u.role !== 'head') return null
  if (u.attendance_scope === 'all') return 'all'
  if (u.attendance_scope === 'section' && u.section_id != null) return u.section_id
  return null
}
