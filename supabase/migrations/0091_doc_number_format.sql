-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0091: shorter doc numbers + type-aware quote prefix
-- Owner asks (screenshot annotations on Q-00005):
--   1) numbers are too long — pad to 3 digits (002), grow a digit only when needed
--      (003 … 099 … 100 … 1000). Applies to every doc type via next_doc_number.
--   2) the quote/estimate PREFIX should match the type: Estimate (T&M) → E-, Quote
--      (fixed) → Q-. The doc_type column already drives the toggle; now it drives the
--      number's letter too. Counter stays SHARED (per-org 'quote' counter), so toggling
--      the type keeps the same number and only flips the letter: E-002 ↔ Q-002.
-- Existing rows keep their stored numbers; this only governs new numbers + toggles.
-- Run AFTER 0088. Counters stay PER-ORG (multi-tenancy invariant from 0037).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Pad to 3 (was 5). Everything else (per-org counter + org-settings prefix override
--    from 0088) is unchanged.
create or replace function public.next_doc_number(p_org uuid, p_type text, p_prefix text)
returns text language plpgsql security definer set search_path = public as $$
declare n int; v_prefix text;
begin
  insert into public.doc_counters (org_id, doc_type, current)
  values (p_org, p_type, 1)
  on conflict (org_id, doc_type)
  do update set current = public.doc_counters.current + 1
  returning current into n;
  select nullif(o.settings -> 'doc_prefixes' ->> p_type, '')
    into v_prefix
    from public.organizations o
    where o.id = p_org;
  return coalesce(v_prefix, p_prefix) || lpad(n::text, 3, '0');
end $$;

-- 2) New quotes: prefix by type (E- for estimate / T&M, Q- for quote / fixed). The counter
--    key stays 'quote' so estimates and quotes share one running number. coalesce because a
--    column default of 'estimate' is applied before this BEFORE-INSERT trigger reads it.
create or replace function public.number_quotes() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then new.org_id := public.auth_org_id(); end if;
  if new.quote_number is null or new.quote_number = '' then
    new.quote_number := public.next_doc_number(
      new.org_id, 'quote',
      case when coalesce(new.doc_type, 'estimate') = 'quote' then 'Q-' else 'E-' end
    );
  end if;
  return new;
end $$;

-- 3) Toggling the type flips ONLY the E-/Q- letter, keeping the number. Guarded so it never
--    touches a custom/org-override prefix (only the two built-in letters) and only when the
--    type actually changes. The shared counter means the flipped number can't collide (this
--    org used that number exactly once).
create or replace function public.sync_quote_prefix() returns trigger language plpgsql set search_path = public as $$
begin
  if new.doc_type is distinct from old.doc_type and new.quote_number is not null then
    if new.doc_type = 'quote' and new.quote_number like 'E-%' then
      new.quote_number := 'Q-' || substring(new.quote_number from 3);
    elsif new.doc_type = 'estimate' and new.quote_number like 'Q-%' then
      new.quote_number := 'E-' || substring(new.quote_number from 3);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_sync_quote_prefix on public.quotes;
create trigger trg_sync_quote_prefix before update on public.quotes
  for each row execute function public.sync_quote_prefix();
