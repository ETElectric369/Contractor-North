-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0323: the portal home knows the running bill, wears the org's
-- glass, and the office can see a shown photo that changed
--
-- THREE THINGS, all on the customer portal and its office controls:
--
--  1. customer_portal (the portal HOME, /portal/<token>) lists each job's RUNNING BILL.
--     Andrew's home listed no Herringbone money at all: his one bill, INV-078, is a long-running
--     draft paid in cash and Venmo as the work goes, and the home lists only sent bills. The job
--     page already shows it as "Running total, not a bill yet" (portal_job_view, 0301); the home
--     now lists it the same way, one row per job: "13897 Herringbone · Running total, not a bill
--     yet · $2,830.89 left", linking to the job page. New key 'running': per job of this customer,
--     in the org, in a status customers are shown (the same fail-closed list as 'jobs'), the sum of
--     that customer's DRAFT bills' total and amount_paid. No pay door, no token: a draft has none,
--     and the row links to the job page (whose gate re-checks everything on every read).
--
--  2. customer_portal's org carries 'glass_tint' (audit v994 DD2). The home read org.glass_tint,
--     but the projection never had it, so the account page was always the default teal (#1b9488)
--     while the job page wore the org's own (ET: #006d8f). portal_job_view projects it the same way.
--
--     BUILT FROM THE LIVE BODY. customer_portal below is pg_get_functiondef(customer_portal) as it
--     stood in production on 2026-09-24 (md5 11c57eff115aa0fc31398b527e446f89, the 0301 body with
--     nothing after it), with only the two additions above. The first statement refuses to run if
--     the live body is anything else, so a change that landed after this file was written can
--     never be undone by it (tonight's 0320 was written from an older body and undid 0313).
--
--  3. job_shared_photo_state(job) (audit v994 PL4): for each photo the office shows a customer,
--     whether the customer's page still shows it. The portal shows a shared photo only while its
--     document still points at the file that was shown and that file's stored version is the one
--     that was shown (0300/0301); a photo overwritten out of the app is quietly hidden, while the
--     office's tile kept saying "Customer Sees It". Office staff of the job's org only (the same
--     rule as job_shared_photos' own policies), definer because the version lives in
--     storage.objects, which no member reads. The office tile then says "Changed Since Shown" and
--     offers Show Again, which is Hide then Show: a deliberate re-share that stamps the new file.
--     Nothing re-shares by itself.
--
-- NOT APPLIED BY ITS AUTHOR. Apply order: after 0322. Practice-run inside BEGIN ... ROLLBACK.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v text;
begin
  select md5(pg_get_functiondef('public.customer_portal(text)'::regprocedure)) into v;
  if v is distinct from '11c57eff115aa0fc31398b527e446f89' then
    raise exception '0323: customer_portal changed since 0323 was written (md5 %). Rebuild 0323 from the live body. Nothing was changed.', v;
  end if;
end $$;

-- ── 1 + 2. the portal home ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.customer_portal(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  a public.customer_portal_access%rowtype;
  v_org uuid;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;

  select * into a from public.customer_portal_access where token = p_token;
  if not found then
    -- A link the office replaced: say it was turned off, never what it used to show.
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
      'customer', json_build_object('name', c.name, 'company_name', c.company_name),
      -- 0323: 'glass_tint', so the home wears the org's own glass, as the job page does (DD2).
      'org', (select json_build_object(
          'name', o.name, 'logo_url', o.logo_url, 'phone', o.phone, 'email', o.email,
          'brand_color', o.brand_color, 'license', o.license,
          'glass_tint', o.settings->>'glass_tint')
        from public.organizations o where o.id = c.org_id),
      'invoices', coalesce((select json_agg(json_build_object(
          'invoice_number', i.invoice_number, 'status', i.status, 'total', i.total,
          'amount_paid', i.amount_paid, 'public_token', i.public_token, 'created_at', i.created_at)
          order by i.created_at desc)
        from public.invoices i where i.customer_id = c.id and i.status in ('sent', 'partial', 'paid', 'overdue')), '[]'::json),
      -- 0323: each job's running bill (its DRAFT bills, which the list above leaves out because a
      -- draft is not a bill). Figures only: no number, no token, no pay door. The row links to the
      -- job page by its id, and portal_job_view re-checks the job is this customer's on every read.
      'running', coalesce((select json_agg(json_build_object(
          'job_id', r.job_id, 'job_name', r.job_name, 'job_number', r.job_number,
          'total', r.total, 'amount_paid', r.amount_paid)
          order by r.job_created desc)
        from (
          select j.id as job_id, j.name as job_name, j.job_number, j.created_at as job_created,
                 sum(i.total) as total, sum(i.amount_paid) as amount_paid
            from public.invoices i
            join public.jobs j on j.id = i.job_id and j.org_id = i.org_id
           where i.customer_id = c.id and i.org_id = c.org_id and i.status = 'draft'
             and j.customer_id = c.id and j.org_id = c.org_id
             and j.status in ('to_be_scheduled', 'scheduled', 'in_progress', 'on_hold', 'complete', 'invoiced')
           group by j.id, j.name, j.job_number, j.created_at
        ) r), '[]'::json),
      'contracts', coalesce((select json_agg(json_build_object(
          'contract_number', ct.contract_number, 'status', ct.status, 'title', ct.title,
          'public_token', ct.public_token, 'signed_at', ct.signed_at) order by ct.created_at desc)
        from public.contracts ct where ct.customer_id = c.id and ct.status in ('sent', 'signed')), '[]'::json),
      'quotes', coalesce((select json_agg(json_build_object(
          'quote_number', q.quote_number, 'status', q.status, 'total', q.total,
          'doc_type', q.doc_type, 'public_token', q.public_token) order by q.created_at desc)
        from public.quotes q where q.customer_id = c.id and q.status in ('sent', 'accepted')), '[]'::json),
      -- Allowlist of customer-facing statuses (fail-closed): never surface internal
      -- pre-sale 'estimate' jobs or a future internal status to the customer.
      -- 0301: 'id', so the list links to /portal/<token>/jobs/<id>. portal_job_view re-checks that
      -- the job is this customer's on every read; the id is an address, never a key.
      'jobs', coalesce((select json_agg(json_build_object(
          'id', j.id, 'name', j.name, 'status', j.status, 'job_number', j.job_number) order by j.created_at desc)
        from public.jobs j where j.customer_id = c.id and j.org_id = c.org_id
          and j.status in ('to_be_scheduled', 'scheduled', 'in_progress', 'on_hold', 'complete', 'invoiced')), '[]'::json)
    )
    from public.customers c
   where c.id = a.customer_id and c.org_id = a.org_id
  );
end $function$;

-- CREATE OR REPLACE keeps the grants (service role only since 0298); say so out loud.
revoke execute on function public.customer_portal(text) from public, anon, authenticated;
grant execute on function public.customer_portal(text) to service_role;

-- ── 3. which shown photos the customer still sees ───────────────────────────────────────────────
create or replace function public.job_shared_photo_state(p_job_id uuid)
returns table (document_id uuid, still_shown boolean)
language sql stable security definer set search_path = public as $$
  -- still_shown is portal_job_view's own photo filter (0301), row for row: the document is still a
  -- Photo on this job in this org, still points at the file that was shown, inside the job's own
  -- folder, and that file's stored version is the one that was shown.
  select s.document_id,
         coalesce(
           d.id is not null
           and d.job_id = s.job_id
           and d.org_id = s.org_id
           and d.category = 'Photo'
           and d.file_url = s.file_url_at_share
           and d.file_url like (s.org_id::text || '/' || s.job_id::text || '/%')
           and public.documents_object_version(d.file_url) is not distinct from s.object_version_at_share,
           false) as still_shown
    from public.job_shared_photos s
    left join public.documents d on d.id = s.document_id
   where s.job_id = p_job_id
     and s.org_id = public.auth_org_id()
     and public.is_org_staff();
$$;
comment on function public.job_shared_photo_state(uuid) is
  'For each photo the office shows a customer on a job: does the customer''s page still show it (0323, audit v994 PL4). Office staff of the caller''s own org only; a photo whose file changed after it was shown reads false.';
revoke execute on function public.job_shared_photo_state(uuid) from public, anon;
grant execute on function public.job_shared_photo_state(uuid) to authenticated, service_role;

-- ── checks ─────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('anon', 'public.customer_portal(text)', 'execute')
     or has_function_privilege('authenticated', 'public.customer_portal(text)', 'execute') then
    raise exception '0323: customer_portal became callable without the service role. Nothing was changed.';
  end if;
  if not has_function_privilege('service_role', 'public.customer_portal(text)', 'execute') then
    raise exception '0323: the portal home lost its door. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public.job_shared_photo_state(uuid)', 'execute') then
    raise exception '0323: job_shared_photo_state is callable by anon. Nothing was changed.';
  end if;
  if position('''glass_tint''' in pg_get_functiondef('public.customer_portal(text)'::regprocedure)) = 0
     or position('''running''' in pg_get_functiondef('public.customer_portal(text)'::regprocedure)) = 0 then
    raise exception '0323: customer_portal did not take its new keys. Nothing was changed.';
  end if;
end $$;
