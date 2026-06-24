-- New orgs were seeded with ELECTRICAL job codes + an electrical safety form (LOTO /
-- "de-energized") — wrong for a deck builder or any other trade. Make org creation
-- TRADE-AWARE: create_organization now takes an optional p_codes array; onboarding
-- passes the picked trade's preset (deck, plumbing, …). With no codes it falls back to
-- a trade-neutral default. Only the seeds change; org/owner logic is identical to 0004.
-- Existing orgs are untouched.
drop function if exists public.create_organization(text);

create function public.create_organization(p_name text, p_codes jsonb default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  existing uuid;
  new_org uuid;
begin
  if uid is null then
    raise exception 'Not authenticated.';
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
end $$;
