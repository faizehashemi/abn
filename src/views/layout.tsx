import type { Context } from 'hono'
import type { Child } from 'hono/jsx'
import { raw } from 'hono/html'
import type { AppEnv, User } from '../types'
import { takeFlash, type Flash } from '../lib/util'
import { pendingCounts } from '../lib/queries'
import { attendanceScope } from '../lib/auth'

type NavItem = { href: string; label: string; badge?: number }

function navFor(user: User, pending: number): NavItem[] {
  if (user.role === 'coordinator') {
    return [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/admin/approvals', label: 'Approvals', badge: pending },
      { href: '/admin/teachers', label: 'Teachers' },
      { href: '/attendance/mark', label: 'Attendance' },
      { href: '/leaderboard', label: 'Leaderboard' },
      { href: '/admin/announcements', label: 'Announcements' },
      { href: '/admin/sections', label: 'Sections' },
      { href: '/admin/policies', label: 'Policies' },
      { href: '/admin/email-log', label: 'Email Log' },
      { href: '/settings', label: 'Settings' },
    ]
  }
  const items: NavItem[] = [{ href: '/dashboard', label: 'Dashboard' }]
  if (user.role === 'head') items.push({ href: '/team', label: 'My Team' })
  if (attendanceScope(user) != null) items.push({ href: '/attendance/mark', label: 'Attendance' })
  else if (user.role === 'head') items.push({ href: '/attendance/report', label: 'Team Attendance' })
  items.push(
    { href: '/leaderboard', label: 'Leaderboard' },
    { href: '/my/points', label: 'My Points' },
    { href: '/my/attendance', label: 'My Attendance' },
    { href: '/announcements', label: 'Announcements' },
    { href: '/profile', label: 'Profile' },
    { href: '/settings', label: 'Settings' },
  )
  return items
}

const ROLE_LABEL = { coordinator: 'Main Coordinator', head: 'Section Head', teacher: 'Teacher' } as const

export function Shell(props: { title: string; children: Child; bare?: boolean; flash?: Flash | null; user?: User | null; nav?: NavItem[]; path?: string }) {
  const { title, children, user, nav, path, flash } = props
  return (
    <>
    {raw('<!doctype html>')}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} · ABN Teacher Portal</title>
        <link rel="icon" href="/logo.jpg" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600&display=swap" />
        <link rel="stylesheet" href="/styles.css" />
        <script src="/app.js" defer></script>
      </head>
      <body class={props.bare ? 'bare' : ''}>
        {user && nav ? (
          <>
            <input type="checkbox" id="nav-toggle" class="nav-toggle" />
            <header class="topbar">
              <label for="nav-toggle" class="hamburger" aria-label="Menu">☰</label>
              <a href="/dashboard" class="brand">
                <img src="/logo.jpg" alt="ABN crest" />
                <span>
                  <strong>ABN Teacher Portal</strong>
                  <small>Ammar Baughe Nounehaal H.S. School</small>
                </span>
              </a>
              <div class="who">
                <span class="who-name">{user.full_name}</span>
                <span class="who-role">{ROLE_LABEL[user.role]}</span>
              </div>
            </header>
            <div class="frame">
              <nav class="sidenav">
                {nav.map((n) => (
                  <a href={n.href} class={path && (path === n.href || path.startsWith(n.href + '/')) ? 'active' : ''}>
                    {n.label}
                    {n.badge ? <span class="badge">{n.badge}</span> : null}
                  </a>
                ))}
                <form method="post" action="/logout">
                  <button type="submit" class="linklike">Log out</button>
                </form>
              </nav>
              <main class="content">
                {flash ? <div class={`flash flash-${flash.type}`}>{flash.msg}</div> : null}
                {children}
              </main>
            </div>
          </>
        ) : (
          <main class="bare-main">
            {flash ? <div class={`flash flash-${flash.type}`}>{flash.msg}</div> : null}
            {children}
          </main>
        )}
      </body>
    </html>
    </>
  )
}

/** Render a full page inside the authenticated app shell. */
export async function page(c: Context<AppEnv>, title: string, body: Child, status: 200 | 400 | 403 | 404 = 200) {
  const user = c.get('user')
  let pending = 0
  if (user?.role === 'coordinator') {
    const p = await pendingCounts(c.env)
    pending = p.users + p.points
  }
  const flash = takeFlash(c)
  return c.html(
    <Shell title={title} user={user} nav={user ? navFor(user, pending) : undefined} path={c.req.path} flash={flash}>
      {body}
    </Shell>,
    status,
  )
}

/** Render a page without navigation (login, join, onboarding). */
export function barePage(c: Context<AppEnv>, title: string, body: Child, status: 200 | 400 | 401 | 403 = 200) {
  const flash = takeFlash(c)
  return c.html(
    <Shell title={title} bare flash={flash}>
      {body}
    </Shell>,
    status,
  )
}

// ---------- small shared components ----------

export function PageHead(props: { title: string; sub?: Child; actions?: Child }) {
  return (
    <div class="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.sub ? <p class="muted">{props.sub}</p> : null}
      </div>
      {props.actions ? <div class="actions">{props.actions}</div> : null}
    </div>
  )
}

export function Avatar(props: { id: number; name: string; photo: string | null; size?: number }) {
  const size = props.size ?? 36
  const initials = props.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')
  return props.photo ? (
    <img class="avatar" src={`/photo/${props.id}`} alt="" width={size} height={size} style={`width:${size}px;height:${size}px`} loading="lazy" />
  ) : (
    <span class="avatar avatar-initials" style={`width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px`}>{initials}</span>
  )
}

export function StatusPill(props: { status: string }) {
  return <span class={`pill pill-${props.status}`}>{props.status}</span>
}

export function Empty(props: { children: Child }) {
  return <div class="empty">{props.children}</div>
}
