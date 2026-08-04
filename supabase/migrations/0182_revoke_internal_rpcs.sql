-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0182: the five internal RPCs stop being callable by anybody
--
-- `grep -rniE "^\s*revoke" supabase/migrations/` returns ZERO hits across 181 files. Postgres
-- grants EXECUTE TO PUBLIC on a new function by default, so `grant execute … to service_role` —
-- which several migrations do — adds nothing and hides the fact that everyone already had it.
-- Verified against production: ALL FIFTY security-definer functions in `public` are executable by
-- `anon`, i.e. by anyone holding the anon key that ships in the browser bundle.
--
-- These five are SECURITY DEFINER, so they walk past the deny-all policies on their own tables,
-- and every caller in the app is on a SERVICE client (ai-cost.ts:91,135 · rate-limit.ts:27 ·
-- observe.ts:42 · cron-guard.ts:25 → api/automations/daily). Nothing signed-in, let alone signed-
-- out, has any business calling them:
--
--   rate_limit_hit     the counter increments regardless of p_limit, and several keys are FIXED
--                      LITERALS shared by every tenant ("chat-day:all"). Enough anonymous calls
--                      turn public Ask Nort off for EVERY org at once, because that limiter is
--                      failClosed.
--   record_ai_usage    writes the COGS ledger. One call with a large p_cost_usd puts a tenant past
--                      MONTHLY_AI_CEILING_USD and Nort goes dark for them for thirty days.
--   ai_spend_since     reads any org's 30-day AI spend back to the caller, by uuid.
--   record_app_error   `on conflict do update`, so a forged p_key OVERWRITES a real production
--                      issue in the error log — the one Erik triages every session.
--   rate_limit_gc      housekeeping; no reason for it to be reachable either.
--
-- ── WHY THIS IS FIVE AND NOT FIFTY ─────────────────────────────────────────────────────────
--
-- Most of the other forty-five MUST stay anon-callable or must not be touched:
--
--   THE PUBLIC DOORS, by design — public_quote, public_invoice, public_contract, customer_portal,
--   accept/decline_public_quote, sign_contract, get_schedule_proposal, choose_schedule_date/slot,
--   submit_inquiry, public_org, signup_allowed, voice_invite_is_open. A customer opening a quote
--   link is not signed in; that is the whole point of a token portal.
--
--   THE POLICY HELPERS — auth_org_id(), app_user_role(), is_member(), is_org_staff(), is_staff(),
--   is_platform_admin(), is_site_collaborator(). ⚠️ These are evaluated INSIDE the RLS policy
--   expressions themselves, with the querying role's privileges. Revoking EXECUTE from
--   `authenticated` would make every policy on every table fail — it would take the entire app
--   down for every signed-in user. DO NOT.
--
--   THE TRIGGER FUNCTIONS — number_*, set_org_id, handle_new_user, guard_*,
--   prevent_role_escalation, rls_auto_enable, enforce_signup_allowlist. They run as part of a
--   trigger, never over RPC; the EXECUTE grant is not what admits them.
--
-- The rest (create_organization, accept_invitation, get_doc_counters, update_site_content …) are
-- called by signed-in users through the app and need their own review — narrower than a revoke,
-- because each needs its caller checked first. Filed, not swept.
--
-- THE STANDING LESSON: a `grant execute … to service_role` is not a restriction. Any new
-- SECURITY DEFINER function that is not a public door needs an explicit REVOKE in the same
-- migration that creates it, or it is world-callable the moment it lands.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.rate_limit_gc() from public, anon, authenticated;
revoke execute on function public.record_ai_usage(uuid, text, text, bigint, bigint, bigint, bigint, numeric) from public, anon, authenticated;
revoke execute on function public.ai_spend_since(uuid, integer) from public, anon, authenticated;
revoke execute on function public.record_app_error(text, text, text, text, jsonb) from public, anon, authenticated;

-- Explicit, so the only route in is the service key the app already uses for all five.
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
grant execute on function public.rate_limit_gc() to service_role;
grant execute on function public.record_ai_usage(uuid, text, text, bigint, bigint, bigint, bigint, numeric) to service_role;
grant execute on function public.ai_spend_since(uuid, integer) to service_role;
grant execute on function public.record_app_error(text, text, text, text, jsonb) to service_role;
