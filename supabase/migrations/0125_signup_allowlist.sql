-- INVITE-ONLY LOCKDOWN (2026-07-13). A bot signed up on 7/8 through the open public
-- signup — and the anon key means a bot can POST straight to GoTrue's /auth/v1/signup
-- without ever touching the site, so the gate must live AT THE DATABASE, not in the UI.
--
-- The gate: a BEFORE INSERT trigger on auth.users refuses any new account whose email
-- isn't invited. "Invited" = any of:
--   (a) signup_allowlist        — platform-level approvals Erik grants by hand,
--   (b) invitations (pending)   — an org's team invites (they sign up with that email),
--   (c) site_collaborators (unclaimed) — SEO-collaborator invites.
-- Existing users are untouched (insert-only trigger = grandfathered for free).
-- createEmployee/importCrew (service-role admin.createUser) also pass through this
-- trigger — the app pre-allowlists those emails right before creating the login.

create table if not exists public.signup_allowlist (
  email      text primary key,          -- stored lowercase
  note       text,                      -- who/why ("Danny Mulvihil — Erik approved 7/13")
  created_at timestamptz not null default now()
);

-- Service-role / definer access only: RLS on, no policies — invisible to clients.
alter table public.signup_allowlist enable row level security;

-- One shared eligibility check. SECURITY DEFINER so it can read the gate tables;
-- also exposed to anon so the signup form can show a clean "invite-only" message
-- instead of a raw Postgres error (the boolean "is this email invited" is the same
-- signal the signup endpoint itself would reveal, so this leaks nothing new).
create or replace function public.signup_allowed(p_email text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    exists (select 1 from public.signup_allowlist  where email = lower(trim(p_email)))
    or exists (select 1 from public.invitations    where lower(email) = lower(trim(p_email)) and accepted_at is null)
    or exists (select 1 from public.site_collaborators where lower(invited_email) = lower(trim(p_email)) and user_id is null);
$$;
grant execute on function public.signup_allowed(text) to anon, authenticated;

create or replace function public.enforce_signup_allowlist()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if not public.signup_allowed(new.email) then
    raise exception 'signup_not_allowed: Contractor North is invite-only';
  end if;
  return new;
end $$;

drop trigger if exists enforce_signup_allowlist on auth.users;
create trigger enforce_signup_allowlist
  before insert on auth.users
  for each row execute function public.enforce_signup_allowlist();
