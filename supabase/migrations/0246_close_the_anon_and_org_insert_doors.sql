-- 0246 — CLOSE THE ANON DOORS AND THE ORG-INSERT DOOR (audit v921; the findings the fix agents
-- flagged as "needs a migration").
--
-- 1) ANY authenticated JWT could INSERT a row into public.organizations.
--    organizations_insert is `with check (auth.uid() is not null)` — no other condition. The
--    intended path is create_organization (0078), a SECURITY DEFINER function that also seeds job
--    codes, the starter safety form and the owner profile. The raw policy let any signed-in user
--    (a tech in someone else's org, or a deactivated seat holding an unexpired token) mint bare
--    org rows straight through PostgREST. Dropping it costs nothing — the definer bypasses RLS.
--
-- 2) `anon` held EXECUTE on a pile of app-internal functions. Supabase grants EXECUTE on every new
--    public function to anon+authenticated by default, so these were published by accident rather
--    than by decision. Most are harmless in practice (they read auth.uid(), null for anon, or are
--    trigger functions that never needed the grant) — but an unauthenticated caller has no business
--    holding the verb. NOT touched: the genuine public token doors (public_quote / public_invoice /
--    public_contract / customer_portal / accept_public_quote / decline_public_quote / sign_contract /
--    get_schedule_proposal / choose_schedule_slot / choose_schedule_date) and signup_allowed — that
--    last one IS called before sign-in by the signup form and its exposure is documented in 0125.
--
-- 3) create_organization and accept_invitation gated on auth.uid() alone, so a DEACTIVATED person
--    holding an unexpired token could create a brand-new org and be an owner again, or accept a
--    pending invitation. 0158 says `active` is a boundary; enforce it in the definer too.
--    The bodies below are the CURRENT shipped bodies verbatim (read from pg_get_functiondef) with
--    ONLY the active check added — the job-code seeding, safety form and no-op-if-already-in-an-org
--    behaviour are preserved exactly.

-- ── 1. the org-insert door ───────────────────────────────────────────────────────────────────
drop policy if exists organizations_insert on public.organizations;

-- ── 2. anon loses the app-internal verbs ─────────────────────────────────────────────────────
revoke execute on function public.reset_import_source(uuid, text)                   from anon;
revoke execute on function public.upsert_imported_invoice_items(uuid, text, jsonb)  from anon;
revoke execute on function public.replace_imported_invoice_items(uuid, text, jsonb) from anon;
revoke execute on function public.save_quote_draft(uuid, jsonb, jsonb)              from anon;
revoke execute on function public.publish_site_version(uuid, jsonb)                 from anon;
revoke execute on function public.update_site_content(uuid, jsonb)                  from anon;
revoke execute on function public.set_doc_counter(text, integer)                    from anon;
revoke execute on function public.get_doc_counters()                                from anon;
revoke execute on function public.platform_org_label(uuid)                          from anon;
revoke execute on function public.learned_prices(text, integer)                     from anon;
revoke execute on function public.claim_site_collaborations()                       from anon;

-- ── 3. a deactivated seat may not create an org or accept an invitation ──────────────────────
CREATE OR REPLACE FUNCTION public.create_organization(p_name text, p_codes jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  existing uuid;
  new_org uuid;
begin
  if uid is null then
    raise exception 'Not authenticated.';
  end if;

  -- 0246: `active` is a boundary, not a badge (0158). Without this a deactivated person holding an
  -- unexpired token could mint a fresh org and be an owner again.
  if exists (select 1 from public.profiles where id = uid and active = false) then
    raise exception 'This account has been deactivated.';
  end if;

  select org_id into existing from public.profiles where id = uid;
  if existing is not null then
    return existing;  -- already in an org; no-op
  end if;

  insert into public.organizations (name) values (coalesce(nullif(trim(p_name), ''), 'My Company'))
  returning id into new_org;

  update public.profiles set org_id = new_org, role = 'owner' where id = uid;
  if not found then
    insert into public.profiles (id, org_id, role, email)
    values (uid, new_org, 'owner', auth.email())
    on conflict (id) do update set org_id = new_org, role = 'owner';
  end if;

  -- Job codes: the picked trade's preset if supplied, otherwise a trade-neutral set.
  if p_codes is not null and jsonb_typeof(p_codes) = 'array' and jsonb_array_length(p_codes) > 0 then
    insert into public.job_codes (org_id, code, description, billable)
    select new_org,
           upper(trim(e->>'code')),
           coalesce(nullif(trim(e->>'description'), ''), upper(trim(e->>'code'))),
           coalesce((e->>'billable')::boolean, true)
    from jsonb_array_elements(p_codes) e
    where coalesce(trim(e->>'code'), '') <> ''
    on conflict do nothing;
  else
    insert into public.job_codes (org_id, code, description, billable) values
      (new_org, 'SVC',    'Service call',     true),
      (new_org, 'INSTALL','Install / build',  true),
      (new_org, 'REPAIR', 'Repair',           true),
      (new_org, 'LABOR',  'General labor',    true),
      (new_org, 'MATL',   'Material run',     true),
      (new_org, 'TRAVEL', 'Travel time',      true),
      (new_org, 'CLEAN',  'Cleanup',          true),
      (new_org, 'SHOP',   'Shop / yard time', false),
      (new_org, 'PTO',    'Paid time off',    false)
    on conflict do nothing;
  end if;

  -- Trade-neutral starter safety form.
  insert into public.forms (org_id, name, description, schema)
  values (
    new_org,
    'Job Site Safety Checklist',
    'Quick pre-work safety walkthrough.',
    '[
      {"key":"ppe","label":"PPE worn (hard hat, glasses, gloves, boots)","type":"checkbox"},
      {"key":"site","label":"Walked the site for hazards","type":"checkbox"},
      {"key":"equipment","label":"Tools & equipment inspected / in good condition","type":"checkbox"},
      {"key":"firstaid","label":"First-aid kit on site","type":"checkbox"},
      {"key":"hazards","label":"Hazards noted","type":"textarea"},
      {"key":"photos","label":"Site photos attached","type":"checkbox"}
    ]'::jsonb
  );

  return new_org;
end $function$;

CREATE OR REPLACE FUNCTION public.accept_invitation()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  em  text := auth.email();
  inv public.invitations;
  cur uuid;
begin
  if uid is null then raise exception 'Not authenticated.'; end if;

  -- 0246: same boundary as create_organization — a deactivated seat accepts nothing.
  if exists (select 1 from public.profiles where id = uid and active = false) then
    raise exception 'This account has been deactivated.';
  end if;

  select org_id into cur from public.profiles where id = uid;
  if cur is not null then return cur; end if;  -- already in an org

  select * into inv from public.invitations
   where lower(email) = lower(coalesce(em, '')) and accepted_at is null
   order by created_at desc limit 1;

  if inv.id is null then
    raise exception 'No pending invitation for your email.';
  end if;

  update public.profiles set org_id = inv.org_id, role = inv.role where id = uid;
  update public.invitations set accepted_at = now() where id = inv.id;
  return inv.org_id;
end $function$;

revoke execute on function public.create_organization(text, jsonb) from anon;
revoke execute on function public.accept_invitation()              from anon;
grant  execute on function public.create_organization(text, jsonb) to authenticated;
grant  execute on function public.accept_invitation()              to authenticated;
