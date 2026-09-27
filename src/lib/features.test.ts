import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TRADE_ORDER, TRADE_PRESETS } from "@/lib/trade-codes";
import {
  ALL_ON,
  BLANK_PRESET,
  FEATURES,
  FEATURE_BY_KEY,
  FEATURE_KEYS,
  TRADE_FEATURES,
  featureChildren,
  featureOn,
  featurePreset,
  featuresFromOffKey,
  isFeatureKey,
  normalizeFeatures,
  normalizeTradeKey,
  offFeatureKey,
  type FeatureMap,
} from "@/lib/features";

/**
 * THE SWITCH BOARD (0352), pinned from the TypeScript side: the whitelist, the board's rows, the trade
 * presets, and the read rule (missing = ON, job_codes falls back to the old checkbox). The DB side of
 * the same whitelist is pinned twice: by parsing the migrations here, and by feature-switches'
 * integration suite against the test database.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => {
  const f = readdirSync(migrations).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};

describe("the whitelist and the board", () => {
  it("every key has exactly one row, in the same order, with a Title Case label and one plain line", () => {
    expect(FEATURES.map((f) => f.key)).toEqual([...FEATURE_KEYS]);
    for (const f of FEATURES) {
      // Title Case: every word starts upper-case, except the joining "&".
      for (const w of f.label.split(" ")) if (w !== "&") expect(w[0], `${f.label}`).toMatch(/[A-Z]/);
      expect(f.line.length, f.key).toBeGreaterThan(10);
      expect(f.line.length, f.key).toBeLessThanOrEqual(110);
      expect(f.line).not.toMatch(/\bsettings\.|_|0\d{3}/); // no developer text
    }
  });

  it("a sub-switch's parent is a top-level switch", () => {
    for (const f of FEATURES) {
      if (!f.parent) continue;
      expect(FEATURE_BY_KEY[f.parent].parent, f.key).toBeUndefined();
    }
    expect(featureChildren("crew_payroll").map((f) => f.key)).toEqual(["daily_reports", "crew_board"]);
    expect(featureChildren("website").map((f) => f.key)).toEqual(["site_chat"]);
  });

  it("Licenses promises no renewal alerts (none exist yet)", () => {
    expect(FEATURE_BY_KEY.licenses.line).not.toMatch(/alert|remind|renew|expir/i);
    expect(FEATURE_BY_KEY.safety_log.line).not.toMatch(/alert|remind/i);
  });

  it("isFeatureKey takes only whitelisted strings", () => {
    expect(isFeatureKey("leads")).toBe(true);
    expect(isFeatureKey("plan")).toBe(false);
    expect(isFeatureKey(undefined)).toBe(false);
    expect(isFeatureKey({})).toBe(false);
  });

  it("FEATURE_KEYS equals public.feature_keys() in 0352", () => {
    const sql = migration("0352_");
    const body = sql.slice(sql.indexOf("function public.feature_keys()"));
    const arr = body.slice(body.indexOf("array["), body.indexOf("]::text[]"));
    const keys = [...arr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...FEATURE_KEYS]);
  });
});

describe("trade presets", () => {
  it("one entry per TRADE_ORDER key, nothing extra", () => {
    expect(Object.keys(TRADE_FEATURES).sort()).toEqual([...TRADE_ORDER].sort());
    // …and every TRADE_ORDER key is still an onboarding option.
    for (const t of TRADE_ORDER) expect(TRADE_PRESETS[t], t).toBeDefined();
  });

  it("every preset is a whole map of booleans", () => {
    for (const t of [...TRADE_ORDER, "", "other", "nonsense", null, 42]) {
      const p = featurePreset(t);
      expect(Object.keys(p)).toEqual([...FEATURE_KEYS]);
      for (const v of Object.values(p)) expect(typeof v).toBe("boolean");
    }
  });

  it("blank, other and unknown trades get the blank preset", () => {
    expect(featurePreset("")).toEqual(BLANK_PRESET);
    expect(featurePreset("other")).toEqual(BLANK_PRESET);
    expect(featurePreset(undefined)).toEqual(BLANK_PRESET);
    expect(normalizeTradeKey("other")).toBe("");
    expect(normalizeTradeKey("electrical")).toBe("electrical");
  });

  it("the blank preset is the light app the plan names", () => {
    const on = FEATURE_KEYS.filter((k) => BLANK_PRESET[k]);
    expect(on).toEqual(["leads", "estimates", "crew_payroll", "permits", "licenses", "website", "nort", "calculators"]);
  });

  it("builders get kits and contracts; electrical gets stock and the panel; plumbing and HVAC stock; tile kits", () => {
    for (const t of ["general", "deck", "roofing", "concrete"]) {
      const p = featurePreset(t);
      expect(p.kits && p.contracts, t).toBe(true);
      expect(p.shop_stock || p.panel_map, t).toBe(false);
    }
    expect(featurePreset("electrical")).toMatchObject({ shop_stock: true, panel_map: true, kits: false, contracts: false });
    expect(featurePreset("plumbing")).toMatchObject({ shop_stock: true, panel_map: false });
    expect(featurePreset("hvac")).toMatchObject({ shop_stock: true, panel_map: false });
    expect(featurePreset("tile")).toMatchObject({ kits: true, contracts: false });
  });

  it("permits are off for landscaping and painting only", () => {
    for (const t of TRADE_ORDER) expect(featurePreset(t).permits, t).toBe(!["landscaping", "painting"].includes(t));
  });

  it("no preset turns on something the plan starts OFF for everyone", () => {
    for (const t of TRADE_ORDER) {
      const p = featurePreset(t);
      for (const k of ["referrals", "purchase_orders", "daily_reports", "crew_board", "job_codes", "customer_portal", "recurring_billing", "sales_tax", "safety_log", "site_chat", "todo_extras"] as const) {
        expect(p[k], `${t}.${k}`).toBe(false);
      }
    }
  });
});

describe("normalizeFeatures: the read rule", () => {
  it("no map = everything on (today's app, byte for byte)", () => {
    for (const raw of [undefined, null, {}, [], "features", 3]) expect(normalizeFeatures(raw)).toEqual(ALL_ON);
  });

  it("only a real boolean turns a key off", () => {
    const m = normalizeFeatures({ leads: false, kits: "false", nort: 0, website: null, permits: true, stray: false });
    expect(m.leads).toBe(false);
    expect(m.kits).toBe(true);
    expect(m.nort).toBe(true);
    expect(m.website).toBe(true);
    expect(m.permits).toBe(true);
    expect(Object.keys(m)).toEqual([...FEATURE_KEYS]);
  });

  it("job_codes falls back to the old checkbox only while the switch is missing", () => {
    expect(normalizeFeatures({}, false).job_codes).toBe(false);
    expect(normalizeFeatures({}, true).job_codes).toBe(true);
    expect(normalizeFeatures({}, undefined).job_codes).toBe(true);
    expect(normalizeFeatures({}, "false").job_codes).toBe(true); // a string is not a stated false
    expect(normalizeFeatures({ job_codes: true }, false).job_codes).toBe(true);
    expect(normalizeFeatures({ job_codes: false }, true).job_codes).toBe(false);
  });

  it("is total and idempotent", () => {
    const samples: unknown[] = [undefined, {}, { leads: false }, { job_codes: false, website: "x" }, BLANK_PRESET, featurePreset("deck")];
    for (const raw of samples) {
      for (const legacy of [undefined, true, false]) {
        const once = normalizeFeatures(raw, legacy);
        expect(normalizeFeatures(once, legacy)).toEqual(once);
        expect(normalizeFeatures(once)).toEqual(once);
      }
    }
  });
});

describe("featureOn", () => {
  it("no map reads as all on", () => {
    for (const k of FEATURE_KEYS) {
      expect(featureOn(undefined, k)).toBe(true);
      expect(featureOn(null, k)).toBe(true);
    }
  });

  it("a sub-switch is on only while its parent is on", () => {
    const m: FeatureMap = { ...ALL_ON, crew_payroll: false };
    expect(featureOn(m, "crew_payroll")).toBe(false);
    expect(featureOn(m, "daily_reports")).toBe(false);
    expect(featureOn(m, "crew_board")).toBe(false);
    expect(featureOn(m, "job_codes")).toBe(true);
    // The child's own value is kept: turning the parent back on brings the child back as it was.
    expect(featureOn({ ...m, crew_payroll: true }, "daily_reports")).toBe(true);
    expect(featureOn({ ...ALL_ON, daily_reports: false }, "daily_reports")).toBe(false);
  });
});

describe("offFeatureKey: a cache-friendly plain value", () => {
  it("is empty when everything is on and sorted otherwise", () => {
    expect(offFeatureKey(undefined)).toBe("");
    expect(offFeatureKey(ALL_ON)).toBe("");
    expect(offFeatureKey({ ...ALL_ON, website: false, leads: false })).toBe("leads,referrals,site_chat,website");
  });

  it("round-trips through featuresFromOffKey", () => {
    for (const m of [ALL_ON, BLANK_PRESET, featurePreset("electrical"), { ...ALL_ON, licenses: false }]) {
      const back = featuresFromOffKey(offFeatureKey(m));
      for (const k of FEATURE_KEYS) expect(featureOn(back, k), k).toBe(featureOn(m, k));
    }
    expect(featuresFromOffKey("nonsense,leads")).toEqual({ ...ALL_ON, leads: false });
  });
});
