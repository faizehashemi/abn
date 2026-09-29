// Serves the static site from ./public and handles newsletter sign-ups.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

async function subscribe(request, env) {
  const origin = request.headers.get('Origin')
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ ok: false, error: 'Cross-site request blocked.' }, 403)

  const form = await request.formData()
  const wantsJson = (request.headers.get('Accept') || '').includes('application/json')
  const done = (ok, message, status = 200) => wantsJson
    ? json({ ok, message }, status)
    : Response.redirect(new URL(`/?subscribed=${ok ? '1' : '0'}#newsletter`, request.url), 303)

  // Honeypot: real visitors never see or fill this field.
  if (String(form.get('website') || '')) return done(true, 'Thank you for subscribing.')

  const email = String(form.get('email') || '').trim().toLowerCase()
  if (email.length > 254 || !EMAIL_RE.test(email)) return done(false, 'Please enter a valid email address.', 400)

  await env.DB.prepare('INSERT OR IGNORE INTO subscribers (email, source) VALUES (?, ?)').bind(email, 'website').run()
  return done(true, 'Thank you for subscribing.')
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/subscribe') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
      try {
        return await subscribe(request, env)
      } catch (e) {
        console.error(e)
        return json({ ok: false, message: 'Something went wrong. Please try again.' }, 500)
      }
    }
    return env.ASSETS.fetch(request)
  },
}
