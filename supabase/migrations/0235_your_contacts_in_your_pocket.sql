-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0235: your contacts, in your own pocket
--
-- Erik spent a day chasing Safari's AutoFill toward his Contacts book: the iOS keyboard flow works
-- (buried), the Mac's blue icon opens HIS OWN card only, the typed dropdown served S-names for
-- "Jeff" while Safari choked a full minute on his thousands of contacts. "theres got to be
-- something in there we are missing" — there isn't; the browser chrome is Apple's and it is
-- inconsistent by platform and by mood.
--
-- So North stops depending on it. iCloud speaks CardDAV (an open protocol — same pattern as the
-- Google Calendar integration): connect once with an app-specific password, sync the book into
-- these tables, and render ONE fast picker on every screen. Safari's autofill stays as a bonus
-- door; it stops being the only one.
--
-- PERSONAL, NOT ORG. A person's address book is theirs — the tables key on user_id and RLS binds
-- every row to auth.uid(), so an office seat can never browse the owner's personal contacts.
-- (Tenant isolation law: RLS is the boundary; a filter is a convention.)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.carddav_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  apple_id text not null,
  -- The app-specific password the USER generated and pasted (appleid.apple.com → App-Specific
  -- Passwords — revocable there at any time, never their real password). Stored like the gcal
  -- tokens are: in their own database. The settings card says so out loud.
  app_password text not null,
  addressbook_url text,
  last_synced_at timestamptz,
  contact_count integer default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.phone_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  uid text not null,           -- vCard UID / href, the sync key
  etag text,
  name text,
  company text,
  phone text,
  email text,
  address text,
  city text,
  state text,
  zip text,
  updated_at timestamptz not null default now(),
  unique (user_id, uid)
);
create index if not exists phone_contacts_user_name on public.phone_contacts (user_id, name);

alter table public.carddav_accounts enable row level security;
alter table public.phone_contacts enable row level security;

drop policy if exists carddav_own on public.carddav_accounts;
create policy carddav_own on public.carddav_accounts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists phone_contacts_own on public.phone_contacts;
create policy phone_contacts_own on public.phone_contacts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
