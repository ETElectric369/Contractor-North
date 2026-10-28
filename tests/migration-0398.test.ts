import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TRADE_ORDER } from "@/lib/trade-package";

/**
 * THE OWNER CAN CHANGE THE COMPANY'S TRADE (0398, cn-v1135), read from the migration file the way
 * migration-0397.test reads 0397: one writer in set_org_feature's shape (0352 §4), the owner only,
 * the ten trades of TRADE_ORDER in 0352's own order, the ONE key it writes, the pin's door opened
 * and closed, the audit row, the grants and the self-check. Applied migrations are immutable
 * (check-test-db hashes 0001–0397); the DB proof is src/lib/org-trade.integration.test.ts.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => {
  const f = readdirSync(migrations).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};

/** 0398's refusals: plain words, one action each. */
const WORDS = {
  signIn: "Sign in to your company first.",
  owner: "Only the owner can change the company''s trade.",
  unknown: 'There is no trade called "%".',
  notSaved: "That didn''t save. Reload and try again.",
} as const;

/** The trade list inside `p_trade = any (array[…])`, in the order written. */
const tradeList = (sql: string): string[] | null => {
  const m = sql.match(/p_trade = any \(array\[([^\]]+)\]\)/);
  return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null;
};

describe("migration 0398 lets the owner change the company's trade", () => {
  const sql = migration("0398_");
  const start = sql.indexOf("create or replace function public.set_org_trade(p_trade text)");
  const end = sql.indexOf("revoke execute on function public.set_org_trade(text)");
  const fn = sql.slice(start, end);

  it("one function, set_org_trade(p_trade text), security definer with its search_path pinned", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(fn).toMatch(/returns jsonb\s+language plpgsql\s+security definer\s+set search_path = public/);
    expect(fn.length).toBeGreaterThan(400);
  });

  it("the owner of an active seat, their own company (never a parameter), refused in words otherwise", () => {
    expect(fn).toContain("v_org uuid := public.auth_org_id();");
    expect(fn).toContain(`raise exception '${WORDS.signIn}';`);
    expect(fn).toContain("if public.app_user_role() is distinct from 'owner' then");
    expect(fn).toContain(`raise exception '${WORDS.owner}';`);
    expect(fn).not.toMatch(/p_org/);
  });

  it("its trade list is TRADE_ORDER, in 0352 create_organization's own order", () => {
    const mine = tradeList(fn);
    expect(mine).not.toBeNull();
    expect(mine).toEqual([...TRADE_ORDER]);
    const signup = tradeList(migration("0352_"));
    expect(signup).not.toBeNull();
    expect(mine).toEqual(signup);
    expect(fn).toContain(`raise exception '${WORDS.unknown}', p_trade;`);
    // Blank or whitespace is "Other / Not Listed": trimmed, then the key is removed.
    expect(fn).toContain("p_trade := coalesce(trim(p_trade), '');");
    expect(fn).toContain("when p_trade = '' then coalesce(o.settings, '{}'::jsonb) - 'trade'");
  });

  it("writes ONE key on the locked row: trade — never features or timeclock_job_codes", () => {
    expect(fn).toContain("where o.id = v_org for update;");
    expect(fn).toContain("jsonb_set(coalesce(o.settings, '{}'::jsonb), '{trade}', to_jsonb(p_trade), true)");
    expect(fn).not.toMatch(/features|timeclock_job_codes|trade_label/);
    expect((fn.match(/update public\.organizations/g) ?? []).length).toBe(1);
    // The stored value is read back and compared: a quiet miss is a failure (the silent-write law).
    expect(fn).toContain("returning o.settings ->> 'trade' into v_now;");
    expect(fn).toContain("if v_now is distinct from nullif(p_trade, '') then");
    expect(fn).toContain(`raise exception '${WORDS.notSaved}';`);
  });

  it("opens 0352's pin for this company and this transaction only, and closes it again", () => {
    const open = fn.indexOf("perform set_config('cn.feature_writer', v_org::text, true);");
    const write = fn.indexOf("update public.organizations");
    const close = fn.indexOf("perform set_config('cn.feature_writer', '', true);");
    expect(open).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(write);
  });

  it("leaves the undo trail: one agent_audit_log row, action trade.set, from and to", () => {
    expect(fn).toContain("insert into public.agent_audit_log (org_id, user_id, action, risk, effect, ok, input_summary, source)");
    expect(fn).toContain("'trade.set', 1, 'write', true,");
    expect(fn).toContain("jsonb_build_object('from', v_prev, 'to', nullif(p_trade, ''))");
    expect(fn).toContain("return jsonb_build_object('previous', v_prev, 'trade', nullif(p_trade, ''));");
  });

  it("the refusals are plain words naming one action, not developer text", () => {
    for (const words of Object.values(WORDS)) {
      expect(words).not.toMatch(/_|0\d{3}|settings\.|jsonb/);
      expect(words).toMatch(/[.]$/);
    }
  });

  it("anon cannot call it; a signed-in person and the server can; it checks itself", () => {
    expect(sql).toContain("revoke execute on function public.set_org_trade(text) from public, anon;");
    expect(sql).toContain("grant execute on function public.set_org_trade(text) to authenticated, service_role;");
    expect(sql).toMatch(/comment on function public\.set_org_trade\(text\) is\s+'/);
    expect(sql).toContain("if to_regprocedure('public.set_org_trade(text)') is null then");
    expect(sql).toContain("and p.prosecdef");
    expect(sql).toContain("and p.proconfig @> array['search_path=public']");
    expect(sql).toContain("if has_function_privilege('anon', 'public.set_org_trade(text)', 'execute') then");
    expect(sql).toContain("if not has_function_privilege('authenticated', 'public.set_org_trade(text)', 'execute') then");
    expect(sql).toMatch(/tgname = 'pin_org_features' and tgrelid = 'public\.organizations'::regclass/);
    expect(sql).toContain("raise notice '0398: the owner can change the company''s trade.';");
    expect(sql).toContain("set local lock_timeout = '3s';");
    // Every self-check refusal ends the same way (a '' inside is SQL's own quote, not the end).
    const checks = [...sql.matchAll(/raise exception '0398:(?:[^']|'')*'/g)].map((m) => m[0]);
    expect(checks.length).toBeGreaterThanOrEqual(7);
    for (const line of checks) expect(line).toMatch(/Nothing was changed\.'$/);
  });

  it("leaves 0352's switch board alone (never drops or redefines its functions or trigger)", () => {
    expect(sql).not.toMatch(/drop trigger (if exists )?pin_org_features/i);
    expect(sql).not.toMatch(/create or replace function public\.(pin_org_features|set_org_feature|feature_keys|org_feature_on|create_organization|pin_owner_settings)\b/i);
    expect(sql).not.toMatch(/\balter table\b|\bdrop function\b/i);
  });
});
