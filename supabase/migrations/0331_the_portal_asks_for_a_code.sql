-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0331: the portal link asks for a code
--
-- ERIK, 2026-09-24, after opening Andrew's link himself: "it opened right up with no email
-- verification". The link is the whole key (0298): anyone it is forwarded to, or anyone who sees it
-- over a shoulder, reads the customer's jobs and money. And he did not want a new link every time:
-- "the same portal link will generate a new code so andrew can re-click the link from his messages
-- and get a new code sent".
--
-- THE SHAPE. The link the customer holds never changes. A device that is not signed in sees
-- "For your privacy, we'll email a 6-digit code to m*******@comcast.net" and Send My Code. The code
-- goes ONLY to the email on file for that customer (read here, never typed on the page), works for
-- 10 minutes and 5 tries, and the right one signs that device in for 30 days (sliding). New Link and
-- Turn Off end every session at once; the office sees "Signed in on N devices" and can sign them
-- all out.
--
-- WHO HASHES WHAT. The app draws the code and a per-row salt, hashes (sha256 of salt:code) and
-- compares in constant time (crypto.timingSafeEqual); the database never sees a code or a session
-- id in the clear, only their hashes. What the database owns is everything that has to be ATOMIC:
-- one live code per link, the 15-minute send window, the try counter (counted BEFORE the app
-- compares, under a row lock, so parallel guesses can't slip past 5), expiry, and the sessions.
-- The per-IP ceilings ride the existing rate_limits table (0098) from the app.
--
--  1. customer_portal_codes     one row per code sent; at most one live per customer (unique index).
--  2. customer_portal_sessions  one row per signed-in device (customer) or office look (office).
--  3. customer_portal_preview_tickets  the office's See What They See: a 2-minute, one-use ticket
--     that the portal trades for an 8-hour office session, so the office never needs the
--     customer's code and its looks never count as the customer's.
--  All three: RLS on, every client grant revoked, and one written-down deny policy (the 0299 shape:
--  rls.integration.test refuses "RLS on + zero policies" because on any other table it means an
--  accident). The service role bypasses RLS; every write goes through a function below.
--  4. A trigger on customer_portal_access: when the token changes (New Link) or the link is turned
--     off, every session, live code and unused ticket of that customer ends in the same statement.
--     portal_link_rotate / portal_link_set_enabled are NOT replaced: the trigger sees their writes.
--
-- No existing function is replaced, so nothing here starts from a live body. customer_portal and
-- portal_job_view keep their bodies (0323 and 0326 replace them independently); the app asks
-- portal_session_check first and only then calls them.
--
-- ORDER: apply this, THEN deploy the app. It is additive: the live app never names these objects.
-- An app deployed first finds no portal_gate and shows "This page isn't ready yet" (fail closed:
-- never the page without the code).
--
-- LIMITS PER LINK: 3 codes per 15 minutes, and at most 10 in a day (the 10th is reported to
-- error_events, so a customer flooded with codes isn't silent). 5 tries a code: at most 50 guesses a
-- link a day against a million codes. A code whose email didn't go out is taken back
-- (portal_code_void): it never counts, and the code it replaced works again.
--
-- WHAT ELSE ENDS A SESSION: a changed email on the customer (the device proved the OLD address, so
-- it signs in again against the new one), and for an office look, its staff member no longer being
-- active office staff (0158: deactivation is a database boundary), checked on every page load.
--
-- SMS: channel is 'email' | 'sms'. portal_code_issue answers 'sms' with channel_unavailable until
-- texting is live; that branch is where the customer's phone gets read.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. codes ────────────────────────────────────────────────────────────────────────────────────
create table public.customer_portal_codes (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customer_portal_access(customer_id) on delete cascade,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  channel       text not null default 'email' check (channel in ('email', 'sms')),
  code_salt     text not null check (code_salt ~ '^[0-9a-f]{32}$'),
  code_hash     text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  attempts      int not null default 0 check (attempts between 0 and 5),
  consumed_at   timestamptz,
  superseded_at timestamptz
);
comment on table public.customer_portal_codes is
  'PRIVATE (0331): sign-in codes for /portal/<token>. Hashes only. Written by portal_code_issue / portal_code_try / portal_code_redeem; service role only.';
create index customer_portal_codes_customer_idx on public.customer_portal_codes(customer_id, created_at desc);
-- One live code per link: sending a new one supersedes the old one first.
create unique index customer_portal_codes_one_live
  on public.customer_portal_codes(customer_id)
  where consumed_at is null and superseded_at is null;

-- ── 2. sessions ─────────────────────────────────────────────────────────────────────────────────
create table public.customer_portal_sessions (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customer_portal_access(customer_id) on delete cascade,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  session_hash  text not null unique check (session_hash ~ '^[0-9a-f]{64}$'),
  kind          text not null default 'customer' check (kind in ('customer', 'office')),
  started_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);
comment on table public.customer_portal_sessions is
  'PRIVATE (0331): devices signed in to /portal/<token> (the cookie holds the id; only its sha256 is here). kind office = the office''s See What They See. Service role only.';
create index customer_portal_sessions_customer_idx on public.customer_portal_sessions(customer_id);

-- ── 3. the office's look ────────────────────────────────────────────────────────────────────────
create table public.customer_portal_preview_tickets (
  ticket_hash   text primary key check (ticket_hash ~ '^[0-9a-f]{64}$'),
  customer_id   uuid not null references public.customer_portal_access(customer_id) on delete cascade,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  created_by    uuid not null references public.profiles(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz
);
comment on table public.customer_portal_preview_tickets is
  'PRIVATE (0331): one-use, 2-minute tickets the office''s See What They See trades for an office session on the portal host. Service role only.';
create index customer_portal_preview_tickets_customer_idx on public.customer_portal_preview_tickets(customer_id);

alter table public.customer_portal_codes enable row level security;
alter table public.customer_portal_sessions enable row level security;
alter table public.customer_portal_preview_tickets enable row level security;

revoke all on public.customer_portal_codes from public, anon, authenticated;
revoke all on public.customer_portal_sessions from public, anon, authenticated;
revoke all on public.customer_portal_preview_tickets from public, anon, authenticated;
grant all on public.customer_portal_codes to service_role;
grant all on public.customer_portal_sessions to service_role;
grant all on public.customer_portal_preview_tickets to service_role;

create policy "service role only - every other role is denied" on public.customer_portal_codes
  for all using (false) with check (false);
create policy "service role only - every other role is denied" on public.customer_portal_sessions
  for all using (false) with check (false);
create policy "service role only - every other role is denied" on public.customer_portal_preview_tickets
  for all using (false) with check (false);

-- ── 4. New Link and Turn Off end every session at once ──────────────────────────────────────────
create or replace function public.customer_portal_access_ends_sessions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.customer_portal_sessions where customer_id = new.customer_id;
  delete from public.customer_portal_preview_tickets where customer_id = new.customer_id;
  update public.customer_portal_codes
     set superseded_at = now()
   where customer_id = new.customer_id and consumed_at is null and superseded_at is null;
  return null;
end $$;
revoke execute on function public.customer_portal_access_ends_sessions() from public, anon, authenticated;

create trigger customer_portal_access_ends_sessions
  after update of token, enabled on public.customer_portal_access
  for each row
  when (old.token is distinct from new.token or (old.enabled and not new.enabled))
  execute function public.customer_portal_access_ends_sessions();

-- A changed email ends the customer's signed-in devices and the live code: each device proved the
-- OLD address, and a code sent there must not open the page once the office has corrected it.
-- (Case and spaces aren't a change. An office look is not the customer's and stays.)
create or replace function public.customer_email_ends_portal_sessions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.customer_portal_sessions where customer_id = new.id and kind = 'customer';
  update public.customer_portal_codes
     set superseded_at = now()
   where customer_id = new.id and consumed_at is null and superseded_at is null;
  return null;
end $$;
revoke execute on function public.customer_email_ends_portal_sessions() from public, anon, authenticated;

create trigger customer_email_ends_portal_sessions
  after update of email on public.customers
  for each row
  when (lower(btrim(coalesce(old.email, ''))) is distinct from lower(btrim(coalesce(new.email, ''))))
  execute function public.customer_email_ends_portal_sessions();

-- ── 5. the portal's side (service role only) ────────────────────────────────────────────────────

-- What the sign-in screen needs: is this a link, is it on, whose skin, and the address the code
-- would go to (the app masks it before anything reaches the browser). A replaced or turned-off
-- link answers exactly as customer_portal does: {disabled, org: {name}}, nothing else.
create or replace function public.portal_gate(p_token text)
returns json language plpgsql stable security definer set search_path = public as $$
declare
  a public.customer_portal_access%rowtype;
  v_org uuid;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;
  select * into a from public.customer_portal_access where token = p_token;
  if not found then
    select r.org_id into v_org from public.customer_portal_retired_links r where r.token = p_token;
    if v_org is null then
      return null;
    end if;
    return json_build_object('disabled', true,
      'org', (select json_build_object('name', o.name) from public.organizations o where o.id = v_org));
  end if;
  if not a.enabled then
    return json_build_object('disabled', true,
      'org', (select json_build_object('name', o.name) from public.organizations o where o.id = a.org_id));
  end if;
  return (
    select json_build_object(
      'org', json_build_object(
        'name', o.name, 'logo_url', o.logo_url, 'phone', o.phone, 'email', o.email,
        'license', o.license, 'glass_tint', o.settings->>'glass_tint'),
      'email', nullif(btrim(c.email), ''),
      -- A code already out and still good: the screen opens on the code box, so re-clicking the
      -- link from a text doesn't send a new code that cancels the one just read.
      'live_code_sent_at', (select k.created_at from public.customer_portal_codes k
                             where k.customer_id = a.customer_id and k.org_id = a.org_id
                               and k.consumed_at is null and k.superseded_at is null
                               and k.expires_at > now() and k.attempts < 5))
      from public.customers c
      join public.organizations o on o.id = c.org_id
     where c.id = a.customer_id and c.org_id = a.org_id
  );
end $$;
revoke execute on function public.portal_gate(text) from public, anon, authenticated;
grant execute on function public.portal_gate(text) to service_role;

-- Is this device signed in to THIS link? The session must belong to the link's own customer in the
-- link's own org, the link must be on, and the session unexpired. A customer session slides to 30
-- days from now (at most one write a minute) and stamps Last Opened; an office look does neither.
create or replace function public.portal_session_check(p_token text, p_session_hash text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  a public.customer_portal_access%rowtype;
  s public.customer_portal_sessions%rowtype;
begin
  if p_token is null or length(p_token) < 32 or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select * into a from public.customer_portal_access where token = p_token and enabled;
  if not found then
    return null;
  end if;
  select * into s from public.customer_portal_sessions
   where session_hash = p_session_hash
     and customer_id = a.customer_id
     and org_id = a.org_id
     and expires_at > now();
  if not found then
    return null;
  end if;
  -- An office look lasts only while the person who opened it is still active office staff of this
  -- org (0158). Otherwise it ends here, for good.
  if s.kind = 'office' and not exists (
       select 1 from public.profiles p
        where p.id = s.started_by and p.org_id = s.org_id
          and coalesce(p.active, true) and p.role in ('owner', 'admin', 'office')) then
    delete from public.customer_portal_sessions where id = s.id;
    return null;
  end if;
  if s.kind = 'customer' then
    if s.last_seen_at < now() - interval '1 minute' then
      update public.customer_portal_sessions
         set last_seen_at = now(), expires_at = now() + interval '30 days'
       where id = s.id;
    end if;
    update public.customer_portal_access
       set last_opened_at = now()
     where customer_id = a.customer_id
       and (last_opened_at is null or last_opened_at < now() - interval '1 minute');
  end if;
  return json_build_object('kind', s.kind);
end $$;
revoke execute on function public.portal_session_check(text, text) from public, anon, authenticated;
grant execute on function public.portal_session_check(text, text) to service_role;

-- Send My Code. The address is the customer's email ON FILE, read here; the caller never names one.
-- At most 3 codes per link per 15 minutes; a new code supersedes the live one (one live per link).
-- Returns the address to the server so it can send; the browser only ever sees it masked.
create or replace function public.portal_code_issue(p_token text, p_channel text, p_salt text, p_hash text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  a public.customer_portal_access%rowtype;
  v_to text;
  v_recent int;
  v_oldest timestamptz;
  v_day int;
  v_day_oldest timestamptz;
  v_id uuid;
  v_exp timestamptz;
begin
  if p_salt is null or p_salt !~ '^[0-9a-f]{32}$' or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A code needs a salt and a hash.' using errcode = '22023';
  end if;
  if p_token is null or length(p_token) < 32 then
    return json_build_object('ok', false, 'reason', 'no_link');
  end if;
  -- The lock serializes two sends on the same link, so the window count below can't be raced.
  select * into a from public.customer_portal_access where token = p_token for update;
  if not found or not a.enabled then
    return json_build_object('ok', false, 'reason', 'no_link');
  end if;
  if p_channel is distinct from 'email' then
    -- THE SMS SEAM. When texting is live: read the customer's phone here, as email is read below.
    return json_build_object('ok', false, 'reason', 'channel_unavailable');
  end if;
  select nullif(btrim(c.email), '') into v_to
    from public.customers c where c.id = a.customer_id and c.org_id = a.org_id;
  if v_to is null then
    return json_build_object('ok', false, 'reason', 'no_email');
  end if;

  -- Housekeeping, this customer only: codes from yesterday, sessions that have ended.
  delete from public.customer_portal_codes where customer_id = a.customer_id and created_at < now() - interval '1 day';
  delete from public.customer_portal_sessions where customer_id = a.customer_id and expires_at < now();

  -- The day's ceiling: 10 codes a link in 24 hours (50 guesses at most). The housekeeping above keeps
  -- exactly a day of rows; a code taken back by portal_code_void is gone and never counts.
  select count(*), min(created_at) into v_day, v_day_oldest
    from public.customer_portal_codes
   where customer_id = a.customer_id;
  if v_day >= 10 then
    return json_build_object('ok', false, 'reason', 'day_limit', 'retry_at', v_day_oldest + interval '1 day');
  end if;
  select count(*), min(created_at) into v_recent, v_oldest
    from public.customer_portal_codes
   where customer_id = a.customer_id and created_at > now() - interval '15 minutes';
  if v_recent >= 3 then
    return json_build_object('ok', false, 'reason', 'too_many', 'retry_at', v_oldest + interval '15 minutes');
  end if;

  update public.customer_portal_codes
     set superseded_at = now()
   where customer_id = a.customer_id and consumed_at is null and superseded_at is null;
  insert into public.customer_portal_codes (customer_id, org_id, channel, code_salt, code_hash, expires_at)
  values (a.customer_id, a.org_id, 'email', p_salt, p_hash, now() + interval '10 minutes')
  returning id, expires_at into v_id, v_exp;

  return (
    select json_build_object(
      'ok', true, 'code_id', v_id, 'channel', 'email', 'to', v_to, 'expires_at', v_exp,
      'left_today', 10 - (v_day + 1), 'customer_id', a.customer_id,
      'org', json_build_object('name', o.name, 'phone', o.phone, 'email', o.email, 'glass_tint', o.settings->>'glass_tint'))
      from public.organizations o where o.id = a.org_id
  );
end $$;
revoke execute on function public.portal_code_issue(text, text, text, text) from public, anon, authenticated;
grant execute on function public.portal_code_issue(text, text, text, text) to service_role;

-- The email didn't go out: take the code back. It never reached anyone, so it is deleted (it no
-- longer counts toward the 15-minute window or the day), and if it was the live code, the one it
-- replaced (superseded by this same send, so at its created_at) is live again when still good:
-- the code already in the customer's inbox keeps working. A code anyone has tried is never voided.
create or replace function public.portal_code_void(p_token text, p_code_id uuid)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  a public.customer_portal_access%rowtype;
  v_created timestamptz;
  v_was_live boolean;
begin
  if p_token is null or length(p_token) < 32 or p_code_id is null then
    return false;
  end if;
  select * into a from public.customer_portal_access where token = p_token for update;
  if not found then
    return false;
  end if;
  delete from public.customer_portal_codes
   where id = p_code_id and customer_id = a.customer_id and org_id = a.org_id
     and consumed_at is null and attempts = 0
  returning created_at, superseded_at is null into v_created, v_was_live;
  if v_created is null then
    return false;
  end if;
  if v_was_live and a.enabled then
    -- Only the newest such row: one live code per link (the unique index) holds even if two rows
    -- were ever set aside at the same instant.
    update public.customer_portal_codes
       set superseded_at = null
     where id = (select k.id from public.customer_portal_codes k
                  where k.customer_id = a.customer_id and k.org_id = a.org_id
                    and k.superseded_at = v_created and k.consumed_at is null
                    and k.expires_at > now() and k.attempts < 5
                  order by k.created_at desc, k.id
                  limit 1);
  end if;
  return true;
end $$;
revoke execute on function public.portal_code_void(text, uuid) from public, anon, authenticated;
grant execute on function public.portal_code_void(text, uuid) to service_role;

-- One try. Counted BEFORE the caller compares, under the code's row lock, so five parallel guesses
-- are five tries. Hands the salt and hash to the server to compare in constant time; a code that is
-- missing, expired or out of tries hands over nothing.
create or replace function public.portal_code_try(p_token text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  a public.customer_portal_access%rowtype;
  k public.customer_portal_codes%rowtype;
begin
  if p_token is null or length(p_token) < 32 then
    return json_build_object('state', 'no_link');
  end if;
  select * into a from public.customer_portal_access where token = p_token and enabled;
  if not found then
    return json_build_object('state', 'no_link');
  end if;
  select * into k from public.customer_portal_codes
   where customer_id = a.customer_id and org_id = a.org_id and consumed_at is null and superseded_at is null
   for update;
  if not found then
    return json_build_object('state', 'no_code');
  end if;
  if k.expires_at <= now() then
    return json_build_object('state', 'expired');
  end if;
  if k.attempts >= 5 then
    return json_build_object('state', 'used_up');
  end if;
  update public.customer_portal_codes set attempts = attempts + 1 where id = k.id;
  return json_build_object('state', 'check', 'code_id', k.id, 'salt', k.code_salt, 'hash', k.code_hash,
    'tries_left', 5 - (k.attempts + 1));
end $$;
revoke execute on function public.portal_code_try(text) from public, anon, authenticated;
grant execute on function public.portal_code_try(text) to service_role;

-- The right code: spend it and sign the device in. Checks everything again under the lock
-- (the link, the customer, unspent, unexpired, the hash the server computed from what was typed),
-- so a caller that skipped the comparison still gets nowhere.
create or replace function public.portal_code_redeem(p_token text, p_code_id uuid, p_hash text, p_session_hash text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  a public.customer_portal_access%rowtype;
  k public.customer_portal_codes%rowtype;
begin
  if p_token is null or length(p_token) < 32 or p_code_id is null
     or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
     or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  select * into a from public.customer_portal_access where token = p_token and enabled;
  if not found then
    return false;
  end if;
  select * into k from public.customer_portal_codes
   where id = p_code_id and customer_id = a.customer_id and org_id = a.org_id
     and consumed_at is null and superseded_at is null
     and expires_at > now() and attempts between 1 and 5
     and code_hash = p_hash
   for update;
  if not found then
    return false;
  end if;
  update public.customer_portal_codes set consumed_at = now() where id = k.id;
  insert into public.customer_portal_sessions (customer_id, org_id, session_hash, kind, expires_at)
  values (a.customer_id, a.org_id, p_session_hash, 'customer', now() + interval '30 days');
  update public.customer_portal_access set last_opened_at = now() where customer_id = a.customer_id;
  return true;
end $$;
revoke execute on function public.portal_code_redeem(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.portal_code_redeem(text, uuid, text, text) to service_role;

-- Sign Out on this device.
create or replace function public.portal_session_end(p_token text, p_session_hash text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  delete from public.customer_portal_sessions s
   using public.customer_portal_access a
   where a.token = p_token and s.customer_id = a.customer_id and s.session_hash = p_session_hash;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke execute on function public.portal_session_end(text, text) from public, anon, authenticated;
grant execute on function public.portal_session_end(text, text) to service_role;

-- See What They See, portal side: trade a one-use ticket for an 8-hour office session on THIS link.
create or replace function public.portal_preview_redeem(p_token text, p_ticket_hash text, p_session_hash text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  a public.customer_portal_access%rowtype;
  t public.customer_portal_preview_tickets%rowtype;
begin
  if p_token is null or length(p_token) < 32
     or p_ticket_hash is null or p_ticket_hash !~ '^[0-9a-f]{64}$'
     or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  select * into a from public.customer_portal_access where token = p_token and enabled;
  if not found then
    return false;
  end if;
  select * into t from public.customer_portal_preview_tickets
   where ticket_hash = p_ticket_hash and customer_id = a.customer_id and org_id = a.org_id
     and used_at is null and expires_at > now()
   for update;
  if not found then
    return false;
  end if;
  update public.customer_portal_preview_tickets set used_at = now() where ticket_hash = t.ticket_hash;
  insert into public.customer_portal_sessions (customer_id, org_id, session_hash, kind, started_by, expires_at)
  values (a.customer_id, a.org_id, p_session_hash, 'office', t.created_by, now() + interval '8 hours');
  return true;
end $$;
revoke execute on function public.portal_preview_redeem(text, text, text) from public, anon, authenticated;
grant execute on function public.portal_preview_redeem(text, text, text) to service_role;

-- ── 6. the office's side (active staff of the customer's own org) ───────────────────────────────

-- "Signed in on N devices". Office looks are not devices.
create or replace function public.portal_link_devices(p_customer_id uuid)
returns json language plpgsql stable security definer set search_path = public as $$
declare a public.customer_portal_access%rowtype;
begin
  if auth.uid() is null or not public.is_org_staff() then
    raise exception 'Only the office can see where a customer is signed in.' using errcode = '42501';
  end if;
  select * into a from public.customer_portal_access
   where customer_id = p_customer_id and org_id = public.auth_org_id();
  if not found then
    raise exception 'That customer isn''t in your book.' using errcode = 'P0002';
  end if;
  return (
    select json_build_object('devices', count(*), 'last_seen_at', max(s.last_seen_at))
      from public.customer_portal_sessions s
     where s.customer_id = a.customer_id and s.org_id = a.org_id and s.kind = 'customer' and s.expires_at > now()
  );
end $$;
revoke execute on function public.portal_link_devices(uuid) from public, anon;
grant execute on function public.portal_link_devices(uuid) to authenticated, service_role;

-- Sign Out All Devices. The link keeps working; each device needs a fresh code. Returns how many
-- customer devices were signed out.
create or replace function public.portal_sessions_end_all(p_customer_id uuid)
returns int language plpgsql volatile security definer set search_path = public as $$
declare
  a public.customer_portal_access%rowtype;
  n int;
begin
  if auth.uid() is null or not public.is_org_staff() then
    raise exception 'Only the office can sign a customer out.' using errcode = '42501';
  end if;
  select * into a from public.customer_portal_access
   where customer_id = p_customer_id and org_id = public.auth_org_id()
   for update;
  if not found then
    raise exception 'That customer isn''t in your book.' using errcode = 'P0002';
  end if;
  select count(*) into n from public.customer_portal_sessions
   where customer_id = a.customer_id and kind = 'customer' and expires_at > now();
  delete from public.customer_portal_sessions where customer_id = a.customer_id;
  update public.customer_portal_codes
     set superseded_at = now()
   where customer_id = a.customer_id and consumed_at is null and superseded_at is null;
  return n;
end $$;
revoke execute on function public.portal_sessions_end_all(uuid) from public, anon;
grant execute on function public.portal_sessions_end_all(uuid) to authenticated, service_role;

-- See What They See, office side: a one-use ticket good for 2 minutes. The app draws the ticket and
-- hands over only its sha256. Returns the link's token so the app can build the URL on the org's host.
create or replace function public.portal_preview_ticket(p_customer_id uuid, p_ticket_hash text)
returns text language plpgsql volatile security definer set search_path = public as $$
declare a public.customer_portal_access%rowtype;
begin
  if auth.uid() is null or not public.is_org_staff() then
    raise exception 'Only the office can open a customer''s page.' using errcode = '42501';
  end if;
  if p_ticket_hash is null or p_ticket_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A ticket needs a hash.' using errcode = '22023';
  end if;
  select * into a from public.customer_portal_access
   where customer_id = p_customer_id and org_id = public.auth_org_id();
  if not found then
    raise exception 'That customer isn''t in your book.' using errcode = 'P0002';
  end if;
  delete from public.customer_portal_preview_tickets
   where customer_id = a.customer_id and (used_at is not null or expires_at < now());
  insert into public.customer_portal_preview_tickets (ticket_hash, customer_id, org_id, created_by, expires_at)
  values (p_ticket_hash, a.customer_id, a.org_id, auth.uid(), now() + interval '2 minutes');
  return a.token;
end $$;
revoke execute on function public.portal_preview_ticket(uuid, text) from public, anon;
grant execute on function public.portal_preview_ticket(uuid, text) to authenticated, service_role;

-- ── 7. self-check ───────────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
  f text;
  n int;
begin
  foreach t in array array['customer_portal_codes', 'customer_portal_sessions', 'customer_portal_preview_tickets'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '0331: % has RLS off. Nothing was changed.', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select,insert,update,delete')
       or has_table_privilege('authenticated', 'public.' || t, 'select,insert,update,delete') then
      raise exception '0331: % is reachable without the service role. Nothing was changed.', t;
    end if;
  end loop;

  -- Every new function: SECURITY DEFINER with a pinned search_path, and never anon's to run.
  foreach f in array array[
    'public.portal_gate(text)',
    'public.portal_session_check(text,text)',
    'public.portal_code_issue(text,text,text,text)',
    'public.portal_code_try(text)',
    'public.portal_code_redeem(text,uuid,text,text)',
    'public.portal_code_void(text,uuid)',
    'public.portal_session_end(text,text)',
    'public.portal_preview_redeem(text,text,text)',
    'public.portal_link_devices(uuid)',
    'public.portal_sessions_end_all(uuid)',
    'public.portal_preview_ticket(uuid,text)',
    'public.customer_portal_access_ends_sessions()',
    'public.customer_email_ends_portal_sessions()'] loop
    select count(*) into n from pg_proc
     where oid = f::regprocedure and prosecdef
       and exists (select 1 from unnest(coalesce(proconfig, '{}')) c where c like 'search_path=%');
    if n <> 1 then
      raise exception '0331: % is not SECURITY DEFINER with a pinned search_path. Nothing was changed.', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then
      raise exception '0331: anon can run %. Nothing was changed.', f;
    end if;
  end loop;

  -- The portal's side is the server's alone: a signed-in member can't mint or check codes.
  foreach f in array array[
    'public.portal_gate(text)',
    'public.portal_session_check(text,text)',
    'public.portal_code_issue(text,text,text,text)',
    'public.portal_code_try(text)',
    'public.portal_code_redeem(text,uuid,text,text)',
    'public.portal_code_void(text,uuid)',
    'public.portal_session_end(text,text)',
    'public.portal_preview_redeem(text,text,text)'] loop
    if has_function_privilege('authenticated', f, 'execute') then
      raise exception '0331: a signed-in member can run %. Nothing was changed.', f;
    end if;
  end loop;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.customer_portal_access'::regclass
                    and tgname = 'customer_portal_access_ends_sessions' and not tgisinternal) then
    raise exception '0331: New Link / Turn Off would not end sessions. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.customers'::regclass
                    and tgname = 'customer_email_ends_portal_sessions' and not tgisinternal) then
    raise exception '0331: a changed email would not end sessions. Nothing was changed.';
  end if;
end $$;
