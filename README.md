# ABN Teacher Portal

Teacher management portal for **Ammar Baughe Nounehaal Higher Secondary School, Indore**. It replaces WhatsApp groups and Google Sheets for staff onboarding, profiles, merit and demerit scoring, the leaderboard, attendance and announcements.

Built on Cloudflare Workers + D1 (SQLite) + R2 (photos), using [Hono](https://hono.dev) with pages rendered on the server. There is no frontend build step.

---

## Roles

| Role | Can do |
|---|---|
| **Main Coordinator** (super admin) | Everything. Approves joining requests and every merit/demerit. Sees all data. Posts announcements. Marks and edits attendance. Creates sections and makes teachers Section Heads. Grants attendance rights. Edits policies. |
| **Section Head** | Sees only teachers in their own section. Sends merit/demerit requests to the Coordinator for approval. Sees their team's history and attendance. Marks attendance if the Coordinator grants it (own section or all teachers). |
| **Teacher** | Their own profile, points, attendance calendar and announcements. Can see the leaderboard. |

## Workflow

1. **Join.** A new teacher clicks *Join as Teacher* and enters their 8-digit ITS number, full name and (optionally) section. The request shows as **Pending Approval**.
2. **Approve.** The Coordinator approves it (choosing section and role) under *Approvals*. Teachers can also be added directly or bulk-imported by CSV under *Teachers → Add teachers*.
3. **Login.** The login ID is the **ITS number** and the default password is the **first name in lowercase** (e.g. `ahmed`). Default passwords are case-insensitive. Users change their password in *Settings*, and the Coordinator can reset it to the default.
4. **Consent.** On first login the teacher sees the Organization Policies and must click *I Agree & Give Consent*. The Coordinator edits the text under *Policies* and can require everyone to consent again.
5. **Profile.** Mandatory fields are: photo, contact number, email, section, date of joining, qualification and address. Designation and subjects are optional. Only after this is the teacher on the leaderboard.
6. **Merit / Demerit.** A Section Head picks a teacher and submits *+ Merit* or *− Demerit* (points, date, reason). The Coordinator sees "Section Head X wants to give +5 Merit to Teacher Y for …" and approves or rejects it. **Final Score = approved merits − approved demerits.** An entry the Coordinator adds directly is approved immediately. The teacher gets an email when points are approved.
7. **Leaderboard.** All teachers ranked by Final Score, with a section filter. Teachers see "You got 2 Demerits on 10 Sep 2026 for late coming".
8. **Announcements.** The Coordinator posts. Important ones appear as a pop-up on every teacher's dashboard until acknowledged, and an email goes to all teachers: *"New Important Update on Portal - Please check"*.
9. **Attendance.** Mark Present / Absent / Leave for any date (so past days can be edited). The page has *All Present* shortcuts and a CSV bulk upload (`ITS,Date,Status`). The monthly report can be filtered by section and exported to CSV. Teachers see a colour-coded calendar with totals.

---

## Run locally

Requires Node 18+.

```bash
npm install
npm run db:migrate:local                          # create tables in a local SQLite DB
node scripts/create-admin.mjs --local --its 12345678 --name "Your Full Name"
npm run seed:demo                                 # optional: demo sections, teachers, points, attendance
npm run dev                                       # http://localhost:8787
```

Demo logins (after `seed:demo`), password = first name:

| ITS | Password | Role |
|---|---|---|
| 12345678 | *(first name you gave)* | Main Coordinator |
| 10000001 | `fatema` | Section Head (Primary) |
| 10000002 | `hussain` | Section Head (Secondary), with attendance rights |
| 10000003 | `ahmed` | Teacher |

End-to-end smoke test (with `npm run dev` running on a freshly seeded DB, coordinator `12345678` named "Main …"):

```bash
node scripts/e2e.mjs
```

To reset local data: `rm -rf .wrangler/state`, then run the setup again.

---

## Deploy to Cloudflare (kept separate from miqaat48)

Everything uses its own names (`abn-teacher-portal`, `abn-teacher-portal-db`, `abn-teacher-portal-photos`). It shares **no** Worker, database, bucket or secret with other projects on the same account.

```bash
npx wrangler login                                  # same Cloudflare account
npx wrangler d1 create abn-teacher-portal-db        # copy the database_id into wrangler.jsonc
npx wrangler r2 bucket create abn-teacher-portal-photos
npm run db:migrate:remote
node scripts/create-admin.mjs --remote --its <your ITS> --name "<Your Name>"
npx wrangler deploy                                 # → https://abn-teacher-portal.<subdomain>.workers.dev
```

For stricter separation, create an **API token** limited to this project's resources and deploy with `CLOUDFLARE_API_TOKEN=… npx wrangler deploy`.

**Custom domain later:** in the Cloudflare dashboard go to *Workers & Pages → abn-teacher-portal → Settings → Domains & Routes → Add custom domain* (e.g. `portal.yourdomain.com`). Then update `APP_URL` in `wrangler.jsonc` (it's used in email links) and redeploy.

## Email

Configure one of these. With neither, emails are only recorded on the admin **Email Log** page, which is handy locally.

- **SMTP** (Gmail app password, Google Workspace, Zoho…):
  `npx wrangler secret put SMTP_HOST`, then `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (and `SMTP_SECURE=true` for port 465). Set `MAIL_FROM` in `wrangler.jsonc`.
- **Resend** HTTP API: `npx wrangler secret put RESEND_API_KEY` and set `MAIL_FROM` to an address on a verified domain.

Locally, put the same keys in `.dev.vars` (see `.dev.vars.example`).

## Project layout

```
migrations/0001_init.sql     database schema + default policy text
src/index.tsx                app entry, middleware, route mounting, daily session clean-up cron
src/lib/                     auth & access rules, password hashing, email, queries, helpers
src/routes/public.tsx        login, join, logout
src/routes/me.tsx            consent, profile, dashboard, leaderboard, my points/attendance, announcements, settings
src/routes/teachers.tsx      Section Head team view, teacher detail, merit/demerit submission
src/routes/admin.tsx         approvals, teachers, bulk import, sections, announcements, policies, email log
src/routes/attendance.tsx    mark/edit, CSV upload, monthly report, CSV export
public/                      logo, CSS, small JS enhancements
scripts/                     create-admin, seed-demo, e2e smoke test
```

## Security notes

- Passwords are hashed with PBKDF2-SHA256 and a random salt. Sessions are random tokens, stored hashed, in HttpOnly SameSite cookies.
- Cross-site form posts are rejected. Every page checks the viewer's role and section on the server.
- Photos live in a private R2 bucket and are only served to logged-in users.
- Because the default password is guessable (the first name), teachers see a reminder until they change it.
