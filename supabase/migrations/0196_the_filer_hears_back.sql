-- 0196 — THE PERSON WHO FILED A BUG HEARS BACK WHEN IT SHIPS.
--
-- Transcript mining (2026-08-15): Andrew filed the address-split ask THREE TIMES across four days.
-- Not because it was hard — because nothing ever told him what happened to a filing. bug.resolve
-- exists; the notification does not. A loop with no return leg teaches the filer that filing is
-- shouting into a well, and a beta tester who stops filing is a beta programme that has quietly
-- ended.
--
-- One column: when the FILER was told about this report's resolution. Null = not yet told. The
-- chat route reads the caller's own fixed/closed reports where this is null, has Nort open with
-- "since we last talked, these shipped", and stamps it. Stamped on INJECTION rather than on
-- confirmed delivery — if they close the tab mid-sentence they miss one digest, which is cheaper
-- than the machinery to know what a person actually read.

alter table public.bug_reports
  add column if not exists filer_notified_at timestamptz;

comment on column public.bug_reports.filer_notified_at is
  'When Nort told the FILER this report was resolved (0196). Null = a resolved report the filer has not heard about yet; the chat route announces and stamps it.';
