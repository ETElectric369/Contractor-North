import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TRADE_ORDER } from "@/lib/trade-codes";
import { BLANK_PRESET, featurePreset } from "@/lib/features";

/**
 * 0355 (existing companies keep what they use) writes each company's switches from the SAME trade
 * presets sign-up uses. Two copies of one table drift, so this reads the migration's copy and holds
 * it to lib/features: the blank preset key for key, and one row per trade that merges to exactly
 * featurePreset(trade). The DB suite then runs 0355 itself on a throwaway company.
 */
const dir = join(process.cwd(), "supabase/migrations");
const sql = readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith("0355_"))!), "utf8");

describe("0355's presets are lib/features' presets", () => {
  it("the blank preset, key for key", () => {
    const blank = sql.match(/blank_preset\s*\(features\)\s*as\s*\(\s*select\s*'(\{[^']+\})'::jsonb/);
    expect(blank, "0355 names its blank preset").not.toBeNull();
    expect(JSON.parse(blank![1])).toEqual(BLANK_PRESET);
  });

  it("one row per trade, each merging to featurePreset(trade)", () => {
    const rows = [...sql.matchAll(/\(\s*'([a-z]+)'\s*,\s*'(\{[^']*\})'::jsonb\s*\)/g)];
    const seen = Object.fromEntries(rows.map((m) => [m[1], JSON.parse(m[2])]));
    expect(Object.keys(seen).sort()).toEqual([...TRADE_ORDER].sort());
    for (const t of TRADE_ORDER) expect({ ...BLANK_PRESET, ...seen[t] }, t).toEqual(featurePreset(t));
  });

  it("names no company: no org id, no company name, in the logic", () => {
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(sql).not.toMatch(/ET Electric|TAHOE|Tahoe Deck|Vivian|CED/);
  });

  it("the trade words map onto the real trade keys only", () => {
    const mapped = [...sql.matchAll(/then '([a-z]*)'/g)].map((m) => m[1]).filter(Boolean);
    for (const t of mapped) expect(TRADE_ORDER as readonly string[], t).toContain(t);
  });

  it("its known-trade self-check and sign-up's whitelist (0352 create_organization) are TRADE_ORDER", () => {
    const check = sql.match(/!~ '\^\(\|([a-z|]+)\)\$'/);
    expect(check, "0355 names its known trades").not.toBeNull();
    expect(check![1].split("|").sort()).toEqual([...TRADE_ORDER].sort());
    // Sign-up is the only writer of settings.trade: a trade outside this list would fail 0355's check.
    const signup = readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith("0352_"))!), "utf8");
    const list = signup.match(/v_trade text := case when p_trade = any \(array\[([^\]]+)\]\)/);
    expect(list, "0352 whitelists the trade").not.toBeNull();
    expect([...list![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...TRADE_ORDER].sort());
  });
});
