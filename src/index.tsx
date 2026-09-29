import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import type { AppEnv } from './types'
import { originCheck, requireAuth } from './lib/auth'
import publicRoutes from './routes/public'
import meRoutes from './routes/me'
import teacherRoutes from './routes/teachers'
import adminRoutes from './routes/admin'
import attendanceRoutes from './routes/attendance'
import { page, PageHead } from './views/layout'

const app = new Hono<AppEnv>()

app.use('*', secureHeaders({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: undefined }))
app.use('*', originCheck)

// Public: login, join, logout
app.route('/', publicRoutes)

// Everything below requires an approved, logged-in user (and completed onboarding).
app.use('*', requireAuth)
app.route('/', meRoutes)
app.route('/', teacherRoutes)
app.route('/admin', adminRoutes)
app.route('/attendance', attendanceRoutes)

app.notFound((c) => (c.get('user')
  ? page(c, 'Not found', <><PageHead title="Page not found" /><p><a href="/dashboard">Back to dashboard</a></p></>, 404)
  : c.redirect('/login', 303)))

app.onError((err, c) => {
  console.error(err)
  return c.text('Something went wrong. Please try again.', 500)
})

// ---------- sub-path hosting (raajsoftware.com/abn) ----------
// The app itself is written for "/". This wrapper strips BASE_PATH from incoming
// requests and adds it back to links, form actions, redirects and cookies on the
// way out, so the same code runs at a domain root or under any prefix.
// Static files live in public/abn/ so Cloudflare serves /abn/styles.css directly.

function prefixed(base: string, value: string | null): string | null {
  return value && value.startsWith('/') && !value.startsWith('//') ? base + value : value
}

class PrefixAttr {
  constructor(private base: string, private attr: string) {}
  element(el: Element) {
    const v = prefixed(this.base, el.getAttribute(this.attr))
    if (v) el.setAttribute(this.attr, v)
  }
}

async function handle(request: Request, env: AppEnv['Bindings'], ctx: ExecutionContext): Promise<Response> {
  const base = (env.BASE_PATH ?? '').replace(/\/$/, '')
  if (!base) return app.fetch(request, env, ctx)

  const url = new URL(request.url)
  if (url.pathname !== base && !url.pathname.startsWith(base + '/')) {
    return Response.redirect(`${url.origin}${base}/`, 302)
  }
  url.pathname = url.pathname.slice(base.length) || '/'
  const res = await app.fetch(new Request(url, request), env, ctx)

  const out = new Response(res.body, res)
  const loc = out.headers.get('Location')
  if (loc) out.headers.set('Location', prefixed(base, loc)!)
  const cookies = res.headers.getSetCookie()
  if (cookies.length) {
    out.headers.delete('Set-Cookie')
    for (const ck of cookies) out.headers.append('Set-Cookie', ck.replace(/Path=\/(?=;|$)/i, `Path=${base}`))
  }
  if (!(out.headers.get('Content-Type') ?? '').includes('text/html')) return out
  return new HTMLRewriter()
    .on('a[href]', new PrefixAttr(base, 'href'))
    .on('link[href]', new PrefixAttr(base, 'href'))
    .on('img[src]', new PrefixAttr(base, 'src'))
    .on('script[src]', new PrefixAttr(base, 'src'))
    .on('form[action]', new PrefixAttr(base, 'action'))
    .transform(out)
}

export default {
  fetch: handle,
  async scheduled(_event: ScheduledEvent, env: AppEnv['Bindings']) {
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)).run()
  },
}
