-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0014: quote acceptance → job (turnkey hand-off)
-- Lets a customer accept a quote from the public link, which marks it accepted
-- and auto-creates the job. Run AFTER 0012 (public_token).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.quotes add column if not exists accepted_at timestamptz;

-- Public accept: mark accepted + create the job if none is linked yet.
create or replace function public.accept_public_quote(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare
  q public.quotes;
  new_job uuid;
begin
  select * into q from public.quotes where public_token = p_token;
  if q.id is null then
    return json_build_object('ok', false, 'error', 'Quote not found.');
  end if;

  if q.status <> 'accepted' then
    update public.quotes set status = 'accepted', accepted_at = now() where id = q.id;
  end if;

  if q.job_id is null then
    insert into public.jobs (org_id, customer_id, name, status, created_by)
    values (q.org_id, q.customer_id,
            coalesce(nullif(q.title, ''), 'Job from ' || q.quote_number),
            'scheduled', q.created_by)
    returning id into new_job;
    update public.quotes set job_id = new_job where id = q.id;
  end if;

  return json_build_object('ok', true);
end $$;

grant execute on function public.accept_public_quote(text) to anon, authenticated;
