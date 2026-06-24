-- job_codes.code was GLOBALLY unique (job_codes_code_key), so a SECOND org couldn't
-- have a code a prior org already used (both wanting "SVC", "REPAIR", …) — the
-- create_organization seed silently skipped them via ON CONFLICT DO NOTHING. Make the
-- code unique PER ORG so each company owns its own code namespace (and the trade seed
-- + templates work for every org).
alter table public.job_codes drop constraint if exists job_codes_code_key;
create unique index if not exists job_codes_org_code_uidx on public.job_codes (org_id, code);
