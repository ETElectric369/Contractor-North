-- Audit 2026-06-21: accept_public_quote accepted a quote in ANY status (draft,
-- expired, declined, void) via its public token and auto-created a job. A customer
-- should only be able to accept a quote that was actually SENT to them. Tighten the
-- state machine: idempotent if already accepted; reject anything not 'sent'.

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

  -- Already accepted → idempotent success (re-tapping the button is harmless).
  if q.status = 'accepted' then
    return json_build_object('ok', true);
  end if;

  -- Only a SENT quote can be accepted. draft/declined/expired/void are not offers.
  if q.status <> 'sent' then
    return json_build_object('ok', false, 'error', 'This quote is no longer available to accept.');
  end if;

  update public.quotes set status = 'accepted', accepted_at = now() where id = q.id;

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
