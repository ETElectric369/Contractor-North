-- 0266 — A TECH MAY SEE THE DAYS HIS JOBS RUN
--
-- Found by the reviewer of wave 5, and the fix it asked for is smaller than the workaround.
--
-- job_schedule_segments has carried exactly one policy since the table was made (0040):
--     job_schedule_segments_rw  FOR ALL  USING (org_id = auth_org_id() AND is_org_staff())
-- Staff-only for READING as well as writing. Nothing in the app noticed, because until this week
-- only staff surfaces read it.
--
-- Then "Next Up" landed on the Clock, which is the page a TECH opens at six in the morning to see
-- what he is on. Its schedule tier reads those rows, gets nothing, and falls back to mirroring the
-- job's own scheduled_start → scheduled_end window. The job-less clock-in (resolveTechJobToday,
-- migration 0139's tier 1) reads the same table, gets the same nothing, and mirrors only the START
-- DAY. Two surfaces, the same question, two different coarse answers — so on day two of a
-- three-day job the card could say "22 Pine" while the punch resolved to something else. A card
-- and a punch that disagree about where a man is, is the exact failure the precedence law exists
-- to prevent.
--
-- The honest fix is not to align two workarounds, it is to let the man read the rows. Seeing which
-- DAYS his own company's jobs run is not privileged information — it is the schedule. The precedent
-- is already in the database, one migration over: crew_day_assignments_read (0139) is
-- `for select using (org_id = auth_org_id())`, whose own note reads "a tech may see where the week
-- puts them". This is the same sentence about a different table.
--
-- WRITING stays exactly where it was. Only staff may create, move or delete a segment; the existing
-- FOR ALL policy keeps that, because a narrower SELECT policy beside it does not widen any other
-- verb. Both surfaces now read real segments, the mirror stays only as the fallback for a job whose
-- segments were never written, and they agree because they are reading the same rows.

drop policy if exists job_schedule_segments_read on public.job_schedule_segments;
create policy job_schedule_segments_read on public.job_schedule_segments
  for select using (org_id = public.auth_org_id());

comment on table public.job_schedule_segments is
  'The days a job actually runs (0040). Staff write; EVERY org member reads (0266) — the Clock''s Next Up and the job-less clock-in both resolve a tech''s day through these rows, and a tech who cannot read them gets a coarser answer than the office, which is how a card and a punch came to disagree about where a man was.';

-- PROVE IT (by hand): as a tech's JWT, `select count(*) from job_schedule_segments;` returns the
-- org's rows rather than 0, and `insert into job_schedule_segments ...` is still refused.
