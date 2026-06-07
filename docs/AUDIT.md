# Contractor North — Product-Readiness Audit

_Date: 2026-06-06. Scope: can this be sold to multiple end-user contractors as a
SaaS, and does it all work + is it customizable._

## TL;DR verdict

What's built is a **solid single-company app** — clean architecture, type-safe,
RLS in place, every module functional at the code level. But it is **not yet a
multi-tenant SaaS**, and a few things are hardcoded or fail-open. Before selling
to end users there are **4 blockers** and a handful of **security fixes**.

The single most important finding: **the app is single-tenant.** Today, if two
different contractors signed up, they would share the same customers, jobs,
quotes, and timecards. Fixing this *before* onboarding real customers is far
cheaper than retrofitting it later.

---

## Remediation status (updated after the fix pass)

| Item | Status |
|------|--------|
| B1 Multi-tenancy | ✅ Done — `organizations` + `org_id` everywhere, org-scoped RLS, per-org numbering (migration 0004) |
| B2 Self-serve onboarding | ✅ Done — create-company flow makes you owner; team invites (0004/0005) |
| B3 Per-tenant customization | ✅ Done — company settings, letterhead from org, per-org brand color, per-org job codes/forms |
| B4 Subscription billing | ✅ Scaffolded — Stripe checkout/portal/webhook + trial gate (dormant until keys added) |
| S1 `current_role()` shadow | ✅ Fixed — renamed `app_user_role()` |
| S2 Cron fails open | ✅ Fixed — `/api/timeclock/nudge` now requires `CRON_SECRET` |
| S3 Search filter injection | ✅ Fixed — `sanitizeSearch()` on CRM + Inventory |
| S4 AI rate limiting | 🟡 Partial — input capped; per-user/distributed limit still TODO (Upstash) |
| S7 server-only guard | ✅ Fixed — `import "server-only"` in the server client |
| Self role-escalation | ✅ Fixed — DB trigger blocks non-admins changing their own role |
| Per-org doc numbering | ✅ Done — `doc_counters` + `next_doc_number()` |
| No tests / CI | 🟡 Partial — GitHub Actions CI (typecheck + build) added; no unit/E2E tests yet |
| Error boundaries | ✅ Added — `error.tsx`, `global-error.tsx`, `not-found.tsx` |

**Still open / recommended next:** distributed AI rate limiting, an automated
test suite, an audit log (S6), email-to-customer for quotes/invoices, and a
**live functional QA pass** (the checklist in §6) against your Supabase — that
remains the one thing only you can unblock (needs your account + the migrations
run).

---

## 1. Does everything actually work?

- **Build:** ✅ `next build` passes clean; TypeScript strict; 30+ routes.
- **Deploy:** ✅ Live on Vercel; `/api/health` returns ok; auth redirect works.
- **Runtime end-to-end:** ⚠️ **Not yet verified against a live database.** No
  module has been click-tested with real data because the environment keys were
  added after the build. We need a **functional QA pass** (checklist in §6).
- **Automated tests:** ❌ None. No unit/integration/E2E tests, no CI.

So "everything works" is **true at the compile/deploy level, unproven at the
behavior level.** That gap is normal at this stage but must be closed with a QA
pass before charging anyone.

---

## 2. Blockers for selling to end users (must-fix)

### B1 — Not multi-tenant  🔴 critical
- **Now:** RLS rule is "any active profile can read all business data"
  (`is_member()`), and "any office+ can write" (`is_staff()`). There is no
  `organization`/`tenant` boundary anywhere (verified by grep).
- **Impact:** Two paying customers would see each other's data. Hard blocker.
- **Fix:** Add an `organizations` table; add `org_id` to every business table;
  derive the caller's org from their profile; rewrite every RLS policy to scope
  by `org_id`. Update all inserts to stamp `org_id`. Per-org numbering for
  quotes/POs/invoices.

### B2 — No self-serve onboarding  🔴 critical
- **Now:** New signups default to `tech`; becoming `owner` requires a manual SQL
  `UPDATE`. There is no "create your company" flow or team invitations.
- **Fix:** Signup → create an organization → make that user the `owner`. Add a
  team-invite flow (email invite + role). Onboarding wizard (company details,
  tax rate, job codes).

### B3 — Per-tenant customization is missing  🟠 high
- **Now:** Company letterhead lives in code (`src/lib/company.ts`); job codes,
  tax, and form templates are seeded **globally**; brand color is fixed CED blue.
- **Fix:** An `org_settings` record per organization (name, logo, address,
  phone, license, default tax rate, brand color) editable in **Settings**.
  Make job codes, forms, and tax defaults per-org. Letterhead reads from the
  org, not a constant.

### B4 — No subscription billing (to charge YOUR customers)  🟠 high
- **Now:** The app has a *customer* billing module, but no way for **you** to bill
  the contractors who use the app.
- **Fix:** Stripe subscriptions (plan tiers, trial, customer portal), a
  `subscriptions` table, and gating when a subscription lapses.

---

## 3. Security findings

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| S1 | 🟠 High | `public.current_role()` **shadows a built-in Postgres function/keyword**. Works today (schema-qualified) but fragile and confusing. | Rename to `app_user_role()`; update policies. |
| S2 | 🟠 High | `/api/timeclock/nudge` **fails open** — if `CRON_SECRET` is unset it runs unauthenticated and returns staff names + phone numbers. | Fail closed: 401 unless the secret is set **and** matches. |
| S3 | 🟡 Med | CRM + Inventory search interpolate raw user text into PostgREST `.or()` filters → filter-injection / breakage on commas/special chars. | Sanitize/escape input or use parameterized `textSearch`/`ilike` per-column. |
| S4 | 🟡 Med | AI endpoints (`/api/chat`, quote/material drafts) have **no rate limiting** — cost & abuse risk once public. | Per-user rate limit + max length; consider per-org usage caps. |
| S5 | 🟡 Med | Email confirmation is recommended **off** for setup. Fine for dev, unsafe for prod. Also no password strength policy. | Turn confirmation on for prod; document; enable leaked-password protection. |
| S6 | 🟢 Low | No audit log of sensitive changes (role changes, deletes, payments). | Add an `activity_log` table for key mutations. |
| S7 | 🟢 Low | Service-role key is server-only (good) but used via `require()` in `server.ts`. | Keep server-only; add an `import "server-only"` guard. |

---

## 4. Customizability assessment

| Area | Today | For a sellable product |
|------|-------|------------------------|
| Company identity (name, logo, address, license) | Hardcoded in `company.ts` | Per-org settings + logo upload |
| Branding / theme color | Fixed CED blue | Per-org brand color (white-label) |
| Job codes | Global seed | Per-org, editable in Settings |
| Tax rate | Entered per quote | Per-org default, overridable |
| Forms | Global templates | Per-org templates |
| Document footer / terms | Hardcoded strings | Per-org editable |
| Email "from"/reply-to | N/A (no email yet) | Per-org sender identity |

---

## 5. Correctness / robustness / ops

- **No tests, no CI.** Add a smoke-test suite + GitHub Actions running
  `build`/`typecheck` on PRs.
- **Number sequences are global** (`quote_number_seq`, etc.) — once multi-tenant,
  customers would see non-sequential numbers and infer each other's volume.
  Move to per-org counters.
- **Error handling** is decent (friendly action errors) but there's **no global
  error boundary / not-found polish**, and server actions surface raw DB messages
  to the UI in places.
- **Timeclock GPS / voice** rely on browser APIs (geolocation, Web Speech) — work
  on Chrome/Safari but degrade silently elsewhere; acceptable, document it.
- **`one_open_entry_per_user`** depends on parsing the DB error string — brittle
  if Postgres wording changes.
- **N+1-ish reads** in a few list pages (fine at small scale; revisit later).
- **Accessibility / mobile**: generally responsive; needs a pass for form labels,
  focus states, and the mobile timeclock flow.

---

## 6. Recommended sequence

**Phase 0 — Security quick wins (small, do first):** S1, S2, S3, S7.

**Phase 1 — Multi-tenancy (the big one):** organizations + `org_id` everywhere +
RLS rewrite + per-org numbering. This is the foundation; everything else builds
on it.

**Phase 2 — Onboarding & team:** create-org-on-signup, owner role, team invites,
onboarding wizard.

**Phase 3 — Per-tenant customization:** `org_settings`, logo upload, letterhead
from settings, per-org job codes / tax / forms, optional brand color.

**Phase 4 — Subscription billing:** Stripe plans, trial, gating.

**Phase 5 — QA & hardening:** functional click-test of every module against a
live DB, smoke tests + CI, rate limiting, error boundaries, a11y pass.

### Functional QA checklist (Phase 5, run against live Supabase)
- [ ] Sign up → land in app; profile row created by trigger
- [ ] CRM: create/search/open customer; statuses
- [ ] Quotes: build, AI draft (with key), save, status, **Print/PDF**
- [ ] Schedule: create job; appears on agenda
- [ ] Work Orders: create from job, assign, status
- [ ] Timeclock: clock in (GPS prompt), lunch, dictate note, clock out; weekly totals
- [ ] Materials: AI take-off, edit items, totals
- [ ] Purchasing: PO from material list, receive lines, status rolls
- [ ] Inventory: add item, low-stock flag, +/- qty
- [ ] Change Orders: create, approve/reject, totals
- [ ] Forms: build form, fill, attach to job, view submission
- [ ] Billing: invoice from quote, record payment, status → paid, **Print/PDF**
- [ ] Assistant: streaming chat (with key); graceful message without key
- [ ] RLS: a `tech` cannot see others' time entries / cannot write office data

---

## 7. What's genuinely good (keep)

- Clean Next.js 15 App Router structure; server actions; typed DB layer.
- RLS is present and role-aware (just needs the org dimension).
- Coherent end-to-end workflow already wired (lead → quote → job → WO → PO →
  timeclock → change order → invoice → payment).
- Sensible, consistent UI components; responsive shell; print/PDF docs.
- Secrets handled correctly (anon vs service-role separation).
