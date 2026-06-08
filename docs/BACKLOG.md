# Contractor North — Backlog (from whiteboard notes)

Refined from handwritten notes. Status: ✅ done · 🟡 partial · ⬜ new.
Size: XS (<1h) · S (≈half day) · M (≈1–2 days) · L (multi-day).

## 1. Auth & access — quick wins
- ⬜ **XS — Show/hide password toggle** on login + signup (the "eye" icon).
- ⬜ **S — Forgot password** flow: "Forgot password?" link → email reset
  (Supabase `resetPasswordForEmail`) → `/reset` page to set a new one. Uses
  Supabase's built-in email, no extra service needed.

## 2. Leads & follow-up
- 🟡 **S — Leads section**: customers already have a `lead` status. Add a Leads
  view (filter to leads) with **follow-up tracking** — last-contacted date,
  next-follow-up date, "mark contacted", and convert lead → active.
  (Adds `last_contacted_at` / `next_follow_up_at` columns.)

## 3. Timecard depth (employee end-of-day)
- 🟡 **M — Multiple jobs per day on one timecard.** Today a clock entry has a
  single job/code. The note wants an end-of-day breakdown: Job 1 (hrs+min, job
  code, description), Job 2 (…), etc. Design: a `time_allocations` table
  (entry_id or day, job_id, job_code, hours, description) the tech fills at
  clock-out, summing to the day's hours.
- 🟡 **M — End-of-day report form** ("fill out form"): the per-job breakdown
  above + "what did you do today" (already captured). One screen at clock-out.
- ✅ Clock IN / LUNCH / OUT, GPS, job codes — built & verified.

## 4. SMS / reminders (Twilio)
- 🟡 **S — Twilio wiring**: `/api/timeclock/nudge` already has a Twilio-ready
  `sendSms()` stub. Add `TWILIO_*` env vars to turn on real texts. *(Needs a
  Twilio account + number.)*
- 🟡 **S — "No clock-in" nagging**: cron endpoint exists; add escalating/repeat
  reminders ("nagging af") until they clock in.
- ⬜ **M — "End-of-day not submitted" nagging**: after a shift, if no end-of-day
  form, text the tech (and/or office) on a schedule until done.

## 5. Spanish for employees
- ⬜ **L — Spanish interface (i18n)** for employee-facing screens (timeclock,
  end-of-day form, login). Add an i18n layer + a language toggle on the profile;
  translate the tech-facing strings first.
- ⬜ **S — Claude in Spanish**: the assistant can guide employees in Spanish
  (language-aware system prompt + the tech's preferred language). *(Needs the
  `ANTHROPIC_API_KEY` switched on.)*

## Dependencies / decisions needed
- **Twilio account** (for items in §4).
- **`ANTHROPIC_API_KEY`** in Vercel (for §5 Claude-in-Spanish + existing AI).
- **i18n scope** — employee screens only, or the whole app? (Recommend employee
  screens first.)

## Suggested order
1. §1 auth quick wins (XS+S, self-contained, you hit login constantly).
2. §2 Leads + follow-up (S, immediate sales value).
3. §3 multi-job end-of-day timecard (M, core to the timeclock vision).
4. §4 Twilio + nagging (once Twilio account exists).
5. §5 Spanish (L) — last, biggest, benefits from the rest being stable.
