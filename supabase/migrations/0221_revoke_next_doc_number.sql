-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0221: next_doc_number stops being world-callable
--
-- 0182 swept five internal SECURITY DEFINER functions and filed the rest as "needs its own
-- review, narrower than a revoke". This is one of those, reviewed.
--
-- next_doc_number(p_org uuid, p_type text, p_prefix text) is SECURITY DEFINER and executable by
-- `anon` — i.e. by anyone holding the anon key that ships in the browser bundle. It takes the
-- ORG AS AN ARGUMENT and increments that org's counter, so it walks past tenant isolation by
-- design: it was never meant to be reachable from outside.
--
-- What an outsider can do with it is not dramatic but it is not nothing: burn document numbers
-- in any org by uuid. INV-1041 is followed by INV-2000 and the office cannot explain the gap.
-- On documents a contractor hands to customers, to a lender, or to an auditor, unexplained gaps
-- in an invoice sequence are exactly the thing that has to be explainable.
--
-- ── WHY REVOKING IS SAFE, AND HOW THAT WAS ESTABLISHED ─────────────────────────────────────
--
-- 0182's own warning applies here and was taken seriously: revoking EXECUTE from a function that
-- runs inside something else can take the app down. This one is called from exactly six places,
-- all of them the number_* BEFORE INSERT triggers in 0004 (jobs, quotes, work orders, change
-- orders, purchase orders, invoices), and every one of those six trigger functions is itself
-- declared SECURITY DEFINER. Inside them the effective user is the owner, so the inner call is
-- checked against the owner's privileges and not the inserting role's — revoking from
-- authenticated cannot break an insert.
--
-- That is the argument. It was not trusted on its own: the accompanying apply script performs a
-- REAL INSERT as the `authenticated` role, with this revoke in force, inside a transaction, and
-- refuses to commit unless the row still came back correctly numbered. Enumeration by reading is
-- not enumeration.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public.next_doc_number(uuid, text, text) from public, anon, authenticated;

-- Explicit, so the intent survives the next person reading pg_proc.
grant execute on function public.next_doc_number(uuid, text, text) to service_role;
