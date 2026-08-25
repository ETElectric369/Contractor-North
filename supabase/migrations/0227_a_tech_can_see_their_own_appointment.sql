-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0227: a tech can see the appointment assigned to them
--
-- Erik, deciding the rule: "techs dont need to see anything but whats assigned to them or
-- available to them to pick from so if they get assigned an appointment then sure, right?"
--
-- Right — and today they cannot. `appointments_rw` is a single FOR ALL policy gated on
-- is_org_staff() (owner/admin/office), so a tech's SELECT on appointments returns zero rows
-- ALWAYS, no matter whose name is on it. Jobs are org-wide readable (0004); appointments never
-- were, and nothing said so.
--
-- ── THE BROKEN LOOP THAT PROVES IT ─────────────────────────────────────────────────────────
--
-- listActiveTechs returns every active profile, so the appointment assignee dropdown offers
-- techs. createAppointment then pushes "New appointment assigned" to the chosen tech with
-- url: /schedule?view=day&date=… . /schedule redirects non-staff to /planner, and /planner's
-- appointment query returns nothing for them because of this policy. So the app:
--   1. lets the office assign a walk-through to Brian,
--   2. sends Brian a notification about it,
--   3. and shows him an empty screen when he taps it.
-- Three subsystems each behaving correctly on their own, meeting at a gap none of them owns.
--
-- ── WHAT CHANGES, AND WHAT DELIBERATELY DOESN'T ────────────────────────────────────────────
--
-- READ widens to "staff, OR it is assigned to me". Exactly the shape time_entries already uses
-- (profile_id = auth.uid() or is_org_staff()) — the same rule, so there is one idea to learn
-- rather than two.
--
-- WRITE stays staff-only. A tech seeing their own walk-through is not a tech rescheduling it,
-- cancelling it, or reassigning it to somebody else. The capture flow they need writes to
-- appointments.inspection_answers via saveInspectionAnswers, which is a server action running
-- its own guard — that path is unaffected because it does not depend on a tech holding UPDATE.
--
-- The second half of Erik's rule — "or available to them to pick from" — is an open pool of
-- claimable work and is NOT built here. It needs a way to mark an appointment claimable and a
-- way to claim it, neither of which exists. Filed, not smuggled in.
--
-- No appointment is currently assigned to a non-staff member (checked: 25 assigned, all to
-- owners), so nothing becomes newly visible today. This makes the notification path honest
-- before the first tech is assigned rather than after.
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists appointments_rw on public.appointments;

-- READ: staff see the whole org's calendar; everyone else sees only what is theirs.
create policy appointments_select on public.appointments
  for select using (
    org_id = public.auth_org_id()
    and (public.is_org_staff() or assigned_to = auth.uid())
  );

-- WRITE: unchanged — office only. Split into its own policy so the read can widen without the
-- write following it, which a single FOR ALL policy could not express.
create policy appointments_write on public.appointments
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
