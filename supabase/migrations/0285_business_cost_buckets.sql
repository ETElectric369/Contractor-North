-- THE SIX BUSINESS-COST BUCKETS, FOR THE ROWS ALREADY STORED (2026-09-24).
--
-- A bill with no job is a business cost. Erik approved one list for them: Gas & Truck, Tools &
-- Supplies, Phone & Office, Insurance & Licenses, Fees, Other. The app now files every new one in
-- that list (src/lib/business-cost-buckets.ts). This moves the old ones onto it, so a report never
-- shows "Fuel" in one row and "Gas & Truck" in the next for the same gas.
--
--   Fuel, Vehicle           -> Gas & Truck
--   Shop supplies, Tools    -> Tools & Supplies
--   Office                  -> Phone & Office
--   Insurance               -> Insurance & Licenses
--   a bucket name           -> itself (any letter case)
--   blank, or anything else -> Other
--
-- The same table is bucketOf() in the app; business-cost-buckets.test.ts reads the WHEN lines
-- below and checks each one against it, so the two cannot drift apart.
--
-- ONLY COSTS WITH NO JOB. A job bill's category says what kind of paper it is (Receipt, Invoice,
-- Materials) and is not a bucket, so every bills row with a job_id is left exactly as it is.
-- Recurring expense templates are included because each one writes a no-job bill on a schedule.
--
-- NOTHING IS LOST FROM A BILL. A bill whose old category does not map to a named bucket lands in
-- Other, and its note says what it was filed as, so the old word is still on the row for anyone
-- who wants to re-bucket it. (Recurring templates keep no such note; an unknown word there becomes
-- Other outright. There were 0 recurring templates in any company when this was written.)
--
-- IDEMPOTENT. Only rows whose category actually changes are written, and a bucket name maps to
-- itself, so a second run touches nothing and appends no second note.
do $$
declare
  v_bills integer;
  v_templates integer;
begin
  with mapped as (
    select b.id,
           b.category as old_category,
           case lower(btrim(coalesce(b.category, '')))
             when 'fuel' then 'Gas & Truck'
             when 'vehicle' then 'Gas & Truck'
             when 'gas' then 'Gas & Truck'
             when 'truck' then 'Gas & Truck'
             when 'gas & truck' then 'Gas & Truck'
             when 'shop supplies' then 'Tools & Supplies'
             when 'tools' then 'Tools & Supplies'
             when 'supplies' then 'Tools & Supplies'
             when 'tools & supplies' then 'Tools & Supplies'
             when 'office' then 'Phone & Office'
             when 'phone' then 'Phone & Office'
             when 'phone & office' then 'Phone & Office'
             when 'insurance' then 'Insurance & Licenses'
             when 'license' then 'Insurance & Licenses'
             when 'licenses' then 'Insurance & Licenses'
             when 'insurance & licenses' then 'Insurance & Licenses'
             when 'fees' then 'Fees'
             else 'Other'
           end as bucket
      from public.bills b
     where b.job_id is null
  )
  update public.bills b
     set category = m.bucket,
         notes = case
                   when m.bucket = 'Other'
                    and btrim(coalesce(m.old_category, '')) <> ''
                    and lower(btrim(m.old_category)) <> 'other'
                   then concat_ws(E'\n', nullif(btrim(coalesce(b.notes, '')), ''),
                                  format('Filed as "%s" before the six business cost buckets.', btrim(m.old_category)))
                   else b.notes
                 end
    from mapped m
   where b.id = m.id
     and b.category is distinct from m.bucket;
  get diagnostics v_bills = row_count;

  with mapped as (
    select t.id,
           case lower(btrim(coalesce(t.category, '')))
             when 'fuel' then 'Gas & Truck'
             when 'vehicle' then 'Gas & Truck'
             when 'gas' then 'Gas & Truck'
             when 'truck' then 'Gas & Truck'
             when 'gas & truck' then 'Gas & Truck'
             when 'shop supplies' then 'Tools & Supplies'
             when 'tools' then 'Tools & Supplies'
             when 'supplies' then 'Tools & Supplies'
             when 'tools & supplies' then 'Tools & Supplies'
             when 'office' then 'Phone & Office'
             when 'phone' then 'Phone & Office'
             when 'phone & office' then 'Phone & Office'
             when 'insurance' then 'Insurance & Licenses'
             when 'license' then 'Insurance & Licenses'
             when 'licenses' then 'Insurance & Licenses'
             when 'insurance & licenses' then 'Insurance & Licenses'
             when 'fees' then 'Fees'
             else 'Other'
           end as bucket
      from public.recurring_templates t
     where t.kind = 'expense'
  )
  update public.recurring_templates t
     set category = m.bucket
    from mapped m
   where t.id = m.id
     and t.category is distinct from m.bucket;
  get diagnostics v_templates = row_count;

  raise notice '0285: % business-cost bills and % recurring expense templates moved onto the six buckets.',
    v_bills, v_templates;
end $$;
