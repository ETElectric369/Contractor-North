-- 0209 — SITE VERSIONS HARDENING (the cn-v766 review's confirmed findings).
--
-- 1. DRAFTS ARE STAFF READING. 0208's select policy admitted any active org member — a tech's
--    JWT against PostgREST could read unpublished redesigns. Parity with the write policy and
--    with the studio surface (requireStaff). Draft preview reads use the service client and the
--    external-collaborator gate lives in code, so nothing else changes.
drop policy if exists site_versions_select on site_versions;
create policy site_versions_select on site_versions
  for select using (org_id = public.auth_org_id() and public.is_org_staff());

-- 2. THE DOC HAS A CEILING AT THE DB BOUNDARY (house law: a cap only in the app is a
--    convention). 2MB — far above any real site document, parity with 0118's per-key ethos.
alter table site_versions
  add constraint site_versions_doc_bytecap check (length(doc::text) <= 2097152);

-- 3. PUBLISH IS ONE TRANSACTION. The action's three PostgREST writes could interleave: two
--    concurrent publishes, or a failure between the settings write and the bookkeeping, left
--    organizations.settings and site_versions disagreeing — and the studio's drift banner then
--    blamed the mismatch on "edits made outside the studio". One RPC, security INVOKER (RLS
--    still decides who may update organizations and site_versions), zero-row RAISEs so an
--    RLS-silenced write is an error, never a half-publish.
--
--    p_doc arrives from the ACTION, which builds it with extractSiteDoc — shape-bounded to the
--    site-document keys, so the merge can never smuggle protected keys (custom_domain,
--    public_handle, lead_inbound_secret) however the stored row was written. The single-
--    statement `settings || p_doc` merge also closes the action's old read-modify-write window.
create or replace function public.publish_site_version(
  p_version_id uuid,
  p_doc jsonb
)
returns void
language plpgsql
security invoker
as $$
declare
  v_org uuid;
  v_rows integer;
begin
  select org_id into v_org from site_versions where id = p_version_id;
  if v_org is null then
    raise exception 'Version not found.';
  end if;
  if length(p_doc::text) > 2097152 then
    raise exception 'This version is too large to publish.';
  end if;

  update organizations
     set settings = coalesce(settings, '{}'::jsonb) || p_doc,
         updated_at = now()
   where id = v_org;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'The publish didn''t land — you may not have permission to change the site.';
  end if;

  update site_versions
     set status = 'archived'
   where org_id = v_org and status = 'published' and id <> p_version_id;

  update site_versions
     set status = 'published', published_at = now()
   where id = p_version_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'The version bookkeeping didn''t land.';
  end if;
end;
$$;

comment on function public.publish_site_version(uuid, jsonb) is
  'Atomic site publish (0209): merge the shape-bounded doc onto org settings, archive the old published version, mark the new one — one transaction, RLS-enforced (security invoker), zero-row writes RAISE.';
