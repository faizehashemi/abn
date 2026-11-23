import type { Env, LeaveRow, Section } from '../types'
import { parseIds } from './util'

// ---------- sections (many-to-many via user_sections) ----------
// These fragments expect the users table to be aliased as `u`.

/** "Primary, Secondary" — all of a user's section names, alphabetical. */
export const SECTION_NAMES_SQL = `(SELECT GROUP_CONCAT(name, ', ') FROM (SELECT s.name FROM user_sections us JOIN sections s ON s.id = us.section_id WHERE us.user_id = u.id ORDER BY s.name COLLATE NOCASE))`
/** "1,4" — all of a user's section ids. */
export const SECTION_IDS_SQL = `(SELECT GROUP_CONCAT(section_id) FROM user_sections us WHERE us.user_id = u.id)`

/** SQL condition "u belongs to any of these sections" plus its bind values. */
export function inSections(ids: number[]): { sql: string; args: number[] } {
  if (!ids.length) return { sql: '0', args: [] }
  return { sql: `EXISTS (SELECT 1 FROM user_sections us WHERE us.user_id = u.id AND us.section_id IN (${ids.map(() => '?').join(',')}))`, args: ids }
}

/** Replace a user's sections. users.section_id keeps the first one as the legacy "primary" section. */
export function setUserSections(env: Env, userId: number, sectionIds: number[]): D1PreparedStatement[] {
  const ids = [...new Set(sectionIds)]
  return [
    env.DB.prepare('DELETE FROM user_sections WHERE user_id = ?').bind(userId),
    ...ids.map((sid) => env.DB.prepare('INSERT OR IGNORE INTO user_sections (user_id, section_id) VALUES (?, ?)').bind(userId, sid)),
    env.DB.prepare('UPDATE users SET section_id = ? WHERE id = ?').bind(ids[0] ?? null, userId),
  ]
}

/** Keep only ids of sections that exist. */
export async function validSectionIds(env: Env, ids: number[]): Promise<number[]> {
  const known = new Set((await listSections(env)).map((s) => s.id))
  return [...new Set(ids)].filter((id) => known.has(id))
}

export type ScoreRow = {
  id: number
  its: string
  full_name: string
  role: string
  section_ids: number[]
  section_name: string | null
  photo_key: string | null
  merits: number
  demerits: number
  score: number
  rank: number
}

/**
 * Scores for every active teacher / section head (whether or not their profile is complete yet).
 * Final score = approved merits − approved demerits. Ranks use standard
 * competition ranking (1, 2, 2, 4 …).
 */
export async function scoreboard(env: Env, sectionIds?: number[] | null): Promise<ScoreRow[]> {
  const filter = sectionIds ? inSections(sectionIds) : null
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.its, u.full_name, u.role, ${SECTION_NAMES_SQL} AS section_name, ${SECTION_IDS_SQL} AS section_ids_csv, u.photo_key,
            COALESCE(SUM(CASE WHEN p.kind = 'merit' THEN p.points END), 0)   AS merits,
            COALESCE(SUM(CASE WHEN p.kind = 'demerit' THEN p.points END), 0) AS demerits
       FROM users u
       LEFT JOIN points p ON p.teacher_id = u.id AND p.status = 'approved'
      WHERE u.status = 'active' AND u.role IN ('teacher', 'head') ${filter ? `AND ${filter.sql}` : ''}
      GROUP BY u.id
      ORDER BY (merits - demerits) DESC, merits DESC, u.full_name COLLATE NOCASE`,
  ).bind(...(filter?.args ?? [])).all<Omit<ScoreRow, 'score' | 'rank' | 'section_ids'> & { section_ids_csv: string | null }>()
  let rank = 0
  let prev: number | null = null
  return results.map(({ section_ids_csv, ...r }, i) => {
    const score = r.merits - r.demerits
    if (score !== prev) { rank = i + 1; prev = score }
    return { ...r, section_ids: parseIds(section_ids_csv), score, rank }
  })
}

export async function teacherTotals(env: Env, teacherId: number) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'merit' THEN points END), 0) AS merits,
            COALESCE(SUM(CASE WHEN kind = 'demerit' THEN points END), 0) AS demerits
       FROM points WHERE teacher_id = ? AND status = 'approved'`,
  ).bind(teacherId).first<{ merits: number; demerits: number }>()
  const merits = row?.merits ?? 0
  const demerits = row?.demerits ?? 0
  return { merits, demerits, score: merits - demerits }
}

export async function attendanceCounts(env: Env, teacherId: number, start?: string, end?: string) {
  const range = start && end ? 'AND date BETWEEN ? AND ?' : ''
  const stmt = env.DB.prepare(
    `SELECT
       SUM(status = 'present')      AS present,
       SUM(status = 'absent')       AS absent,
       SUM(status = 'casual_leave') AS casual_leave,
       SUM(status = 'eval_absent')  AS eval_absent
     FROM attendance WHERE teacher_id = ? ${range}`,
  )
  const row = await (start && end ? stmt.bind(teacherId, start, end) : stmt.bind(teacherId)).first<Record<string, number | null>>()
  return {
    present: row?.present ?? 0,
    absent: row?.absent ?? 0,
    casual_leave: row?.casual_leave ?? 0,
    eval_absent: row?.eval_absent ?? 0,
  }
}

export type AttendanceTotals = Awaited<ReturnType<typeof attendanceCounts>>

export async function listSections(env: Env): Promise<Section[]> {
  const { results } = await env.DB.prepare('SELECT id, name FROM sections ORDER BY name COLLATE NOCASE').all<Section>()
  return results
}

export async function pendingCounts(env: Env) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users WHERE status = 'pending') AS users,
            (SELECT COUNT(*) FROM points WHERE status = 'pending') AS points,
            (SELECT COUNT(*) FROM leave_requests WHERE status = 'pending') AS leave`,
  ).first<{ users: number; points: number; leave: number }>()
  return { users: row?.users ?? 0, points: row?.points ?? 0, leave: row?.leave ?? 0 }
}

/** Approved leave overlapping [from, to], with teacher name and sections, for the "who's away" board. */
export async function approvedLeaveBetween(env: Env, from: string, to: string): Promise<LeaveRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT l.*, u.full_name AS teacher_name, ${SECTION_NAMES_SQL} AS section_name
       FROM leave_requests l JOIN users u ON u.id = l.teacher_id
      WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ?
      ORDER BY l.start_date, u.full_name COLLATE NOCASE`,
  ).bind(to, from).all<LeaveRow>()
  return results
}

export async function getSetting(env: Env, key: string): Promise<string> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? ''
}
