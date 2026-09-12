-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0257: 0246 §2 revoked from `anon`; PUBLIC still held EXECUTE
--
-- Postgres grants EXECUTE on every new function to PUBLIC by default, and `anon` is a member of
-- PUBLIC like every other role. `revoke execute … from anon` removes a grant anon never held
-- directly, so it removes nothing: anon keeps calling through PUBLIC. Verified on production,
-- 2026-09-11, before writing this — pg_proc.proacl on all eleven 0246 §2 functions still reads
--   {=X/postgres, postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}
-- and `=X` is the PUBLIC grant. (The 2026-09-10 DB agent found the same: "the anon-only revoke
-- was a no-op".) 0182 got this right for its five — `from public` — and this brings the 0246 list
-- to the same standard.
--
-- The explicit grants to authenticated / service_role are re-stated so the file is complete on its
-- own: every app caller is one of those two, and neither loses anything here. The public token
-- doors (public_quote / public_invoice / customer_portal / …) and the policy helpers are NOT in
-- this list, for the reasons 0182 spells out — revoking a policy helper from `authenticated`
-- takes the whole app down.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public.reset_import_source(uuid, text)                   from public, anon;
revoke execute on function public.upsert_imported_invoice_items(uuid, text, jsonb)  from public, anon;
revoke execute on function public.replace_imported_invoice_items(uuid, text, jsonb) from public, anon;
revoke execute on function public.save_quote_draft(uuid, jsonb, jsonb)              from public, anon;
revoke execute on function public.publish_site_version(uuid, jsonb)                 from public, anon;
revoke execute on function public.update_site_content(uuid, jsonb)                  from public, anon;
revoke execute on function public.set_doc_counter(text, integer)                    from public, anon;
revoke execute on function public.get_doc_counters()                                from public, anon;
revoke execute on function public.platform_org_label(uuid)                          from public, anon;
revoke execute on function public.learned_prices(text, integer)                     from public, anon;
revoke execute on function public.claim_site_collaborations()                       from public, anon;

grant execute on function public.reset_import_source(uuid, text)                   to authenticated, service_role;
grant execute on function public.upsert_imported_invoice_items(uuid, text, jsonb)  to authenticated, service_role;
grant execute on function public.replace_imported_invoice_items(uuid, text, jsonb) to authenticated, service_role;
grant execute on function public.save_quote_draft(uuid, jsonb, jsonb)              to authenticated, service_role;
grant execute on function public.publish_site_version(uuid, jsonb)                 to authenticated, service_role;
grant execute on function public.update_site_content(uuid, jsonb)                  to authenticated, service_role;
grant execute on function public.set_doc_counter(text, integer)                    to authenticated, service_role;
grant execute on function public.get_doc_counters()                                to authenticated, service_role;
grant execute on function public.platform_org_label(uuid)                          to authenticated, service_role;
grant execute on function public.learned_prices(text, integer)                     to authenticated, service_role;
grant execute on function public.claim_site_collaborations()                       to authenticated, service_role;

-- Proof, for whoever applies this: every row must come back with no `=X` (PUBLIC) entry.
--   select proname, proacl::text from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('reset_import_source','upsert_imported_invoice_items','replace_imported_invoice_items',
--                      'save_quote_draft','publish_site_version','update_site_content','set_doc_counter',
--                      'get_doc_counters','platform_org_label','learned_prices','claim_site_collaborations');
