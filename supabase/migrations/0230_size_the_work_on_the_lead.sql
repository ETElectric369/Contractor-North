-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0230: size the work where you first hear about it
--
-- Erik: "lets connect it with the lead, i should be able to mark the lead when it shows up if its
-- not already marked by the dropdown menu and enter the estimated time its going to take … but it
-- looks like the lead options arent interconnected with the schedule badges yet but if we enter
-- that data on the lead view itself and editable on the schedule page we might be getting
-- somewhere."
--
-- 0229 gave jobs and appointments a duration, and the rail duly showed "—" against everything,
-- because nothing sizes work at the moment the work is first described. THE PHONE CALL IS WHERE
-- THE ANSWER IS: whoever takes it already knows this is a two-hour service call or a full-day
-- panel swap. Asking for it later, on a calendar, asks somebody to remember what they were told.
--
-- ── WHY NOT REUSE inquiries.type ───────────────────────────────────────────────────────────
--
-- That column already means residential / commercial. Overloading it would put two unrelated
-- questions in one field and quietly break every reader of the first one.
--
-- ── ONE VOCABULARY, NOT A THIRD ────────────────────────────────────────────────────────────
--
-- `work_kind` stores the app's single WorkKind vocabulary (lib/schedule/work-shape): job,
-- walkthrough, service, office, quote, other. Those already map onto appointments.type when a
-- lead is booked — walkthrough→inspection, service→service_call, office→meeting — so the tag the
-- office picks on the lead is the tag that shows on the calendar. That mapping is the whole point
-- of his "interconnected": the badge does not get re-decided at each stage.
--
-- BOTH NULLABLE. Fragment-first, and this is the field most likely to be skipped on a rushed call.
-- An unsized lead is not an error; it renders "—" and is still perfectly schedulable. The one
-- thing the app must never do is refuse to take a lead because nobody knew how long it would take.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.inquiries add column if not exists planned_minutes integer;
alter table public.inquiries add column if not exists work_kind text;

alter table public.inquiries drop constraint if exists inquiries_planned_minutes_sane;
alter table public.inquiries add  constraint inquiries_planned_minutes_sane
  check (planned_minutes is null or (planned_minutes > 0 and planned_minutes <= 60 * 24 * 30));

-- A closed set, so a typo can never invent a sixth kind that renders as a blank badge forever.
alter table public.inquiries drop constraint if exists inquiries_work_kind_known;
alter table public.inquiries add  constraint inquiries_work_kind_known
  check (work_kind is null or work_kind in ('job', 'walkthrough', 'service', 'office', 'quote', 'other'));

comment on column public.inquiries.planned_minutes is
  'How long the office expects this to take, entered on the LEAD where the caller already knows. '
  '60 = an hour, 480 = a working day. Carried onto the appointment when booked. Null = unsized, '
  'which renders as a dash and never as zero.';
comment on column public.inquiries.work_kind is
  'The app-wide WorkKind vocabulary (lib/schedule/work-shape), NOT inquiries.type — that one means '
  'residential/commercial. Maps to appointments.type at booking so the tag chosen on the lead is '
  'the tag shown on the calendar.';

-- ── ONE HONEST INFERENCE ───────────────────────────────────────────────────────────────────
-- A lead the triage already flagged as needing a site visit IS a walk-through — that is what the
-- flag means, so reading it is not a guess. Nothing else is inferred: the rest stay null so Erik
-- can tell what he has told the app from what the app decided on its own.
update public.inquiries
   set work_kind = 'walkthrough'
 where work_kind is null and site_inspection_required is true;
