import type { Env } from '../types'
import { escapeHtml, sendMails, wrapHtml } from './email'

/** Emails an announcement to every active teacher / section head with an email address. */
export async function notifyAnnouncement(env: Env, id: number, subject = 'New Important Update on Portal - Please check') {
  const a = await env.DB.prepare('SELECT * FROM announcements WHERE id = ?').bind(id).first<{ title: string; body: string }>()
  if (!a) return
  const { results } = await env.DB.prepare(
    `SELECT email, full_name FROM users WHERE status = 'active' AND role != 'coordinator' AND email IS NOT NULL AND email != ''`,
  ).all<{ email: string; full_name: string }>()
  await sendMails(env, results.map((u) => ({
    to: u.email,
    subject,
    text: `Dear ${u.full_name},\n\nA new update has been posted on the ABN Teacher Portal:\n\n${a.title}\n\n${a.body}\n\nPlease log in to check: ${env.APP_URL}/dashboard`,
    html: wrapHtml(env, escapeHtml(subject), `<p>Dear ${escapeHtml(u.full_name)},</p><p>A new update has been posted. Please check the portal.</p><div style="border-left:4px solid #b08d3c;padding:8px 14px;background:#faf7ef"><b>${escapeHtml(a.title)}</b><div style="white-space:pre-wrap;margin-top:6px">${escapeHtml(a.body)}</div></div>`),
  })))
  await env.DB.prepare('UPDATE announcements SET email_sent = ? WHERE id = ?').bind(results.length, id).run()
}
