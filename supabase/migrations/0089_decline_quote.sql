-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0089: let a customer DECLINE a quote online
-- Mirrors accept_public_quote (0066): only a SENT quote can be declined, it's
-- idempotent if already declined, and it's exposed to anon via the public token.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.quotes add column if not exists declined_at timestamptz;

create or replace function public.decline_public_quote(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  select * into q from public.quotes where public_token = p_token;
  if q.id is null then
    return json_build_object('ok', false, 'error', 'Quote not found.');
  end if;

  -- Already declined → idempotent success.
  if q.status = 'declined' then
    return json_build_object('ok', true);
  end if;

  -- Only a SENT quote is a live offer that can be declined.
  if q.status <> 'sent' then
    return json_build_object('ok', false, 'error', 'This quote is no longer available.');
  end if;

  update public.quotes set status = 'declined', declined_at = now() where id = q.id;
  return json_build_object('ok', true);
end $$;

grant execute on function public.decline_public_quote(text) to anon, authenticated;
