# Backlog — whiteboard dump (2026-06-08)

Transcribed from Erik's handwritten notes. Loop works through these.

## ✅ Done immediately
- **Public inquiry portal / under-construction splash with live-lead capture** — `/inquire/[org]`
  (migration 0026). Submissions become leads in Inquiries. Erik's link:
  `https://contractor-north.vercel.app/inquire/60195593-2e18-4230-bc8e-7a32d36d038d`
  → Answers "can I post something online to get work now?" = YES.

## Compliance & documents
- **Insurance / Bond / License tracker** with **monthly reminder to submit current annual
  insurance & license** (W/C insurance, bond, contractor license, $/yr). HIGH value, self-contained.
- **Employee documents:** upload **Driver's License** (for company vehicle), I-9, W-2 forms.
- **OSHA** section (safety docs / logs).
- **Petty cash** tracker (with receipts).
- **"Organize my" hub:** receipts, notes, job docs (plans / survey / specs attached to jobs).

## Timeclock — labor law (CA)
- Require **break verification**: 2× 10-min breaks if worked **5+ hrs**; ≤5 hrs = 1× 10-min, no lunch.
- **Auto 30-min unpaid lunch**, with a "no adjustment" option.

## Mileage / tax / accounting
- Mileage calc to use **IRS standard rates (2026)**; tax-rate calcs from IRS site; "new 2026 laws
  per state." (We have mileage + mileage_rate + tax report — wire IRS rate references / per-state.)
- **Accounting + data packages per country** (multi-country support; we have currency/timezone).

## Scheduling
- **Automated scheduling**: propose **3 appointment dates**, customer confirms via **email link**,
  schedule auto-set. Compare schedules / coordinate client appointments. (Ties to automation engine.)

## Integrations / hardware
- **Camera access/control** (Ring etc.) — view job-site cameras.
- **Supplier integration** (CED portal) — pull pricing/orders. (Price List CSV import is step 1.)

## Business services
- **Business-card creator** + order business cards; order checks.
- **Pause & resume subscription** (billing).

## Notes
- "Building" — ambiguous (building dept/codes?) — clarify with Erik.
- Several of these (reminders, appointment confirmations) depend on the **automation/reminder
  engine** + email/SMS keys (Resend/Twilio), still dormant.

## From Erik's handwritten note (2026-06-10, via Organize My 📸)
- ~~Edit job → address autofill doesn't populate City/State/Zip~~ — could not reproduce in code
  (works; was the Vercel-app webview). Hardened suggestion taps (pointerdown) anyway.
- **Scheduler needs an overhaul** (no spec yet — ask what's wrong with it)
- **Bid metrics:** gas/mileage vs bid prices; adjust bid calcs by direct cost per region;
  field-time vs office-time direct cost comparison
- **Business Advisor** (AI advisory over the org's numbers?)
- **Recurring jobs** (Tradify parity — service reminders tie-in)
- ~~Organize to sandbox then Expenses~~ — DONE 2026-06-10 (needs-attention tray + overhead bills)
