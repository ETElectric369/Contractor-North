-- 0194 — A PUBLIC HANDLE AND A CUSTOM DOMAIN BELONG TO EXACTLY ONE TENANT.
--
-- Audit 6. Both are enforced unique in TypeScript only — setPublicHandle and setCustomDomain check
-- for a clash before writing. But `organizations_update` (0181) lets an owner PATCH their own
-- settings jsonb directly, and the anon key ships in the browser bundle:
--
--   PATCH /rest/v1/organizations?id=eq.<their own org>
--   { "settings": { …, "custom_domain": "etelectricity.com", "public_handle": "et-electric" } }
--
-- The policy passes — it IS their own row and they ARE the owner. Nothing else looks. From then on
-- two orgs claim one host, and which one serves it depends on whatever orgOwnsHost resolves first.
--
-- This is law 1 verbatim: a rule applied at one write path is a convention, not a boundary. The
-- app-side check stays (it produces the friendly message); this is what makes it true.
--
-- ── THE THREE DETAILS THAT MAKE THE INDEX CORRECT ───────────────────────────────────────────
--
-- 1. THE PARTIAL PREDICATE IS MANDATORY. Both setters store "" to CLEAR the value — Vivian
--    Builders' custom_domain is "" in production right now. A plain unique index would make every
--    org with an empty domain collide with every other one, and the second tenant to clear theirs
--    would be unable to save anything at all.
--
-- 2. lower() IS ALSO MANDATORY. A direct PATCH does not lowercase, while orgOwnsHost normalizes
--    before comparing. Without it "ETElectricity.com" slips past the constraint and still matches
--    at serve time — the constraint would look enforced and not be.
--
-- 3. GUARDED, so a deploy cannot fail opaquely. CREATE UNIQUE INDEX errors outright if a duplicate
--    already exists; checked here first and raised with a message that names the offenders.
--    (Checked against production before writing this: zero duplicates on all three keys.)
--
-- lead_inbound_secret gets the same treatment — same class of key, and two orgs sharing an inbound
-- secret means one of them receives the other's leads.

do $$
declare
  k text;
  dupes text;
begin
  foreach k in array array['public_handle', 'custom_domain', 'lead_inbound_secret'] loop
    execute format(
      $q$ select string_agg(v || ' (' || who || ')', '; ')
          from (
            select lower(settings->>%L) v, string_agg(name, ' + ') who
            from public.organizations
            where nullif(settings->>%L, '') is not null
            group by 1 having count(*) > 1
          ) d $q$, k, k)
      into dupes;
    if dupes is not null then
      raise exception 'Cannot make % unique — these are already claimed twice: %. Resolve them first.', k, dupes;
    end if;
  end loop;
end $$;

create unique index if not exists organizations_public_handle_uniq
  on public.organizations ((lower(settings->>'public_handle')))
  where nullif(settings->>'public_handle', '') is not null;

create unique index if not exists organizations_custom_domain_uniq
  on public.organizations ((lower(settings->>'custom_domain')))
  where nullif(settings->>'custom_domain', '') is not null;

create unique index if not exists organizations_lead_secret_uniq
  on public.organizations ((settings->>'lead_inbound_secret'))
  where nullif(settings->>'lead_inbound_secret', '') is not null;
