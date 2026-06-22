-- Contractor-protection (Phase 4 of the spine, from Erik's notes): lien-rights tracking
-- + insurance-claim capture, per job. CN TRACKS lien deadlines and generates the CA
-- 20-day Preliminary Notice; the recordable mechanics lien itself stays offline (it must
-- be notarized + recorded at the county). One optional record of each kind per job.

create table if not exists public.lien_records (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid references public.organizations(id) on delete cascade,
  job_id               uuid not null unique references public.jobs(id) on delete cascade,
  first_furnished_date date,                     -- first day labor/materials were furnished -> 20-day prelim clock
  completion_date      date,                     -- substantial completion -> 90-day lien-recording clock
  owner_name           text,
  owner_address        text,
  hired_by_name        text,                      -- §8102(a)(6): the person who contracted with the claimant
  gc_name              text,                      -- the direct/general contractor (when CN is a sub)
  gc_address           text,                      -- a sub must be able to SERVE the direct contractor
  noc_recorded         boolean not null default false,  -- owner recorded a Notice of Completion/Cessation -> shorter window
  lender_name          text,
  lender_address       text,
  estimated_amount     numeric(12,2),
  prelim_sent_at       date,                      -- when the Preliminary Notice was served
  lien_recorded_at     date,                      -- when the lien was recorded (offline) — closes the tracker
  notes                text,
  created_by           uuid references public.profiles(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists public.insurance_claims (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references public.organizations(id) on delete cascade,
  job_id          uuid not null unique references public.jobs(id) on delete cascade,
  carrier         text,
  claim_number    text,
  policy_number   text,
  adjuster_name   text,
  adjuster_phone  text,
  date_of_loss    date,
  notes           text,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- idempotent for DBs created before these columns were added
alter table public.lien_records add column if not exists hired_by_name text;
alter table public.lien_records add column if not exists gc_address text;
alter table public.lien_records add column if not exists noc_recorded boolean not null default false;

create index if not exists lien_records_org_idx on public.lien_records(org_id, job_id);
create index if not exists insurance_claims_org_idx on public.insurance_claims(org_id, job_id);

alter table public.lien_records enable row level security;
alter table public.insurance_claims enable row level security;

drop trigger if exists stamp_org_lien on public.lien_records;
create trigger stamp_org_lien before insert on public.lien_records
  for each row execute function public.set_org_id();
drop trigger if exists stamp_org_insurance on public.insurance_claims;
create trigger stamp_org_insurance before insert on public.insurance_claims
  for each row execute function public.set_org_id();

drop policy if exists lien_records_rw on public.lien_records;
create policy lien_records_rw on public.lien_records
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
drop policy if exists insurance_claims_rw on public.insurance_claims;
create policy insurance_claims_rw on public.insurance_claims
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
