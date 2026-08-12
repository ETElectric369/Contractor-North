-- 0195 — THE CREW CAN FILE THE FORM THAT IS FOR THE CREW.
--
-- Audit 6. Every org ships with a "Job Site Safety Checklist" and it is offered to techs on a
-- phone. `submitForm` checks only that somebody is signed in, then inserts — but
-- form_submissions_write requires is_org_staff(), so a tech's Submit is refused by RLS.
--
-- The whole feature is field-facing and only the office can use it. `form_submissions` holds zero
-- rows in production, which is the tell: nobody has ever successfully filed one.
--
-- ── WHY AN INSERT-ONLY POLICY, NOT is_member() ON THE EXISTING ONE ──────────────────────────
--
-- Relaxing form_submissions_write (an ALL policy) to is_member() would also hand every tech
-- UPDATE and DELETE on everybody else's filed safety record. A signed safety checklist is exactly
-- the document that must not be quietly editable by the person it might implicate.
--
-- Postgres permissive policies OR together, so a narrow INSERT policy beside the existing ALL one
-- gives the crew the one verb they need and changes nothing for staff.
--
-- THREE CONDITIONS, each load-bearing:
--   org_id = auth_org_id()        the tenant boundary, same as every other policy here.
--   submitted_by = auth.uid()     you may file as YOURSELF and nobody else. submitForm sets this
--                                 server-side from the session, but a tech holding the anon key
--                                 can POST straight to PostgREST — this is what makes it true
--                                 rather than conventional.
--   is_member()                   profiles.active. 0158 made deactivation a real boundary, so an
--                                 offboarded crew member must not be able to file either. Leaving
--                                 it out would have quietly reopened that.
--
-- READ is unchanged: form_submissions_read is already org-wide, so a crew member can see what the
-- crew filed, which is the point of a safety checklist.

create policy form_submissions_insert_own on public.form_submissions
  for insert to authenticated
  with check (
    org_id = public.auth_org_id()
    and submitted_by = auth.uid()
    and public.is_member()
  );
