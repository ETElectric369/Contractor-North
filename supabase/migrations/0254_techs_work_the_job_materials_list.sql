-- 0254 — TECHS WORK THE JOB'S MATERIALS LIST (Erik 2026-09-11 06:10: "i want techs to have all of
-- the job information available that is pertinent to them and they should have an easy access to
-- the same materials list per job (just one, the same one) and honestly we probably wont ever be
-- putting prices in those lines anyway").
--
-- THE BRIAN STORY (2026-09-11). Brian is a tech. He walked a job, worked out what it needed, and
-- typed his materials note into the job's DESCRIPTION box — the one field on the page that looked
-- like it would take it. That box is staff-only twice over (updateJobDescription is requireStaff,
-- and jobs_write is is_org_staff()), so the save answered "This action is staff-only." and the
-- note went nowhere. The door he needed was one tab over: the job's materials list, which he could
-- READ (0056 kept customers / jobs / materials / work_orders readable by the crew on purpose) but
-- not WRITE, because 0004 gave every business table a single FOR ALL policy keyed on
-- is_org_staff(). A tech could look at the list he was about to shop from and not tick a line.
--
-- WHAT CHANGES. Any active member of the org may add, edit, remove and tick lines on a list that
-- belongs to a JOB in their org, and may mint that list when the job has none yet — the
-- ensureJobMaterialList path — and only then: a job carries ONE list, and the crew never starts
-- a second one beside it. Staff keep everything they had. The line is job_id, not where the
-- list came from: an accepted quote's take-off lands on the job WITH its job_id
-- (createMaterialListFromQuote), so it IS the job's one list and the crew works it — Erik's "the
-- same one" — with its prices hidden by the editor and pinned by the trigger below. A list with
-- NO job stays staff-only: a take-off built from a quote that has no job yet is the pricing
-- sheet behind a number the customer may still sign, and a work order's sheet with no job behind
-- it is the office's dispatch list — the crew has nothing to shop from there, and a crew edit
-- would move a figure the customer is about to sign.
--
-- WHY A TRIGGER, NOT JUST A HIDDEN COLUMN. Money stays out of a tech's hands and eyes:
--   est_cost — what the office expects a line to cost (purchasing/actions.ts seeds a PO's
--              unit_cost from it; job profit reads the PO);
--   vendor   — who we buy it from (the PO seed reads it too);
--   is_tool  — a tool rides the truck, a material is bought; it decides which lines reach a
--              purchase order at all.
-- The shared editor hides the two money columns and the tool TOGGLE from a tech (a tech still
-- reads is_tool — the "Tools — grab from the shop" grouping is a field convenience), but a
-- hidden input is a convention: the anon
-- key ships in the client bundle, and a PATCH carrying the tech's own session token walks past
-- every UI decision (0143 / 0154 learned this on time_entries). A policy can say a tech may write
-- the ROW; only a trigger can say which COLUMNS. So on INSERT by a non-staff caller the three are
-- pinned to null / null / false, and on UPDATE they are pinned to what the row already held.
-- Pinned, not refused: the crew's add must never bounce because the shared form carried a default
-- it wasn't allowed to send (NO DEAD ENDS). Everything else on the row — description, part number,
-- quantity, unit, purchased, purchased_at, sort order — is theirs.
--
-- est_cost ON A TECH-WRITTEN LINE IS NULL BY DESIGN. That is not a missing value for the office to
-- chase: Erik's words are that these lines will probably never carry prices, and a PO built from
-- such a list seeds unit_cost as unknown, exactly as it already does for any unpriced line.
--
-- "Active member" needs no new helper: auth_org_id() is NULL for a deactivated seat (0158), so
-- `org_id = auth_org_id()` already fails closed for anyone the office has cut.

-- ── 1. items: one write rule, now with a crew door on JOB lists ──────────────────────────────
-- 0004's material_list_items_write was `org AND is_org_staff()`, FOR ALL. It is REPLACED (same
-- name, so there is still exactly one write rule on this table to read) with: same org, and
-- either staff, or the line's list belongs to a job in that org. The list's own org_id is
-- checked explicitly rather than trusting material_lists_read to filter the subquery — a rule at
-- one read path is a convention, not a boundary (0173).
drop policy if exists material_list_items_write on public.material_list_items;
create policy material_list_items_write on public.material_list_items
  for all
  using (
    org_id = public.auth_org_id()
    and (
      public.is_org_staff()
      or exists (
        select 1 from public.material_lists l
         where l.id = material_list_items.list_id
           and l.org_id = public.auth_org_id()
           and l.job_id is not null
      )
    )
  )
  with check (
    org_id = public.auth_org_id()
    and (
      public.is_org_staff()
      or exists (
        select 1 from public.material_lists l
         where l.id = material_list_items.list_id
           and l.org_id = public.auth_org_id()
           and l.job_id is not null
      )
    )
  );

comment on policy material_list_items_write on public.material_list_items is
  'Same org, then: staff write anything; the crew writes lines on any list that belongs to a '
  'JOB — hand-made or the accepted quote''s take-off alike (job_id set). A list with no job '
  'stays staff-only. Which COLUMNS a tech may write is decided by the '
  'pin_material_money_columns trigger, not here (0254).';

-- ── 2. lists: the crew may START a job's list — never a second one, never rename / relink / delete ──
-- ensureJobMaterialList inserts {name, job_id, created_by} and lets stamp_org_material_lists fill
-- org_id; that BEFORE trigger runs ahead of this check, so org_id is already the caller's own by
-- the time with_check reads it. The job must be in the caller's org (a foreign job id must never
-- persist as a cross-org FK), quote_id / work_order_id must be empty (a crew-minted list is the
-- job's shopping list, not a quote's take-off wearing a job number), the author is the caller —
-- and THE JOB MUST HAVE NO LIST YET. That last clause is "just one, the same one" made literal.
-- Nothing in the schema stops a job carrying two lists (a take-off landing after a hand-made
-- list is the documented case), and everyone reads the NEWEST one: ensureJobMaterialList and
-- the job tab's canonicalList both order by created_at desc. So a second list, minted by anyone,
-- displaces the first for the whole org. createMaterialList is a server action any signed-in
-- member can POST with a job_id, whatever the office's New List button hides from a tech — and
-- without this clause that POST would drop a fresh empty list on top of the office's priced
-- take-off and flip every phone and desk to it. Staff keep the freedom (material_lists_write,
-- 0004, is untouched); the crew gets to start the list, only ever when there is none.
--
-- The existence check goes through job_has_material_list(), a SECURITY DEFINER helper, not a
-- bare `not exists (select … from material_lists)`. The bare form works today (proved live,
-- 2026-09-11) — but only because material_lists_read is a plain function call: a subquery on the
-- policy's own table is filtered by the caller's SELECT policies, a boundary hanging off a read
-- path (the shape 0173 calls a convention), and Postgres reports "infinite recursion detected in
-- policy" the day any of those SELECT policies grows a subquery of its own, which would refuse
-- every crew insert at once. The helper reads as the table owner, so "does this job have a
-- list" is answered from the whole table, not from what the caller happens to be allowed to
-- see — the same shape as auth_org_id() / is_org_staff() reading profiles (0158).
--
-- UPDATE and DELETE are not granted here at all — material_lists_write (0004, staff, FOR ALL) is
-- untouched and remains the only door for rename / relink / delete.
create or replace function public.job_has_material_list(p_job_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.material_lists where job_id = p_job_id);
$$;

comment on function public.job_has_material_list(uuid) is
  'Does this job already carry a materials list? Read as the owner (the whole table, not the '
  'caller''s view of it) so material_lists_crew_insert can hold the crew to "just one, the same '
  'one" without a policy reading its own table (0254).';

-- An unauthenticated request has no list to start. Two grants have to go, not one: Postgres
-- itself hands EXECUTE to PUBLIC on every new function, and Supabase's default privileges add
-- anon / authenticated / service_role on top. A revoke from anon alone strips anon's own grant
-- and leaves PUBLIC's standing, so anon can still call it — 0246's revokes are in exactly that
-- state live (has_function_privilege('anon', …) still true). 0224 / 0242 / 0244 got it right:
-- revoke from PUBLIC and anon together; authenticated keeps its explicit grant, and that is the
-- role the policy calls this under.
revoke execute on function public.job_has_material_list(uuid) from public, anon;

drop policy if exists material_lists_crew_insert on public.material_lists;
create policy material_lists_crew_insert on public.material_lists
  for insert
  with check (
    org_id = public.auth_org_id()
    and job_id is not null
    and quote_id is null
    and work_order_id is null
    and coalesce(created_by, auth.uid()) = auth.uid()
    and exists (
      select 1 from public.jobs j
       where j.id = material_lists.job_id
         and j.org_id = public.auth_org_id()
    )
    -- Just one, the same one: the crew starts the list only when the job has none.
    and not public.job_has_material_list(material_lists.job_id)
  );

comment on policy material_lists_crew_insert on public.material_lists is
  'Any active org member may START a JOB''s materials list (ensureJobMaterialList) — only while '
  'the job has none, so a crew insert can never displace the office''s take-off (newest wins). '
  'Rename, relink and delete stay behind material_lists_write (staff) (0254).';

-- ── 3. the column boundary ───────────────────────────────────────────────────────────────────
-- Keyed on the REQUEST, never on current_user: this is SECURITY DEFINER like every guard in the
-- schema, so current_user inside it is the owner for every caller (0154's note). Staff write
-- prices; so does trusted server code and a direct database connection — the service role, a
-- migration, an ops repair (is_privileged_writer, 0154). Everyone else is the crew.
create or replace function public.pin_material_money_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_org_staff() or public.is_privileged_writer() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- A tech's new line carries no price, no vendor, and is a material, whatever the request said.
    new.est_cost := null;
    new.vendor   := null;
    new.is_tool  := false;
  else
    -- A tech's edit leaves the office's price, vendor and tool flag exactly where they were.
    new.est_cost := old.est_cost;
    new.vendor   := old.vendor;
    new.is_tool  := old.is_tool;
  end if;
  return new;
end $$;

comment on function public.pin_material_money_columns() is
  'Non-staff writes to material_list_items never carry money: est_cost / vendor / is_tool are '
  'pinned (null / null / false on insert, the old values on update). Staff and privileged '
  'writers pass through untouched (0254).';

-- A trigger function has no business being callable by an unauthenticated request. PUBLIC and
-- anon both (see job_has_material_list above for why anon alone is a no-op); firing the trigger
-- never checks EXECUTE, so the crew's inserts still run through it.
revoke execute on function public.pin_material_money_columns() from public, anon;

drop trigger if exists pin_material_money_columns on public.material_list_items;
create trigger pin_material_money_columns
  before insert or update on public.material_list_items
  for each row execute function public.pin_material_money_columns();
