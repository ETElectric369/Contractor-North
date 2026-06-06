-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — seed data (run AFTER 0001_init.sql)
-- Safe to run multiple times: uses ON CONFLICT guards where it matters.
-- ═══════════════════════════════════════════════════════════════════════════

-- Standard electrical labor / cost codes for the timeclock.
insert into public.job_codes (code, description, billable) values
  ('SVC',   'Service call',            true),
  ('ROUGH', 'Rough-in wiring',         true),
  ('TRIM',  'Trim-out / devices',      true),
  ('PANEL', 'Panel / service upgrade', true),
  ('TROUB', 'Troubleshooting',         true),
  ('LOW',   'Low voltage / data',      true),
  ('GEN',   'Generator install',       true),
  ('TRAVEL','Travel time',             true),
  ('SHOP',  'Shop / yard time',        false),
  ('PTO',   'Paid time off',           false)
on conflict (code) do nothing;

-- A starter inspection form (dynamic schema is a JSON array of field defs).
insert into public.forms (name, description, schema)
select
  'Job Site Safety Checklist',
  'Quick pre-work safety walkthrough.',
  '[
    {"key":"ppe","label":"PPE worn (hard hat, glasses, gloves)","type":"checkbox"},
    {"key":"loto","label":"Lockout/Tagout applied where required","type":"checkbox"},
    {"key":"voltage_verified","label":"Verified de-energized with meter","type":"checkbox"},
    {"key":"hazards","label":"Hazards noted","type":"textarea"},
    {"key":"photos","label":"Site photos attached","type":"checkbox"}
  ]'::jsonb
where not exists (select 1 from public.forms where name = 'Job Site Safety Checklist');

-- NOTE: customers / jobs / quotes are best created through the app so that
-- created_by points at a real signed-in user. Add demo rows here later if you
-- want a populated dashboard before inviting your crew.
