-- 0185: THE PUBLIC INTAKE DOOR (2026-08-05)
--
-- Erik: "figure out how to setup the inspector for the customer facing website ... he is already
-- using wix so we want to embed a link or portal ... we need a playbook for that or is it built
-- in?" — plus three of Andrew's bug-report feature requests asking for the same thing (a public
-- "request an estimate" button/QR, a customer-facing intake that feeds the lead funnel).
--
-- One flag on forms: the org's CUSTOMER-FACING intake playbook. A separate small playbook, never
-- the walk-through — the walk-through is the CONTRACTOR's question set ("decides subpanel or home
-- runs" is a question he answers standing at the panel), and its why lines are his pricing logic,
-- which must never render on a public page.
--
-- No anon RLS policy ON PURPOSE: the public route reads through the service client by handle
-- (same pattern as getPublicOrgByHandle), so the table stays un-enumerable from the outside —
-- the tenant-isolation lesson (0173) applied from day one, not retrofitted.
alter table public.forms
  add column if not exists is_public_intake boolean not null default false;

-- One public door per org — two flagged forms would make "which questions does my website ask"
-- ambiguous, and ambiguity in a public surface is a support call.
create unique index if not exists one_public_intake_per_org
  on public.forms (org_id) where is_public_intake;
