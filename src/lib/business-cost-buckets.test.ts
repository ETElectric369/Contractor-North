import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUTO_FILE_BUCKETS,
  BUSINESS_COST_BUCKETS,
  LEGACY_GAS_AND_TRUCK,
  bucketOf,
  isBusinessCostBucket,
  looksLikeSupplierFee,
  namesABucket,
} from "./business-cost-buckets";

describe("the business-cost bucket list", () => {
  it("is the names Erik approved, in order: Fuel its own, Gas & Truck renamed Auto (2026-09-27)", () => {
    expect([...BUSINESS_COST_BUCKETS]).toEqual([
      "Fuel",
      "Auto",
      "Tools & Supplies",
      "Phone & Office",
      "Insurance & Licenses",
      "Fees",
      "Other",
    ]);
    expect(BUSINESS_COST_BUCKETS).not.toContain(LEGACY_GAS_AND_TRUCK);
  });

  it("knows a bucket's name as a supplier placeholder, the old Gas & Truck included, and nothing else", () => {
    for (const b of BUSINESS_COST_BUCKETS) expect(namesABucket(b)).toBe(true);
    expect(namesABucket("Gas & Truck")).toBe(true);
    expect(namesABucket("A Gas Station")).toBe(false);
    expect(namesABucket("fuel")).toBe(false);
    expect(namesABucket(null)).toBe(false);
  });

  it("has no duplicates, even ignoring case", () => {
    const lower = BUSINESS_COST_BUCKETS.map((b) => b.toLowerCase());
    expect(new Set(lower).size).toBe(BUSINESS_COST_BUCKETS.length);
  });

  it("has no em-dashes in a name a person reads", () => {
    for (const b of BUSINESS_COST_BUCKETS) expect(b).not.toMatch(/—/);
  });

  it("lets the Organize reader file everything but Fees, Fuel and Auto included", () => {
    expect(AUTO_FILE_BUCKETS).not.toContain("Fees");
    expect(AUTO_FILE_BUCKETS).toContain("Fuel");
    expect(AUTO_FILE_BUCKETS).toContain("Auto");
    expect(AUTO_FILE_BUCKETS.length).toBe(BUSINESS_COST_BUCKETS.length - 1);
    for (const b of AUTO_FILE_BUCKETS) expect(isBusinessCostBucket(b)).toBe(true);
  });

  it("knows a bucket from anything else", () => {
    for (const b of BUSINESS_COST_BUCKETS) expect(isBusinessCostBucket(b)).toBe(true);
    expect(isBusinessCostBucket("fuel")).toBe(false);
    expect(isBusinessCostBucket("Gas & Truck")).toBe(false);
    expect(isBusinessCostBucket("gas & truck")).toBe(false);
    expect(isBusinessCostBucket("")).toBe(false);
    expect(isBusinessCostBucket(null)).toBe(false);
    expect(isBusinessCostBucket(undefined)).toBe(false);
  });
});

describe("bucketOf: an old category word to its bucket", () => {
  it("reads a stored Gas & Truck as Auto, in any letter case, so nothing breaks before 0362 runs", () => {
    expect(bucketOf("Gas & Truck")).toBe("Auto");
    expect(bucketOf(" gas & truck ")).toBe("Auto");
    expect(bucketOf("GAS & TRUCK")).toBe("Auto");
  });

  it("files a fuel word as Fuel and a truck word as Auto", () => {
    for (const w of ["Fuel", "FUEL", "gas", "Gasoline", "diesel"]) expect(bucketOf(w)).toBe("Fuel");
    for (const w of ["Auto", "Vehicle", "truck"]) expect(bucketOf(w)).toBe("Auto");
  });

  it("maps the old Organize words to their buckets", () => {
    expect(bucketOf("Fuel")).toBe("Fuel");
    expect(bucketOf("Vehicle")).toBe("Auto");
    expect(bucketOf("Shop supplies")).toBe("Tools & Supplies");
    expect(bucketOf("Tools")).toBe("Tools & Supplies");
    expect(bucketOf("Office")).toBe("Phone & Office");
    expect(bucketOf("Insurance")).toBe("Insurance & Licenses");
    expect(bucketOf("Other")).toBe("Other");
  });

  it("maps every bucket to itself, in any letter case or with stray spaces", () => {
    for (const b of BUSINESS_COST_BUCKETS) {
      expect(bucketOf(b)).toBe(b);
      expect(bucketOf(b.toUpperCase())).toBe(b);
      expect(bucketOf(`  ${b.toLowerCase()} `)).toBe(b);
    }
  });

  it("ignores letter case on the old words too", () => {
    expect(bucketOf("VEHICLE")).toBe("Auto");
    expect(bucketOf(" shop Supplies ")).toBe("Tools & Supplies");
  });

  it("puts a blank or unknown category in Other", () => {
    // The $47.44 Home Depot row was saved with no category at all.
    expect(bucketOf(null)).toBe("Other");
    expect(bucketOf(undefined)).toBe("Other");
    expect(bucketOf("")).toBe("Other");
    expect(bucketOf("   ")).toBe("Other");
    // Job-cost words and free text from the old Recurring box are not business-cost buckets.
    expect(bucketOf("Materials")).toBe("Other");
    expect(bucketOf("Receipt")).toBe("Other");
    expect(bucketOf("Rent")).toBe("Other");
    expect(bucketOf("Software")).toBe("Other");
  });

  it("always answers with a member of the list", () => {
    for (const raw of ["Fuel", "Gas & Truck", "x", "", null, "Petty cash", "Fees", "Insurance & Licenses"]) {
      expect(isBusinessCostBucket(bucketOf(raw))).toBe(true);
    }
  });
});

describe("the 0285 and 0362 migrations and bucketOf say the same thing", () => {
  // The stored rows are moved by SQL and new ones by bucketOf. Two copies of one table is how a
  // report ends up with "Vehicle" and "Auto" side by side, so every WHEN line in 0285, then 0362's
  // rename on top of it, is checked against the app's answer, and so is 0285's ELSE.
  const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${name}`, import.meta.url)), "utf8");
  const sql = read("0285_business_cost_buckets.sql");
  const sql0362 = read("0362_fuel_is_its_own_bucket.sql");
  const pairs = [...sql.matchAll(/when '([^']+)' then '([^']+)'/g)].map((m) => [m[1], m[2]] as const);
  /** 0362: every stored Gas & Truck is Auto. */
  const after0362 = (bucket: string) => (bucket === LEGACY_GAS_AND_TRUCK ? "Auto" : bucket);
  // Words 0285 put in Gas & Truck before Fuel had a bucket of its own: those ROWS are Auto after
  // 0362 (nothing stored says a fill-up from a repair), while bucketOf files the WORD, written
  // today, as Fuel.
  const FUEL_WORDS = new Set(["fuel", "gas"]);

  it("has a WHEN line for every old word, and 0285's buckets are today's but Fuel, with Auto as Gas & Truck", () => {
    const olds = new Set(pairs.map(([old]) => old));
    for (const w of ["fuel", "vehicle", "shop supplies", "tools", "office", "insurance"]) expect(olds.has(w)).toBe(true);
    for (const b of BUSINESS_COST_BUCKETS) {
      if (b === "Other" || b === "Fuel") continue;
      expect(olds.has(b === "Auto" ? LEGACY_GAS_AND_TRUCK.toLowerCase() : b.toLowerCase())).toBe(true);
    }
  });

  it("maps each WHEN line, renamed by 0362, to the bucket bucketOf gives (a fuel word is Fuel now)", () => {
    expect(pairs.length).toBeGreaterThan(0);
    for (const [old, bucket] of pairs) {
      const stored = after0362(bucket);
      expect(isBusinessCostBucket(stored)).toBe(true);
      expect(bucketOf(old)).toBe(FUEL_WORDS.has(old) ? "Fuel" : stored);
      // The old bucket's own name, still stored anywhere, reads as what 0362 writes.
      expect(bucketOf(bucket)).toBe(stored);
    }
  });

  it("sends everything else to Other, as bucketOf does", () => {
    const elses = [...sql.matchAll(/else '([^']+)'\s+end as bucket/g)].map((m) => m[1]);
    expect(elses.length).toBe(2);
    for (const e of elses) expect(e).toBe(bucketOf("anything else"));
  });

  it("0362 renames Gas & Truck to Auto everywhere a bucket is stored, and adds no column", () => {
    for (const table of ["bills", "recurring_templates", "petty_cash", "organized_items"]) {
      expect(sql0362).toMatch(new RegExp(`update public\\.${table}\\s+set category = 'Auto'\\s+where lower\\(btrim\\(category\\)\\) = 'gas & truck'`));
    }
    expect(sql0362).toMatch(/set supplier = 'Auto'/);
    for (const key of ["{bucket}", "{companyUse,bucket}", "{filed,paperPick}", "{filed,category}"]) expect(sql0362).toContain(`'${key}'`);
    const code = sql0362.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/alter table|create table|add column/i);
    expect(code).not.toMatch(/cost_kind/);
  });
});

describe("looksLikeSupplierFee", () => {
  it("catches the words on a supplier's late or service charge", () => {
    expect(looksLikeSupplierFee("CED service charge 9019059048")).toBe(true);
    expect(looksLikeSupplierFee("Finance Charge on past due balance")).toBe(true);
    expect(looksLikeSupplierFee("Late fee")).toBe(true);
    expect(looksLikeSupplierFee("LATE CHARGES")).toBe(true);
    expect(looksLikeSupplierFee(null, "Interest charge for August")).toBe(true);
    expect(looksLikeSupplierFee("Past due interest")).toBe(true);
  });

  it("leaves an ordinary gas or supply receipt alone", () => {
    expect(looksLikeSupplierFee("Goodwin's General Store", "22.007 gal unleaded at $6.299/gal")).toBe(false);
    expect(looksLikeSupplierFee("Home Depot", "Service panel cover, 2 in EMT")).toBe(false);
    expect(looksLikeSupplierFee(null, undefined, "")).toBe(false);
  });
});
