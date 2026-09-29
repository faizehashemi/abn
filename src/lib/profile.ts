import type { Env, User } from '../types'
import type { ProfileMode } from '../views/components'
import { EMAIL_RE, ITS_RE, isISODate, str } from './util'
import { randomToken } from './crypto'

const PHOTO_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
// The browser shrinks photos to ~50 KB before upload (public/abn/app.js); this cap
// only matters when JavaScript is off. D1 rows must stay well under 2 MB.
const MAX_PHOTO = 1024 * 1024

/**
 * Validates a submitted profile form and writes it. Returns a list of errors
 * (empty on success). `mode` decides which fields the submitter may change.
 */
export async function saveProfile(env: Env, user: User, body: Record<string, string | File>, mode: ProfileMode): Promise<string[]> {
  const errors: string[] = []
  const fields: Record<string, string | number | null> = {}

  const phone = str(body.phone, 20)
  const email = str(body.email, 120).toLowerCase()
  const qualification = str(body.qualification, 200)
  const address = str(body.address, 500)
  if (!/^[0-9+\- ]{10,15}$/.test(phone)) errors.push('Enter a valid contact number (10–15 digits).')
  if (!EMAIL_RE.test(email)) errors.push('Enter a valid email address.')
  if (!qualification) errors.push('Qualification is required.')
  if (!address) errors.push('Address is required.')
  Object.assign(fields, { phone, email, qualification, address, designation: str(body.designation, 100) || null, subjects: str(body.subjects, 200) || null })

  if (mode !== 'self') {
    const fullName = str(body.full_name, 100).replace(/\s+/g, ' ')
    const doj = str(body.date_of_joining, 10)
    const sectionId = Number(str(body.section_id, 10))
    if (fullName.length < 3) errors.push('Full name is required.')
    if (!isISODate(doj)) errors.push('Enter a valid date of joining.')
    const section = sectionId ? await env.DB.prepare('SELECT id FROM sections WHERE id = ?').bind(sectionId).first() : null
    if (!section) errors.push('Choose your section / department.')
    Object.assign(fields, { full_name: fullName, date_of_joining: doj, section_id: sectionId })
  }

  if (mode === 'admin') {
    const its = str(body.its, 20)
    if (!ITS_RE.test(its)) errors.push('ITS number must be exactly 8 digits.')
    else if (its !== user.its) {
      const clash = await env.DB.prepare('SELECT id FROM users WHERE its = ? AND id != ?').bind(its, user.id).first()
      if (clash) errors.push('Another account already uses that ITS number.')
      else fields.its = its
    }
  }

  const photo = body.photo
  const hasPhoto = photo instanceof File && photo.size > 0
  if (hasPhoto) {
    if (!PHOTO_TYPES[photo.type]) errors.push('Photo must be a JPG, PNG or WebP image.')
    else if (photo.size > MAX_PHOTO) errors.push('Photo must be 1 MB or smaller.')
  } else if (mode === 'complete' && !user.photo_key) {
    errors.push('Please upload your photo.')
  }

  if (errors.length) return errors

  if (hasPhoto) {
    await env.DB.prepare(
      `INSERT INTO photos (user_id, content_type, data) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, updated_at = datetime('now')`,
    ).bind(user.id, photo.type, await photo.arrayBuffer()).run()
    fields.photo_key = randomToken(8) // version tag for cache-busting
  }
  if (mode === 'complete') fields.profile_complete = 1

  const cols = Object.keys(fields)
  await env.DB.prepare(`UPDATE users SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...cols.map((k) => fields[k]), user.id)
    .run()
  return []
}
