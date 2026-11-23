import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { AppEnv, Env, Role, User } from '../types'
import { randomToken, sha256Hex } from './crypto'
import { SECTION_IDS_SQL, SECTION_NAMES_SQL, headTitleSql } from './queries'
import { parseIds } from './util'

const COOKIE = 'abn_session'
const SESSION_DAYS = 30

export const USER_SELECT = `SELECT u.*, ${SECTION_NAMES_SQL} AS section_name, ${SECTION_IDS_SQL} AS section_ids_csv, ${headTitleSql('u')} AS head_title FROM users u`

/** "Principal", "Teacher", or the head's title (e.g. "Mas'ool Awwal", "Deputy Section Head"). */
export function roleLabel(u: { role: string; head_level?: string | null; head_title?: string | null }): string {
  if (u.role === 'coordinator') return 'Principal'
  if (u.role !== 'head') return 'Teacher'
  return u.head_title || (u.head_level === 'saani' ? 'Deputy Section Head' : 'Section Head')
}

/** Role picker value -> stored role + head level. "head" = first in charge, "head2" = second in charge. */
export function parseRoleChoice(v: unknown, allowPrincipal = false): { role: Role; head_level: 'awwal' | 'saani' | null } {
  if (v === 'coordinator' && allowPrincipal) return { role: 'coordinator', head_level: null }
  if (v === 'head') return { role: 'head', head_level: 'awwal' }
  if (v === 'head2') return { role: 'head', head_level: 'saani' }
  return { role: 'teacher', head_level: null }
}

/** Current picker value for a user. */
export function roleChoice(u: { role: string; head_level?: string | null }): string {
  return u.role === 'head' ? (u.head_level === 'saani' ? 'head2' : 'head') : u.role
}

type UserRow = Omit<User, 'section_ids'> & { section_ids_csv: string | null }

export function hydrateUser(row: UserRow): User
export function hydrateUser(row: UserRow | null): User | null
export function hydrateUser(row: UserRow | null): User | null {
  if (!row) return null
  const { section_ids_csv, ...rest } = row
  return { ...rest, section_ids: parseIds(section_ids_csv) }
}

export async function getUserById(env: Env, id: number): Promise<User | null> {
  return hydrateUser(await env.DB.prepare(`${USER_SELECT} WHERE u.id = ?`).bind(id).first<UserRow>())
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
    .first<UserRow>()
  if (!row || row.status !== 'active') return null
  return hydrateUser(row)
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

/** Do two users share at least one section? */
export function sharesSection(a: Pick<User, 'section_ids'>, b: Pick<User, 'section_ids'>): boolean {
  return a.section_ids.some((id) => b.section_ids.includes(id))
}

/** Can `viewer` see the full record (profile, points history, attendance) of `target`? */
export function canViewTeacher(viewer: User, target: Pick<User, 'id' | 'section_ids'>): boolean {
  if (viewer.role === 'coordinator') return true
  if (viewer.id === target.id) return true
  return viewer.role === 'head' && sharesSection(viewer, target)
}

/** Can `viewer` give merit/demerit to `target`? (Heads: teachers in any of their sections, never themselves.) */
export function canGivePoints(viewer: User, target: Pick<User, 'id' | 'section_ids' | 'role'>): boolean {
  if (target.role === 'coordinator' || viewer.id === target.id) return false
  if (viewer.role === 'coordinator') return true
  return viewer.role === 'head' && sharesSection(viewer, target)
}

/** Whose attendance a user may mark: 'all', a list of section ids, or null (none). */
export function attendanceScope(u: User): 'all' | number[] | null {
  if (u.role === 'coordinator') return 'all'
  if (u.role !== 'head') return null
  if (u.attendance_scope === 'all') return 'all'
  if (u.attendance_scope === 'section' && u.section_ids.length) return u.section_ids
  return null
}
