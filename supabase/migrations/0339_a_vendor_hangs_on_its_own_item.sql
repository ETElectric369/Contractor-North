-- 0339: A VENDOR ROW HANGS ONLY ON ITS OWN COMPANY'S ITEM (audit v994 TL1).
--
-- Starts from the LIVE policy (pg_policies, 2026-09-25), which is 0282's as written:
--   price_list_item_options_write  FOR ALL
--     USING      (org_id = auth_org_id() AND is_org_staff())
--     WITH CHECK (org_id = auth_org_id() AND is_org_staff())
--
-- Nothing in it asked whose ITEM the row names. set_org_id fills org_id from the writer, and the FK
-- (item_id -> price_list_items) is checked as the table owner, not under RLS, so a staff member of
-- company A could POST a vendor row naming company B's item. It would sit in A's org, invisible to
-- B, and still count in 0282's two unique indexes, which are keyed on item_id alone:
--   price_list_item_options_one_per_maker (item_id, lower(vendor), lower(coalesce(label,'')))
--   price_list_item_options_one_default   (item_id) WHERE is_default AND NOT archived
-- so B could no longer add "Andersen" to its own 830 Windows, or make any vendor its default, and
-- could neither see nor remove what was in the way. The app's ownItem() check is one door; the
-- boundary belongs in the policy (the 0173 law: a rule at one read path is a convention).
--
-- THE FIX: the write policy's WITH CHECK also requires that the item is this row's org's item. With
-- that, every row under an item_id belongs to the item's own org, so the org-blind unique indexes
-- can only ever be crowded by the item's own company, which is exactly what they are for.
--   * USING is unchanged: which rows a person may update or delete is still "ours, and staff".
--   * The subquery reads price_list_items under the writer's own RLS (staff, own org), and also
--     names the org explicitly, so it holds even for a caller whose RLS is bypassed on one side.
--   * job_picks' own check on option_id (0300) is untouched.
--
-- Live when written: 0 option rows in any org, 0 mismatched, so there is nothing to backfill and no
-- existing row can fail the new check on its next update.
--
-- Safe to re-run (drop policy if exists / create policy).

drop policy if exists price_list_item_options_write on public.price_list_item_options;
create policy price_list_item_options_write on public.price_list_item_options
  for all
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (
    org_id = public.auth_org_id()
    and public.is_org_staff()
    and exists (
      select 1
        from public.price_list_items i
       where i.id = price_list_item_options.item_id
         and i.org_id = price_list_item_options.org_id
    )
  );

comment on policy price_list_item_options_write on public.price_list_item_options is
  'Staff write their own org''s vendor rows, and a vendor row may only name an item of that same org (0339, audit v994 TL1): the one-per-maker and one-default indexes are keyed on item_id, so a row under another company''s item would block theirs.';
