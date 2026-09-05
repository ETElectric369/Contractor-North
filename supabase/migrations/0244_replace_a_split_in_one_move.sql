-- 0244 — REPLACE A SPLIT IN ONE MOVE (audit v921, two highs).
--
-- The app had no transaction, so replacing an entry's allocation set was done as INSERT-the-new
-- THEN DELETE-the-old — deliberately, so a failed insert could never wipe a recorded split. But
-- guard_time_allocation (0154) validates ROW BY ROW and sums every other row already on the
-- entry, so during that overlap the sum is old + new. For a tech (staff skip the guard) the
-- second row always trips it:
--
--   clock in on job A -> switch to B after 3h (switchJob records A 3h) -> Clock Out at 7h30.
--   The panel sends [A 3h, B 4h]. Row 1: 3 old + 3 = 6 <= 7 ok. Row 2: 3 + 3 + 4 = 10 > 7 -> RAISE.
--
-- The tech saw "Could not clock out" on a shift that WAS already closed (the entry update runs
-- first), the 4 hours on job B never landed, and labor-billing treats "has any rows" as fully
-- allocated — so those hours vanished from job cost and from the invoice. The same shape defeated
-- scaleRecordedToWorked, whose per-row UPDATEs were refused by the guard and whose errors were
-- discarded, leaving the entry billing hours nobody was paid for (the exact C7 case its comments
-- say it prevents).
--
-- One statement, one transaction: delete the old set, insert the new one, and check the total
-- ONCE against the shift's worked hours. Because the delete lands first, the row guard then sees
-- only the new set and agrees by construction. A failed insert rolls the delete back, which is
-- the safety the insert-first order was buying.

create or replace function public.replace_time_allocations(p_entry uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  ent          record;
  worked_hours numeric;
  new_total    numeric;
  n            integer;
begin
  select te.id, te.profile_id, te.org_id, te.clock_in, te.clock_out, te.lunch_minutes,
         te.paid_at, te.mileage_paid_at
    into ent
    from public.time_entries te
   where te.id = p_entry;
  if not found then
    raise exception 'That shift no longer exists.';
  end if;

  -- WHO MAY RESHAPE THIS SPLIT: the person whose shift it is, or staff in the same org. Both
  -- helpers already refuse a deactivated seat (0158), so an ex-employee's token gets nothing.
  if not (ent.profile_id = auth.uid()
          or (public.is_org_staff() and ent.org_id = public.auth_org_id())) then
    raise exception 'That is not your shift.';
  end if;

  -- A settled shift's split is history — same rule guard_time_allocation enforces.
  if ent.paid_at is not null or ent.mileage_paid_at is not null then
    raise exception 'That shift is in a paid period — ask the office to undo it on Payroll first.';
  end if;

  select coalesce(sum((r->>'hours')::numeric), 0) into new_total
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  if new_total < 0 then
    raise exception 'Allocated hours cannot be negative.';
  end if;

  -- THE no-over-bill law (C7), checked once for the whole set instead of row by row.
  if ent.clock_out is not null then
    worked_hours := extract(epoch from (ent.clock_out - ent.clock_in)) / 3600.0
                    - coalesce(ent.lunch_minutes, 0) / 60.0;
    if new_total > worked_hours + 0.01 then
      raise exception 'That split adds up to more hours than the shift worked.';
    end if;
  end if;

  delete from public.time_allocations where time_entry_id = p_entry;

  insert into public.time_allocations (time_entry_id, org_id, job_id, job_code, hours, description, sort_order)
  select p_entry,
         ent.org_id,
         nullif(r->>'job_id', '')::uuid,
         nullif(r->>'job_code', ''),
         coalesce((r->>'hours')::numeric, 0),
         nullif(r->>'description', ''),
         coalesce((r->>'sort_order')::integer, (row_number() over ())::integer - 1)
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(r, ord);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.replace_time_allocations(uuid, jsonb) from public, anon;
grant execute on function public.replace_time_allocations(uuid, jsonb) to authenticated;
comment on function public.replace_time_allocations(uuid, jsonb) is
  'Atomically replace one time entry''s allocation set (delete + insert in one transaction), checking the C7 worked-hours ceiling once for the whole set. Caller must own the shift or be active org staff. See 0244.';
