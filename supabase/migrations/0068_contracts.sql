-- Contracts (Phase 2 of the deal-to-cash spine): a signable agreement generated from
-- a job — auto-filled with the parties, property, dates, billing model + payment
-- schedule, and terms. The customer reviews and e-signs it on a public /c/[token]
-- page; the signature (typed name + timestamp + IP) is captured and the body frozen.
-- Mirrors the quotes + public_quote/accept_public_quote patterns.

create table if not exists public.contracts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid references public.organizations(id) on delete cascade,
  contract_number   text,
  customer_id       uuid references public.customers(id) on delete set null,
  job_id            uuid not null references public.jobs(id) on delete cascade,
  status            text not null default 'draft' check (status in ('draft', 'sent', 'signed', 'void')),
  title             text not null default 'Service contract',
  body              text not null default '',           -- the full agreement text (frozen once sent/signed)
  public_token      text unique not null default encode(gen_random_bytes(16), 'hex'),
  signed_at         timestamptz,
  signed_name       text,
  signed_ip         text,
  signed_user_agent text,
  signed_body       text,                              -- exact agreement text frozen at sign time (the legal record of WHAT was signed)
  created_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.contracts add column if not exists signed_body text;

create index if not exists contracts_job_idx on public.contracts(org_id, job_id);
create index if not exists contracts_token_idx on public.contracts(public_token);
-- At most one live (non-void) contract per job — DB-authoritative, beats the app-level
-- check-then-insert race. Multiple voided rows are allowed.
create unique index if not exists contracts_one_live_per_job
  on public.contracts(job_id) where status <> 'void';

alter table public.contracts enable row level security;

-- org_id auto-stamp + per-org contract numbering (C-00001), reusing next_doc_number.
drop trigger if exists stamp_org_contracts on public.contracts;
create trigger stamp_org_contracts before insert on public.contracts
  for each row execute function public.set_org_id();

create or replace function public.number_contracts() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then new.org_id := public.auth_org_id(); end if;
  if new.contract_number is null or new.contract_number = '' then
    new.contract_number := public.next_doc_number(new.org_id, 'contract', 'C-');
  end if;
  return new;
end $$;
drop trigger if exists number_contracts on public.contracts;
create trigger number_contracts before insert on public.contracts
  for each row execute function public.number_contracts();

-- Freeze the agreement at the DB layer (not just in the server actions): once a
-- contract is sent or signed, its wording can't change, and a signed signature record
-- is immutable. Status transitions (draft->sent, sent->signed/void) and the signed_*
-- writes are still allowed.
create or replace function public.contracts_freeze() returns trigger
  language plpgsql set search_path = public as $$
begin
  if old.status in ('sent', 'signed')
     and (new.body is distinct from old.body or new.title is distinct from old.title) then
    raise exception 'A sent or signed contract''s wording cannot be changed.';
  end if;
  if old.status = 'signed'
     and (new.signed_at is distinct from old.signed_at
          or new.signed_name is distinct from old.signed_name
          or new.signed_body is distinct from old.signed_body
          or new.signed_ip is distinct from old.signed_ip
          or new.signed_user_agent is distinct from old.signed_user_agent) then
    raise exception 'A signed contract''s signature record is immutable.';
  end if;
  return new;
end $$;
drop trigger if exists contracts_freeze on public.contracts;
create trigger contracts_freeze before update on public.contracts
  for each row execute function public.contracts_freeze();

-- Org members read; staff write (same shape as quotes/invoices).
drop policy if exists contracts_read on public.contracts;
create policy contracts_read on public.contracts
  for select using (org_id = public.auth_org_id());
drop policy if exists contracts_write on public.contracts;
create policy contracts_write on public.contracts
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

-- Public, anon-callable read of a contract by its share token (whitelisted fields).
create or replace function public.public_contract(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'contract', json_build_object(
      'contract_number', c.contract_number, 'status', c.status, 'title', c.title,
      'body', c.body, 'signed_body', c.signed_body, 'signed_at', c.signed_at,
      'signed_name', c.signed_name, 'created_at', c.created_at),
    'customer', (select json_build_object('name', cu.name, 'company_name', cu.company_name,
      'address', cu.address, 'city', cu.city, 'state', cu.state, 'zip', cu.zip)
      from public.customers cu where cu.id = c.customer_id),
    -- Whitelist org branding/contact only — NEVER to_jsonb(org), which would leak
    -- settings, stripe ids, and subscription state to anyone with the link.
    'org', (select json_build_object(
        'name', o.name, 'logo_url', o.logo_url, 'address_line1', o.address_line1,
        'address_line2', o.address_line2, 'city', o.city, 'state', o.state, 'zip', o.zip,
        'phone', o.phone, 'email', o.email, 'license', o.license,
        'brand_color', o.brand_color, 'doc_template', o.doc_template, 'doc_templates', o.doc_templates)
      from public.organizations o where o.id = c.org_id)
  )
  -- Only a shareable contract is public: a draft (not yet sent) or a voided one
  -- returns null -> the page 404s. Mirrors the accept_public_quote status guard.
  from public.contracts c where c.public_token = p_token and c.status in ('sent', 'signed');
$$;
grant execute on function public.public_contract(text) to anon, authenticated;

-- E-sign: only a SENT contract can be signed; idempotent once signed. Captures the
-- typed name, timestamp, and (from the API route) the signer's IP + user agent.
create or replace function public.sign_contract(p_token text, p_name text, p_ip text, p_ua text)
returns json language plpgsql security definer set search_path = public as $$
declare c public.contracts;
begin
  select * into c from public.contracts where public_token = p_token;
  if c.id is null then return json_build_object('ok', false, 'error', 'Contract not found.'); end if;
  if c.status = 'signed' then return json_build_object('ok', true); end if;
  if c.status <> 'sent' then
    return json_build_object('ok', false, 'error', 'This contract is no longer available to sign.');
  end if;
  if p_name is null or btrim(p_name) = '' then
    return json_build_object('ok', false, 'error', 'Please type your full name to sign.');
  end if;
  update public.contracts
     set status = 'signed', signed_at = now(), signed_name = btrim(p_name),
         signed_ip = p_ip, signed_user_agent = p_ua, signed_body = c.body, updated_at = now()
   where id = c.id;
  return json_build_object('ok', true);
end $$;
grant execute on function public.sign_contract(text, text, text, text) to anon, authenticated;
