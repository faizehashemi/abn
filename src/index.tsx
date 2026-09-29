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

// Housekeeping: purge expired sessions once a day.
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: AppEnv['Bindings']) {
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)).run()
  },
}
