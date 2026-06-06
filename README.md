# Contractor North

AI-powered field service platform for electrical contractors (built for a CED
contractor). CRM, AI-assisted quoting, scheduling, work orders, and a full
timeclock — with a Claude-powered assistant throughout.

Built with **Next.js 15** (App Router) · **Supabase** (Postgres + Auth + RLS) ·
**Anthropic Claude** · **Tailwind CSS v4** · deployed on **Vercel**.

---

## What's built today

| Area | Status | Notes |
|------|--------|-------|
| Auth (email/password) | ✅ | Sign up / sign in, sessions, route protection |
| Dashboard | ✅ | Live counts, pipeline, recent activity, "clocked in" banner |
| CRM | ✅ | Customers/leads, search, detail with quotes & jobs |
| Quotes | ✅ | Line-item builder + **AI draft from a scope of work**, statuses |
| Scheduling | ✅ | Jobs, agenda grouped by day |
| Work Orders | ✅ | Create, assign, statuses, detail |
| Timeclock | ✅ | Clock in/out, **GPS capture**, lunch, job codes, "what did you do today?" with **voice dictation**, weekly hours-per-code |
| "No clock-in" text nudge | ✅ | Cron endpoint (Twilio-ready stub) |
| AI Assistant | ✅ | Streaming Claude chat with electrical context |
| **Material Lists** | ✅ | AI take-off generation, inline item editor, cost totals |
| **Change Orders** | ✅ | Create against a job, approve/reject, approved-total summary |
| **Inventory** | ✅ | Stock on hand, low-stock alerts, quick +/− adjustments, stock value |
| **Purchasing** | ✅ | POs to CED, **seed a PO from a material list**, receive lines, auto status |
| Billing / Forms / Plans & LiDAR | 🟡 | Scaffolded, in nav, schema ready — UI coming next |

---

## 1. Prerequisites

- **Node.js 18.18+** (this repo was built/verified on Node 22).
- A **Supabase** account → <https://supabase.com>
- An **Anthropic** API key → <https://console.anthropic.com>
- A **Vercel** account (for deploy) → <https://vercel.com>

---

## 2. Set up Supabase

1. Create a new project in the Supabase dashboard. Pick a strong DB password.
2. Open **SQL Editor** → **New query**, paste the contents of
   [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql), and **Run**.
   This creates the core tables, enums, triggers, and Row Level Security policies.
3. Run [`supabase/migrations/0002_purchasing_inventory.sql`](supabase/migrations/0002_purchasing_inventory.sql)
   the same way to add the inventory and purchase-order tables.
4. Run [`supabase/seed.sql`](supabase/seed.sql) to load standard electrical job
   codes and a starter safety form.
5. Go to **Project Settings → API** and copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` (keep secret!)
6. **Auth → Providers → Email**: for getting started fast, turn **off**
   "Confirm email" so your first account logs in immediately. (Turn it back on
   before real use.)

> **Make yourself the owner.** New signups default to the `tech` role. After you
> sign up, run this in the SQL editor:
> ```sql
> update public.profiles set role = 'owner' where email = 'you@example.com';
> ```

---

## 3. Configure environment variables

Copy the example file and fill it in:

```bash
cp .env.example .env.local
```

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-8
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

---

## 4. Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>, sign up, and you're in.

Other scripts: `npm run build`, `npm run start`, `npm run lint`,
`npm run typecheck`.

---

## 5. Deploy to Vercel

1. Push this repo to GitHub (see below).
2. In Vercel, **Add New → Project** and import the repo.
3. Add the same env vars from `.env.local` in **Settings → Environment Variables**.
   Set `NEXT_PUBLIC_SITE_URL` to your Vercel URL (e.g. `https://contractor-north.vercel.app`).
4. Deploy. Then in **Supabase → Auth → URL Configuration**, add your Vercel URL
   to **Site URL** and **Redirect URLs** (`https://your-app.vercel.app/auth/callback`).

`vercel.json` already schedules the timeclock "no clock-in" check at **9am
Central (14:00 UTC), Mon–Fri**. To enable the actual texts, add Twilio env vars
(`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`) and a
`CRON_SECRET` (Vercel sends it automatically to cron routes).

---

## 6. Push to GitHub

```bash
git init
git add .
git commit -m "Initial Contractor North build"
git branch -M main
git remote add origin https://github.com/ETElectric369/Contractor-North.git
git push -u origin main
```

---

## Project structure

```
src/
  app/
    (app)/            # authenticated app (sidebar shell)
      dashboard/  crm/  quotes/  schedule/  work-orders/  timeclock/
      assistant/  settings/  + scaffolded modules
    api/              # chat (Claude stream), timeclock/nudge, health
    login/  auth/     # auth pages + callback
  components/         # ui primitives, app shell, shared bits
  lib/
    supabase/         # browser + server + middleware clients
    anthropic.ts      # Claude client + system prompt
    nav.ts  types.ts  utils.ts
supabase/
  migrations/0001_init.sql   # full schema + RLS
  seed.sql                   # job codes, starter form
```

## Security model (RLS)

- Every signed-in, active staff member belongs to the one company.
- Business records: any member can read; office/admin/owner can write.
- Time entries: techs see/edit only their own; office+ see all.
- AI conversations are private to their owner.

The **anon key is safe in the browser** — the database enforces access, not the
client. Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser.
