import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DRAW_CREDIT, PREPAID_CREDIT, PREPAYMENT_LINE, isMoneyAheadLine } from "@/lib/prepayments";

/**
 * MONEY AHEAD IS NOT A LEGACY LINE (0415; cn-v1177). The database suite, run against the test database
 * as the first step of the release, found what no reader had: the un-void guard 0260 left reads a line
 * with an import source and no recorded claim as a line from before claims existed, and a "Less
 * deposit" line is exactly that shape. So a voided bill on a job with a payment request could never
 * come back. 0415 re-makes that one guard with one predicate added. What this file proves is the TEXT:
 *   1. the guard's body is 0260's with six lines added and nothing else, byte for byte;
 *   2. the three fingerprints written in the file are the fingerprints of those two bodies;
 *   3. the SQL names the two import sources the app's predicate names, and no third;
 *   4. the app's twin of the rule asks the same predicate.
 * NO DATABASE RUNS HERE: that the database does it is src/lib/payment-request.integration.test.ts.
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

const GUARD = "create or replace function public.guard_invoice_unvoid()";
const guardText = (sql: string) => {
  const at = sql.indexOf(GUARD);
  if (at < 0) throw new Error(`no ${GUARD}`);
  const open = sql.indexOf("as $$", at) + "as $$".length;
  const close = sql.indexOf("$$", open);
  return { head: sql.slice(at, open), body: sql.slice(open, close), after: sql.slice(close, close + 3) };
};
/** The ground check's reading of a body: statements only (the JS twin of
 *  md5(translate(regexp_replace(prosrc, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', ''))). */
const statementsMd5 = (body: string) =>
  createHash("md5").update(body.replace(/-{2}[^\n]*/g, "").replace(/[ \t\n\r]/g, ""), "utf8").digest("hex");

/** Read from production, read-only, the night this was written: the guard there is 0260's, to the statement. */
const WAS_MD5 = "caed11ee9d052b02a27e554fefd49cf8";
const NOW_MD5 = "214d24034d24389b70ce94f6c2def1af";

/** WHAT 0415 ADDS TO 0260's BODY, and nothing else: one predicate with its comment, at the end of the
 *  legacy read's line filter. */
const ADDED = [
  "            -- 0415: MONEY AHEAD IS NOT A LEGACY LINE. A payment request's own line ('prepayment') and the",
  "            -- line that takes a request off a later bill ('prepaid_credit') came from no importer and bill",
  "            -- no hour and no receipt, so there is no claim they failed to record. 0414's own boundary",
  "            -- holds them: every credit line is checked when its bill goes out, or comes back from void as",
  "            -- anything but a draft (guard_prepayment_bill).",
  "            and coalesce(li.import_source, '') not in ('prepayment', 'prepaid_credit')",
  "",
].join("\n");

describe("migration 0415: money ahead is not a legacy line", () => {
  const sql = migration("0415_");
  const code = noComments(sql);
  const now = guardText(sql);
  const was = guardText(migration("0260_"));

  it("is the newest migration, the one 0415, under the house timeouts, with no transaction of its own", () => {
    expect(names.filter((n) => n.startsWith("0415_"))).toEqual(["0415_money_ahead_is_not_a_legacy_line.sql"]);
    expect(names[names.length - 1]).toBe("0415_money_ahead_is_not_a_legacy_line.sql");
    expect(code).toContain("set local lock_timeout = '3s';");
    expect(code).toContain("set local statement_timeout = '15s';");
    expect(code).not.toMatch(/^\s*(begin|commit|rollback|start transaction)\b[^;\n]*;/im);
    expect(code).not.toMatch(/\bsavepoint\b/i);
  });

  it("says how it was found, names its readers and its database suite, and names nobody by name", () => {
    for (const named of [
      "src/lib/payment-request.integration.test.ts",
      "tests/migration-0415.test.ts",
      "src/lib/prepayments.ts",
      "src/app/(app)/billing/actions.ts",
      "AFTER 0414",
      "BEFORE the deploy",
      "TWICE-SAFE",
    ]) {
      expect(sql).toContain(named);
    }
    expect(existsSync(join(process.cwd(), "src/lib/payment-request.integration.test.ts"))).toBe(true);
    expect(sql).not.toMatch(/\bErik\b/);
  });

  it("THE BODY IS 0260's WITH SIX LINES ADDED: cut them out and what is left is 0260's, byte for byte", () => {
    expect(count(now.body, ADDED)).toBe(1);
    expect(now.body.replace(ADDED, "")).toBe(was.body);
    expect(now.head).toBe(was.head);
    expect(now.after).toBe("$$;");
    // The added lines sit inside the legacy read's filter: after the key test, before the filter closes.
    const at = now.body.indexOf(ADDED);
    expect(now.body.slice(0, at).trimEnd().endsWith("[0-9a-f]{4}-[0-9a-f]{12}'")).toBe(true);
    expect(now.body.slice(at + ADDED.length).trimStart().startsWith(") then")).toBe(true);
    // One statement in them, the rest comment.
    expect(noComments(ADDED).trim()).toBe("and coalesce(li.import_source, '') not in ('prepayment', 'prepaid_credit')");
  });

  it("the fingerprints written in the file are the fingerprints of the two bodies", () => {
    expect(statementsMd5(was.body)).toBe(WAS_MD5);
    expect(statementsMd5(now.body)).toBe(NOW_MD5);
    expect(WAS_MD5).not.toBe(NOW_MD5);
    // The ground check takes either (twice-safe) and refuses anything else; the self-check takes only its own.
    expect(count(sql, `if v_md5 not in ('${WAS_MD5}', '${NOW_MD5}') then`)).toBe(1);
    expect(count(sql, `if v_md5 <> '${NOW_MD5}' then`)).toBe(1);
    expect(count(sql, "md5(translate(regexp_replace(v_src, E'-{2}[^\\n]*', '', 'g'), E' \\t\\n\\r', ''))")).toBe(2);
    expect(count(sql, WAS_MD5)).toBe(1);
    expect(count(sql, NOW_MD5)).toBe(2);
  });

  it("refuses without 0414, and re-makes one function and nothing else", () => {
    expect(sql).toContain("Apply 0414 first. Nothing was changed.");
    expect(sql).toContain("t.tgname = 'invoices_prepayment_boundary'");
    expect(count(code, "create or replace function")).toBe(1);
    expect(code).not.toMatch(/\b(create|drop)\s+(trigger|index|table|policy)\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i);
    expect(code).toContain("revoke execute on function public.guard_invoice_unvoid() from public, anon;");
    expect(code).toContain("comment on function public.guard_invoice_unvoid() is");
    // Still what 0260 made it: definer, search path pinned.
    expect(now.head).toContain("security definer");
    expect(now.head).toContain("set search_path = public");
  });

  it("nothing between 0260 and 0415 re-made this guard (the two other un-void guards are other functions)", () => {
    const makers = names.filter((n) => noComments(readFileSync(join(migrations, n), "utf8")).includes(GUARD));
    expect(makers).toEqual(["0259_unvoid_is_a_boundary.sql", "0260_a_claim_is_a_boundary_under_concurrency.sql", "0415_money_ahead_is_not_a_legacy_line.sql"]);
  });

  it("THE SQL AND THE APP NAME THE SAME TWO LINES, and a draw's credit is not one of them", () => {
    expect(noComments(ADDED)).toContain(`not in ('${PREPAYMENT_LINE}', '${PREPAID_CREDIT}')`);
    expect(now.body).not.toContain(DRAW_CREDIT);
    expect(isMoneyAheadLine(PREPAYMENT_LINE)).toBe(true);
    expect(isMoneyAheadLine(PREPAID_CREDIT)).toBe(true);
    for (const other of [DRAW_CREDIT, "labor", "costs", "change_orders", "quote", "", null, undefined]) {
      expect(isMoneyAheadLine(other)).toBe(false);
    }
  });

  it("the app's twin of the legacy read asks that predicate, once, where it decides", () => {
    const actions = readFileSync(join(process.cwd(), "src/app/(app)/billing/actions.ts"), "utf8");
    expect(count(actions, "const legacyLabor = items.some(")).toBe(1);
    expect(actions).toContain(
      "const legacyLabor = items.some((it) => !!it.import_source && !isMoneyAheadLine(it.import_source) && !it.source_ids?.length && !claimedIdsOfLines([it]).length);",
    );
  });
});
