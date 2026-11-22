import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { liveFunctionBody } from "@/lib/migration-body.test-util";
import { QUOTE_FAMILY_RPC } from "@/lib/sale-quotes";

/**
 * ONE SALE, ONE DEPOSIT (0416; cn-v1178). What this file proves is the TEXT:
 *   1. each of the three re-made functions is its LAST body with only the named changes: take the
 *      changes out of 0416's body and what is left is the last body, byte for byte;
 *   2. the fingerprints written in the file (WAS: read on production 2026-11-22; NOW: this file's)
 *      are the fingerprints of those bodies, and the ground check takes either and nothing else;
 *   3. 0416 is the newest migration and the last that makes each function;
 *   4. the boundary's WHEN and its "acts only when" rule, as text: a payment is never refused there.
 * NO DATABASE RUNS HERE: src/lib/one-sale-one-deposit.integration.test.ts and
 * src/lib/done-not-billed.integration.test.ts ask the database.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const names = readdirSync(migrations).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
const migration = (prefix: string) => {
  const f = names.find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const count = (s: string, needle: string) => s.split(needle).length - 1;

/** A function's head (from `create or replace function` to its opening quote) and its body (prosrc). */
const fnText = (sql: string, header: string, quote: string) => {
  const at = sql.indexOf(header);
  if (at < 0) throw new Error(`no ${header}`);
  const open = sql.indexOf(`as ${quote}`, at) + `as ${quote}`.length;
  const close = sql.indexOf(quote, open);
  return { head: sql.slice(at, open), body: sql.slice(open, close), after: sql.slice(close, close + quote.length + 1) };
};
/** The ground check's reading of a body: statements only (the JS twin of
 *  md5(translate(regexp_replace(prosrc, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', ''))). */
const statementsMd5 = (body: string) =>
  createHash("md5").update(body.replace(/-{2}[^\n]*/g, "").replace(/[ \t\n\r]/g, ""), "utf8").digest("hex");

const PQ = "create or replace function public.public_quote(p_token text)";
const ACC = "create or replace function public.accept_public_quote(p_token text)";
const NY = "create or replace function public.needs_you_done_not_billed(";
const QF = "create or replace function public.quote_family_ids(p_quote uuid)";
const GUARD = "create or replace function public.guard_one_deposit_per_sale()";

/** Production's live fingerprints, read-only, 2026-11-22: each is its last migration's body. */
const WAS = {
  public_quote: "d0874c32f52cdcb1ec997dc8ef7f637a", // 0414
  accept_public_quote: "12278c3bde6fe0e7ab556cfa50a85634", // 0413
  needs_you_done_not_billed: "05abffcd3144db2c61ef84367b5609c2", // 0403
};
/** This file's bodies. */
const NOW = {
  public_quote: "6227a13074f5a8c37ca69bf2f125f0ce",
  accept_public_quote: "1f597e394b2c55165ffbfe6fe1a67f65",
  needs_you_done_not_billed: "347b72f0e3582846f0ff228e4c4ea4ec",
  quote_family_ids: "bbefad8de47aae8c9f11d826631d5a9d",
  guard_one_deposit_per_sale: "15de6d0f81fd1e038fd7b7886e9025c1",
};

// ── WHAT 0416 CHANGES, and nothing else ─────────────────────────────────────────────────────────
/** public_quote: inside the deposit block only. */
const PQ_ADDED_COMMENT = [
  "      -- 0416: ONE SALE, ONE DEPOSIT. Every read of a request in this block looks at the estimate's",
  "      -- whole sale (public.quote_family_ids: the estimate, what it revises up to the first of the",
  "      -- line, and every revision of any of them), so the revision of an estimate whose deposit was",
  "      -- requested or paid says THAT request and never asks again. deposit_due: what is still owed on",
  "      -- the sale's live request that is not paid (its total less what was paid on it, never below 0;",
  "      -- the oldest first), which is what its card door charges before any fee; null when there is",
  "      -- none. card_fee_percent: the company's card fee, by the expression public_invoice reads",
  "      -- (0301's org object), 0 when it charges none.",
  "",
].join("\n");
const PQ_ADDED_KEYS = [
  "      'deposit_due', (select greatest(d.total - coalesce(d.amount_paid, 0), 0) from public.invoices d",
  "                       where d.quote_id in (select public.quote_family_ids(q.id)) and d.org_id = q.org_id",
  "                         and d.invoice_kind = 'prepayment' and d.status <> 'void' and d.status <> 'paid'",
  "                       order by d.created_at, d.id",
  "                       limit 1),",
  "      'card_fee_percent', (select coalesce((o.settings->>'card_fee_percent')::numeric, 0)",
  "                             from public.organizations o where o.id = q.org_id),",
  "",
].join("\n");
const PQ_WAS_READ = "d.quote_id = q.id";
const PQ_NOW_READ = "d.quote_id in (select public.quote_family_ids(q.id))";

/** accept_public_quote: one expression and its comment. */
const ACC_OLD_COMMENT = [
  "    -- 0413: (d) THE JOB SAYS HOW IT BILLS: the company's usual kind, counted in its own company",
  "    -- before this row exists, by public.usual_billing_type (0379; the SQL twin of usualBillingKind in",
  "    -- src/lib/schedule-options.ts): fixed only when its fixed jobs outnumber its time and material",
  "    -- ones, else time and material. 0379's trigger gave a job that named none the same answer; the",
  "    -- door says it out loud now, as every door that makes a job in the app does.",
  "",
].join("\n");
const ACC_NEW_COMMENT = [
  "    -- 0416: THE JOB BILLS BY THE PAPER'S WORD (it was 0413's (d), the company's usual kind). The",
  '    -- customer accepted the paper they read: a Quote ("This is a fixed price") makes a fixed-price',
  "    -- job, an Estimate a time and material one, the SQL twin of billingKindOfDocType",
  "    -- (src/lib/appointments/won-sheet.ts). quotes.doc_type is text, 'estimate' or 'quote' (0047);",
  "    -- jobs.billing_type is text under the check 'fixed' or 'tm' (0063): the case gives text and one",
  "    -- of the two, so no cast is needed. public.usual_billing_type (0379) stays for its trigger.",
  "",
].join("\n");
const ACC_OLD_EXPR = "            public.usual_billing_type(q.org_id),\n";
const ACC_NEW_EXPR = "            case when q.doc_type = 'quote' then 'fixed' else 'tm' end,\n";

/** needs_you_done_not_billed: one comment and one predicate after each of six reads. */
const NY_ADDED_COMMENT = [
  "  -- 0416: A PAYMENT REQUEST IS NOT A BILL FOR THE WORK. A deposit or materials request (invoice_kind",
  "  -- 'prepayment', 0414) bills no hour and no receipt, and carries its estimate's quote_id, so every",
  '  -- read below that asks "is there a bill for this work" leaves it out: the visit\'s anchored bill',
  "  -- (open_inv, and p, the paid one), its job's real billing (b), a real bill naming one of its job's",
  "  -- estimates (n), and the same two for a finished job (b, n).",
  "",
].join("\n");
/** [alias, the predicate the added line follows, how many reads]. */
const NY_READS: [string, string, number][] = [
  ["v", "           and v.status <> 'void'", 1],
  ["p", "                and p.status <> 'void'", 1],
  ["b", "                and b.status not in ('draft', 'void')", 2],
  ["n", "                and n.status not in ('draft', 'void')", 2],
];
const nyAdded = (alias: string, anchor: string) => `\n${anchor.match(/^ */)![0]}and coalesce(${alias}.invoice_kind, 'standard') <> 'prepayment'`;

describe("migration 0416: one sale, one deposit", () => {
  const sql = migration("0416_");
  const code = noComments(sql);
  const pq = { now: fnText(sql, PQ, "$$"), was: fnText(migration("0414_"), PQ, "$$") };
  const acc = { now: fnText(sql, ACC, "$function$"), was: fnText(migration("0413_"), ACC, "$function$") };
  const ny = { now: fnText(sql, NY, "$$"), was: fnText(migration("0403_"), NY, "$$") };
  const qf = fnText(sql, QF, "$$");
  const guard = fnText(sql, GUARD, "$$");

  it("is the one 0416 (what sits past it is the newest migration's own test: migration-0417.test.ts), under the house timeouts, with no transaction of its own", () => {
    expect(names.filter((n) => n.startsWith("0416_"))).toEqual(["0416_one_sale_one_deposit.sql"]);
    // The newest-migration line moved to migration-0417.test.ts the night 0417 was written.
    expect(code).toContain("set local lock_timeout = '3s';");
    expect(code).toContain("set local statement_timeout = '15s';");
    expect(code).not.toMatch(/^\s*(begin|commit|rollback|start transaction)\b[^;\n]*;/im);
    expect(code).not.toMatch(/\bsavepoint\b/i);
    // create or replace trigger (SHARE ROW EXCLUSIVE), never drop trigger (ACCESS EXCLUSIVE); no table changed.
    expect(code).not.toMatch(/\bdrop\s+(trigger|function|index|table)\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    // No row is written by the file itself (the bodies it re-makes write, as they did).
    const outside = [pq.now, acc.now, ny.now, qf, guard].reduce((s, f) => s.replace(f.body, ""), sql);
    expect(noComments(outside)).not.toMatch(/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i);
  });

  it("names its readers and its database suites, and nobody by name", () => {
    for (const named of [
      "src/lib/sale-quotes.ts",
      "src/lib/payment-request.ts",
      "tests/migration-0416.test.ts",
      "src/lib/one-sale-one-deposit.integration.test.ts",
      "src/lib/done-not-billed.integration.test.ts",
      "src/lib/appointments/won-sheet.ts",
      "AFTER 0414",
      "BEFORE the deploy",
      "TWICE-SAFE",
    ]) {
      expect(sql).toContain(named);
    }
    expect(existsSync(join(process.cwd(), "src/lib/one-sale-one-deposit.integration.test.ts"))).toBe(true);
    expect(sql).not.toMatch(/\bErik\b/);
  });

  // ── 1. THE BODIES ────────────────────────────────────────────────────────────────────────────
  it("public_quote IS 0414's BODY with only its deposit block changed: take the changes out and what is left is 0414's, byte for byte", () => {
    const b = pq.now.body;
    expect(count(b, PQ_ADDED_COMMENT)).toBe(1);
    expect(count(b, PQ_ADDED_KEYS)).toBe(1);
    // Every read of a request in the block looks at the sale: the four that were there, and the new key's.
    expect(count(pq.was.body, PQ_WAS_READ)).toBe(4);
    expect(count(b, PQ_WAS_READ)).toBe(0);
    expect(count(b, PQ_NOW_READ)).toBe(5);
    const back = b.replace(PQ_ADDED_KEYS, "").replace(PQ_ADDED_COMMENT, "").split(PQ_NOW_READ).join(PQ_WAS_READ);
    expect(back).toBe(pq.was.body);
    expect(pq.now.head).toBe(pq.was.head);
    expect(pq.now.after).toBe("$$;");
    // The changes are inside the deposit block: after can_take_card, before estimate_format.
    expect(b.indexOf(PQ_ADDED_KEYS)).toBeGreaterThan(b.indexOf("'can_take_card', (select coalesce(o.stripe_charges_enabled, false)"));
    expect(b.indexOf(PQ_ADDED_KEYS)).toBeLessThan(b.indexOf("'estimate_format', fmt.word),"));
    expect(b.indexOf(PQ_ADDED_COMMENT)).toBeLessThan(b.indexOf("'deposit_amount', coalesce("));
    expect(b.lastIndexOf(PQ_NOW_READ)).toBeLessThan(b.indexOf("'estimate_format', fmt.word),"));
  });

  it("public_quote's two new keys: what is left on the sale's live unpaid request, and the card fee by public_invoice's own expression", () => {
    const keys = noComments(PQ_ADDED_KEYS);
    expect(keys).toContain("greatest(d.total - coalesce(d.amount_paid, 0), 0)");
    expect(keys).toContain("d.status <> 'void' and d.status <> 'paid'");
    expect(keys).toContain("order by d.created_at, d.id");
    expect(keys).toContain("limit 1");
    // public_invoice's card fee, 0301's org object, the same expression.
    const fee = "coalesce((o.settings->>'card_fee_percent')::numeric, 0)";
    expect(noComments(migration("0301_"))).toContain(`'card_fee_percent', ${fee},`);
    expect(keys).toContain(fee);
    // deposit_amount and deposit_state keep their arms; the link's status gate is untouched.
    expect(pq.now.body).toContain("'deposit_amount', coalesce((select sum(it.line_total) from public.invoices d");
    expect(count(noComments(pq.now.body), "then 'paid'") + count(noComments(pq.now.body), "then 'requested'") + count(noComments(pq.now.body), "then 'none'")).toBe(5);
    expect(pq.now.body).toContain("and q.status in ('sent', 'accepted', 'declined', 'expired');");
  });

  it("accept_public_quote IS 0413's BODY with one expression and its comment changed: put them back and it is 0413's, byte for byte", () => {
    const b = acc.now.body;
    expect(count(b, ACC_NEW_COMMENT)).toBe(1);
    expect(count(b, ACC_NEW_EXPR)).toBe(1);
    expect(noComments(b)).not.toContain("usual_billing_type");
    expect(b.replace(ACC_NEW_COMMENT, ACC_OLD_COMMENT).replace(ACC_NEW_EXPR, ACC_OLD_EXPR)).toBe(acc.was.body);
    expect(acc.now.head).toBe(acc.was.head);
    expect(acc.now.after).toBe("$function$;");
    // The expression is the job's billing_type: the sixth value of the insert, after its status.
    expect(b).toContain("            'to_be_scheduled',\n" + ACC_NEW_EXPR);
    expect(b).toContain("name, status, billing_type,");
    // The paper's word, as the app's billingKindOfDocType says it: a Quote is fixed, an Estimate T&M.
    const wonSheet = readFileSync(join(process.cwd(), "src/lib/appointments/won-sheet.ts"), "utf8");
    expect(wonSheet).toContain("billingKindOfDocType");
    // usual_billing_type is not dropped: 0379's trigger still reads it.
    expect(code).not.toContain("usual_billing_type(");
  });

  it("needs_you_done_not_billed IS 0403's BODY with a request left out of six reads: take them out and it is 0403's, byte for byte", () => {
    const b = ny.now.body;
    expect(count(b, NY_ADDED_COMMENT)).toBe(1);
    let back = b.replace(NY_ADDED_COMMENT, "");
    let reads = 0;
    for (const [alias, anchor, n] of NY_READS) {
      const added = nyAdded(alias, anchor);
      expect(count(b, anchor + added), alias).toBe(n);
      expect(count(ny.was.body, anchor), alias).toBe(n);
      reads += n;
      back = back.split(added).join("");
    }
    expect(reads).toBe(6);
    expect(back).toBe(ny.was.body);
    expect(ny.now.head).toBe(ny.was.head);
    expect(ny.now.after).toBe("$$;");
    // EVERY read of invoices in the body is one of the six: no read of a bill is left asking without it.
    const invoiceReads = [...noComments(b).matchAll(/from public\.invoices (\w+)/g)].map((m) => m[1]);
    expect(invoiceReads.sort()).toEqual(["b", "b", "n", "n", "p", "v"]);
    for (const a of new Set(invoiceReads)) {
      expect(count(noComments(b), `and coalesce(${a}.invoice_kind, 'standard') <> 'prepayment'`), a).toBe(invoiceReads.filter((x) => x === a).length);
    }
    // Its attributes, as 0403 left them.
    expect(ny.now.head).toContain("security invoker");
    expect(ny.now.head).toContain("set search_path = public");
    expect(ny.now.head).toContain("stable");
    expect(code).toContain("revoke all on function public.needs_you_done_not_billed(timestamptz, timestamptz, integer) from public, anon;");
    expect(code).toContain("grant execute on function public.needs_you_done_not_billed(timestamptz, timestamptz, integer) to authenticated;");
  });

  // ── 2. THE FINGERPRINTS ──────────────────────────────────────────────────────────────────────
  it("the WAS fingerprints are the last bodies' and production's; the NOW ones are this file's; the ground check takes either, the self-check only NOW", () => {
    expect(statementsMd5(pq.was.body)).toBe(WAS.public_quote);
    expect(statementsMd5(acc.was.body)).toBe(WAS.accept_public_quote);
    expect(statementsMd5(ny.was.body)).toBe(WAS.needs_you_done_not_billed);
    expect(statementsMd5(pq.now.body)).toBe(NOW.public_quote);
    expect(statementsMd5(acc.now.body)).toBe(NOW.accept_public_quote);
    expect(statementsMd5(ny.now.body)).toBe(NOW.needs_you_done_not_billed);
    expect(statementsMd5(qf.body)).toBe(NOW.quote_family_ids);
    expect(statementsMd5(guard.body)).toBe(NOW.guard_one_deposit_per_sale);
    for (const k of Object.keys(WAS) as (keyof typeof WAS)[]) {
      expect(WAS[k]).not.toBe(NOW[k]);
      expect(count(sql, WAS[k]), k).toBe(1); // the ground check
      expect(count(sql, NOW[k]), k).toBe(2); // the ground check and the self-check
      expect(sql).toMatch(new RegExp(`'${WAS[k]}', '${NOW[k]}'\\)`));
    }
    // The two this file makes: the ground check takes only this file's own (a second run), and the self-check.
    expect(count(sql, NOW.quote_family_ids)).toBe(2);
    expect(count(sql, NOW.guard_one_deposit_per_sale)).toBe(2);
    expect(count(sql, "if v_md5 not in (r.was, r.now) then")).toBe(1);
    expect(count(sql, "md5(translate(regexp_replace(v_src, E'-{2}[^\\n]*', '', 'g'), E' \\t\\n\\r', ''))")).toBe(4);
  });

  // ── 3. THE MAKERS ────────────────────────────────────────────────────────────────────────────
  it("0416 is the last migration that makes each of the five, and the makers before it are the ones its proofs read", () => {
    const makers = (header: string) => names.filter((n) => noComments(readFileSync(join(migrations, n), "utf8")).toLowerCase().includes(header.toLowerCase()));
    expect(makers("create or replace function public.public_quote(").slice(-3)).toEqual([
      "0408_one_materials_line_under_each_task.sql",
      "0414_money_ahead.sql",
      "0416_one_sale_one_deposit.sql",
    ]);
    expect(makers("create or replace function public.accept_public_quote(").slice(-3)).toEqual([
      "0409_born_from_an_estimate.sql",
      "0413_who_said_yes.sql",
      "0416_one_sale_one_deposit.sql",
    ]);
    expect(makers("create or replace function public.needs_you_done_not_billed(")).toEqual([
      "0371_done_work_is_read_whole.sql",
      "0403_a_bill_that_names_the_estimate_settles_the_work.sql",
      "0416_one_sale_one_deposit.sql",
    ]);
    expect(makers("function public.quote_family_ids(")).toEqual(["0416_one_sale_one_deposit.sql"]);
    expect(makers("function public.guard_one_deposit_per_sale(")).toEqual(["0416_one_sale_one_deposit.sql"]);
    for (const fn of ["public_quote", "accept_public_quote", "needs_you_done_not_billed", "quote_family_ids"]) {
      expect(liveFunctionBody(fn)?.file, fn).toBe("0416_one_sale_one_deposit.sql");
    }
  });

  // ── THE FAMILY ───────────────────────────────────────────────────────────────────────────────
  it("quote_family_ids: invoker, stable sql, search path pinned; up then down, 12 each, one company; itself always; not for anon", () => {
    expect(qf.head).toContain("returns setof uuid");
    expect(qf.head).toContain("language sql");
    expect(qf.head).toContain("stable");
    expect(qf.head).toContain("security invoker");
    expect(qf.head).toContain("set search_path = public");
    const b = noComments(qf.body);
    expect(b).toContain("join public.quotes p on p.id = up.revises_quote_id");
    expect(b).toContain("where up.hops < 12");
    expect(b).toContain("join public.quotes k on k.revises_quote_id = down.id");
    expect(b).toContain("where down.depth < 12");
    expect(count(b, "join me on me.org_id = ")).toBe(2);
    expect(b).toMatch(/select p_quote\s+union\s+select down\.id from down;/);
    expect(code).toContain("revoke all on function public.quote_family_ids(uuid) from public, anon;");
    expect(code).toContain("grant execute on function public.quote_family_ids(uuid) to authenticated, service_role;");
    expect(code).toContain("to_regclass('public.quotes_revises_idx')");
    // The app asks it by this name, with this argument.
    expect(QUOTE_FAMILY_RPC).toBe("quote_family_ids");
    expect(readFileSync(join(process.cwd(), "src/lib/sale-quotes.ts"), "utf8")).toContain("{ p_quote: id }");
  });

  // ── 4. THE BOUNDARY ──────────────────────────────────────────────────────────────────────────
  it("the trigger: BEFORE INSERT OR UPDATE OF quote_id, status, invoice_kind, for a live deposit request naming an estimate", () => {
    expect(code).toContain(
      [
        "create or replace trigger invoices_one_deposit_per_sale",
        "  before insert or update of quote_id, status, invoice_kind on public.invoices",
        "  for each row",
        "  when (new.invoice_kind = 'prepayment' and new.quote_id is not null and new.status <> 'void')",
        "  execute function public.guard_one_deposit_per_sale();",
      ].join("\n"),
    );
    expect(guard.head).toContain("security definer");
    expect(guard.head).toContain("set search_path = public");
    expect(code).toContain("revoke all on function public.guard_one_deposit_per_sale() from public, anon, authenticated;");
  });

  it("IT ACTS ONLY WHEN THE ROW BECOMES A LIVE REQUEST OR CHANGES ESTIMATE: any other update, a payment among them, returns new untouched, before any read or lock", () => {
    const b = noComments(guard.body);
    const pass = [
      "  if tg_op = 'UPDATE'",
      "     and old.status <> 'void'",
      "     and old.quote_id is not distinct from new.quote_id",
      "     and old.invoice_kind is not distinct from new.invoice_kind then",
      "    return new;",
      "  end if;",
    ].join("\n");
    expect(count(b, pass)).toBe(1);
    // The pass comes FIRST: nothing is read and nothing is locked before it.
    expect(b.indexOf(pass)).toBeLessThan(b.indexOf("quote_family_ids"));
    expect(b.indexOf(pass)).toBeLessThan(b.indexOf("for update"));
    expect(b.indexOf(pass)).toBeLessThan(b.indexOf("raise exception"));
    // A payment moves status (sent -> partial -> paid) and amount_paid: none of the three things that act.
    // The status test is old.status <> 'void' alone, never new.status: a status change between live words passes.
    expect(b).not.toMatch(/old\.status\s+is\s+distinct\s+from\s+new\.status/);
    expect(b).not.toContain("amount_paid");
  });

  it("when it acts: the sale's estimates locked in id order, then ANOTHER estimate's live request refused in one sentence; the same estimate is 0414's index's", () => {
    const b = noComments(guard.body);
    expect(b).toContain("from public.quote_family_ids(new.quote_id) as f(id)");
    expect(b).toContain("array_agg(f.id order by f.id)");
    expect(b).toContain("perform 1 from public.quotes q where q.id = any (v_family) order by q.id for update;");
    expect(b.indexOf("for update")).toBeLessThan(b.indexOf("from public.invoices d"));
    for (const p of [
      "d.org_id = new.org_id",
      "d.invoice_kind = 'prepayment'",
      "d.status <> 'void'",
      "d.id is distinct from new.id",
      "d.quote_id = any (v_family)",
      "d.quote_id <> new.quote_id",
    ]) {
      expect(b, p).toContain(p);
    }
    expect(b).toContain("raise exception 'This sale already has a deposit request: %. Use that one. Nothing was made.', v_other");
    // 0414's unique index is kept: this file drops nothing.
    expect(migration("0414_")).toContain("create unique index invoices_one_live_deposit_request_per_estimate");
    expect(code).toContain("to_regclass('public.invoices_one_live_deposit_request_per_estimate') is null");
    // The app reads the refusal by these words as the lost race (src/lib/payment-request.ts), and the
    // database's raised message reaches the screen as written (src/lib/db-error.ts).
    expect(b).toContain("already has a deposit request");
    expect(b).toContain("using errcode = 'P0001'");
  });

  it("the self-check reads every fingerprint, the attributes, the grants, the trigger, and that anon cannot ask the family", () => {
    const self = code.slice(code.lastIndexOf("do $$"));
    for (const fp of Object.values(NOW)) expect(self, fp).toContain(fp);
    expect(self).toContain("has_function_privilege('anon', 'public.quote_family_ids(uuid)', 'execute')");
    expect(self).toContain("t.tgname = 'invoices_one_deposit_per_sale'");
    expect(self).toContain("array['invoice_kind', 'quote_id', 'status']");
    expect(self).toContain("current_setting('cn.m0416_was', true)");
    expect(self).toContain("public.public_quote('0416 self-check: no estimate has this token') is not null");
    expect(self).toContain("public.accept_public_quote('0416 self-check: no estimate has this token')");
  });
});
