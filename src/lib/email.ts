import type { Env } from '../types'

export type Mail = { to: string; subject: string; text: string; html?: string }

type Provider = 'smtp' | 'resend' | 'log'

export function emailProvider(env: Env): Provider {
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) return 'smtp'
  if (env.RESEND_API_KEY) return 'resend'
  return 'log'
}

async function logResult(env: Env, mail: Mail, status: 'sent' | 'logged' | 'failed', error?: string) {
  await env.DB.prepare('INSERT INTO email_log (to_addr, subject, status, error) VALUES (?, ?, ?, ?)')
    .bind(mail.to, mail.subject, status, error ?? null)
    .run()
}

/**
 * Sends a batch of emails with the configured provider and records every attempt
 * in email_log. With no provider configured, mails are only logged (local dev).
 * Never throws — callers run this inside waitUntil().
 */
export async function sendMails(env: Env, mails: Mail[]): Promise<void> {
  if (mails.length === 0) return
  const provider = emailProvider(env)
  const fromEmail = env.MAIL_FROM || env.SMTP_USER || 'no-reply@localhost'
  const fromName = env.MAIL_FROM_NAME || env.APP_NAME

  if (provider === 'log') {
    for (const m of mails) {
      console.log(`[email:log] to=${m.to} subject="${m.subject}"`)
      await logResult(env, m, 'logged')
    }
    return
  }

  if (provider === 'resend') {
    for (const m of mails) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: `${fromName} <${fromEmail}>`, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
        })
        if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`)
        await logResult(env, m, 'sent')
      } catch (e) {
        await logResult(env, m, 'failed', String(e))
      }
    }
    return
  }

  // SMTP over a raw TCP socket (Cloudflare `connect()`), via worker-mailer.
  const port = Number(env.SMTP_PORT || 587)
  let mailer: import('worker-mailer').WorkerMailer | null = null
  try {
    const { WorkerMailer } = await import('worker-mailer')
    mailer = await WorkerMailer.connect({
      host: env.SMTP_HOST!,
      port,
      secure: env.SMTP_SECURE === 'true' || port === 465,
      startTls: true,
      credentials: { username: env.SMTP_USER!, password: env.SMTP_PASS! },
      authType: ['plain', 'login'],
    })
  } catch (e) {
    for (const m of mails) await logResult(env, m, 'failed', `SMTP connect: ${String(e)}`)
    return
  }
  for (const m of mails) {
    try {
      await mailer.send({ from: { name: fromName, email: fromEmail }, to: { email: m.to }, subject: m.subject, text: m.text, html: m.html })
      await logResult(env, m, 'sent')
    } catch (e) {
      await logResult(env, m, 'failed', String(e))
    }
  }
  try { await mailer.close() } catch {}
}

export function wrapHtml(env: Env, heading: string, bodyHtml: string): string {
  const url = env.APP_URL.replace(/\/$/, '')
  return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e3ddd0;border-radius:10px;overflow:hidden">
  <div style="background:#1d2b4a;color:#f3e7c4;padding:16px 20px;font-size:18px;font-weight:600">${env.APP_NAME}</div>
  <div style="padding:20px;color:#222;line-height:1.5">
    <h2 style="margin:0 0 12px;font-size:18px;color:#1d2b4a">${heading}</h2>
    ${bodyHtml}
    <p style="margin-top:24px"><a href="${url}/dashboard" style="background:#b08d3c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open the Portal</a></p>
  </div>
  <div style="background:#f7f4ec;color:#777;padding:10px 20px;font-size:12px">Ammar Baughe Nounehaal Higher Secondary School, Indore</div>
</div>`
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}
