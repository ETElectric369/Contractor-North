-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0219: a signature's IP and user-agent stop being
-- something the signer can choose
--
-- api/contracts/sign says, in its own doc comment, that it "captures the signer's IP and
-- user-agent (which a direct browser RPC call can't)". That was never true. 0068 grants
-- sign_contract to `anon`, and PostgREST exposes every granted function — so anyone holding
-- the contract's token can call it directly and hand it any p_ip and p_ua they like.
--
-- WHY IT MATTERS MORE THAN IT LOOKS. signed_ip and signed_user_agent are not telemetry, they
-- are the evidence that a particular person signed from a particular place — the part of an
-- e-signature that carries weight if the agreement is ever disputed. And 0068's contracts_freeze
-- trigger makes the signature record IMMUTABLE the moment it lands, so a forged value is
-- permanent and uncorrectable. A customer who wanted to repudiate later could sign with a
-- garbage IP and then argue, correctly, that our record proves nothing.
--
-- THE DOOR STAYS OPEN. Revoking anon would be wrong: a homeowner signing a contract is not
-- signed in, and that is the entire point of a token portal (0182 lists this among the public
-- doors on purpose). What changes is not who may sign — it's who may say where from.
--
-- The parameters are now honoured ONLY for a caller presenting the service-role key, i.e. our
-- own /api/contracts/sign route, which reads the IP and user-agent off the request Vercel
-- actually received. Anyone calling the RPC directly still signs — the signature is valid, the
-- name and the timestamp are real — but the evidence fields record NULL, which is the honest
-- answer: we did not observe them. An empty field is worth more than a field somebody chose.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.sign_contract(p_token text, p_name text, p_ip text, p_ua text)
returns json language plpgsql security definer set search_path = public as $$
declare
  c public.contracts;
  v_claims text := current_setting('request.jwt.claims', true);
  v_trusted boolean := false;
  v_ip text;
  v_ua text;
begin
  -- Only our own server (service key) may state where a signature came from. A malformed or
  -- absent claims blob simply isn't trusted — never an error, because failing to parse a header
  -- must not stop a customer signing their contract.
  begin
    v_trusted := coalesce(nullif(v_claims, '')::json ->> 'role', '') = 'service_role';
  exception when others then
    v_trusted := false;
  end;
  v_ip := case when v_trusted then nullif(btrim(coalesce(p_ip, '')), '') end;
  v_ua := case when v_trusted then nullif(btrim(coalesce(p_ua, '')), '') end;

  select * into c from public.contracts where public_token = p_token;
  if c.id is null then return json_build_object('ok', false, 'error', 'Contract not found.'); end if;
  if c.status = 'signed' then return json_build_object('ok', true); end if;
  if c.status <> 'sent' then
    return json_build_object('ok', false, 'error', 'This contract is no longer available to sign.');
  end if;
  if p_name is null or btrim(p_name) = '' then
    return json_build_object('ok', false, 'error', 'Please type your full name to sign.');
  end if;
  update public.contracts
     set status = 'signed', signed_at = now(), signed_name = btrim(p_name),
         signed_ip = v_ip, signed_user_agent = v_ua, signed_body = c.body, updated_at = now()
   where id = c.id;
  return json_build_object('ok', true);
end $$;

-- Unchanged on purpose: the public door is the product. See the note above.
grant execute on function public.sign_contract(text, text, text, text) to anon, authenticated;
