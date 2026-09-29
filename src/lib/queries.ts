import type { Env, Section } from '../types'

export type ScoreRow = {
  id: number
  its: string
  full_name: string
  role: string
  section_id: number | null
  section_name: string | null
  photo_key: string | null
  merits: number
  demerits: number
  score: number
  rank: number
}

/**
 * Scores for every active teacher / section head who has completed onboarding.
 * Final score = approved merits − approved demerits. Ranks use standard
 * competition ranking (1, 2, 2, 4 …).
 */
export async function scoreboard(env: Env, sectionId?: number | null): Promise<ScoreRow[]> {
  const where = sectionId != null ? 'AND u.section_id = ?' : ''
  const stmt = env.DB.prepare(
    `SELECT u.id, u.its, u.full_name, u.role, u.section_id, s.name AS section_name, u.photo_key,
            COALESCE(SUM(CASE WHEN p.kind = 'merit' THEN p.points END), 0)   AS merits,
            COALESCE(SUM(CASE WHEN p.kind = 'demerit' THEN p.points END), 0) AS demerits
       FROM users u
       LEFT JOIN sections s ON s.id = u.section_id
       LEFT JOIN points p ON p.teacher_id = u.id AND p.status = 'approved'
      WHERE u.status = 'active' AND u.role IN ('teacher', 'head') AND u.profile_complete = 1 ${where}
      GROUP BY u.id
      ORDER BY (merits - demerits) DESC, merits DESC, u.full_name COLLATE NOCASE`,
  )
  const { results } = await (sectionId != null ? stmt.bind(sectionId) : stmt).all<Omit<ScoreRow, 'score' | 'rank'>>()
  let rank = 0
  let prev: number | null = null
  return results.map((r, i) => {
    const score = r.merits - r.demerits
    if (score !== prev) { rank = i + 1; prev = score }
    return { ...r, score, rank }
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
       SUM(status = 'present') AS present,
       SUM(status = 'absent')  AS absent,
       SUM(status = 'leave')   AS leave
     FROM attendance WHERE teacher_id = ? ${range}`,
  )
  const row = await (start && end ? stmt.bind(teacherId, start, end) : stmt.bind(teacherId)).first<{ present: number | null; absent: number | null; leave: number | null }>()
  return { present: row?.present ?? 0, absent: row?.absent ?? 0, leave: row?.leave ?? 0 }
}

export async function listSections(env: Env): Promise<Section[]> {
  const { results } = await env.DB.prepare('SELECT id, name FROM sections ORDER BY name COLLATE NOCASE').all<Section>()
  return results
}

export async function pendingCounts(env: Env) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users WHERE status = 'pending') AS users,
            (SELECT COUNT(*) FROM points WHERE status = 'pending') AS points`,
  ).first<{ users: number; points: number }>()
  return { users: row?.users ?? 0, points: row?.points ?? 0 }
}

export async function getSetting(env: Env, key: string): Promise<string> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? ''
}
