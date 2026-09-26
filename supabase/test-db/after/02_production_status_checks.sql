-- PARITY: production has two CHECK constraints that no migration creates (made by hand or by the
-- dashboard long ago). The test database must refuse what production refuses, so they are copied
-- here exactly as production defines them (read-only catalog read, 2026-09-26). Every status value
-- on production satisfies them.

alter table public.bug_reports
  add constraint bug_reports_status_check
  check (((status IS NULL) OR (status = ANY (ARRAY['open'::text, 'fixed'::text, 'wontfix'::text]))));

alter table public.inquiries
  add constraint inquiries_status_check
  check (((status IS NULL) OR (status = ANY (ARRAY['new'::text, 'contacted'::text, 'quoted'::text, 'won'::text, 'lost'::text]))));
