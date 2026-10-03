import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUTO_FILE_BUCKETS,
  BUCKET_SECTION,
  BUSINESS_COST_BUCKETS,
  LEGACY_GAS_AND_TRUCK,
  bucketsIn,
  bucketCategoryPattern,
  bucketOf,
  isBusinessCostBucket,
  looksLikeSupplierFee,
  namesABucket,
} from "./business-cost-buckets";

describe("the business-cost bucket list", () => {
  it("is the names Erik approved, in order: Fuel its own, Gas & Truck renamed Auto, Rent its own (0376)", () => {
    expect([...BUSINESS_COST_BUCKETS]).toEqual([
      "Fuel",
      "Auto",
      "Tools & Supplies",
      "Phone & Office",
      "Insurance & Licenses",
      "Fees",
      "Rent",
      "Other",
    ]);
    // OTHER IS LAST, ALWAYS: it is the bucket for what none of the named ones hold, so a name added
    // after it would read as more specific than the catch-all sitting above it.
    expect(BUSINESS_COST_BUCKETS[BUSINESS_COST_BUCKETS.length - 1]).toBe("Other");
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

describe("which half of the profit and loss each bucket is in (Erik, 2026-09-30: fuel moved to Overhead)", () => {
  it("every bucket is Overhead, Fuel first so it reads above Auto; COGS carries no bucket", () => {
    expect(BUCKET_SECTION).toEqual({
      Fuel: "overhead",
      Auto: "overhead",
      "Tools & Supplies": "overhead",
      "Phone & Office": "overhead",
      "Insurance & Licenses": "overhead",
      Fees: "overhead",
      Rent: "overhead",
      Other: "overhead",
    });
    expect(bucketsIn("cogs")).toEqual([]);
    expect(bucketsIn("overhead")).toEqual([...BUSINESS_COST_BUCKETS]);
    // Erik: "above Auto" — the list's own order puts it there wherever Overhead is drawn.
    expect(bucketsIn("overhead").indexOf("Fuel")).toBeLessThan(bucketsIn("overhead").indexOf("Auto"));
  });

  it("every bucket is in exactly one half, in the list's own order", () => {
    expect(Object.keys(BUCKET_SECTION).sort()).toEqual([...BUSINESS_COST_BUCKETS].sort());
    expect([...bucketsIn("cogs"), ...bucketsIn("overhead")].sort()).toEqual([...BUSINESS_COST_BUCKETS].sort());
    for (const s of ["cogs", "overhead"] as const) {
      const list = bucketsIn(s);
      expect(list).toEqual(BUSINESS_COST_BUCKETS.filter((b) => list.includes(b)));
    }
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
    expect(bucketOf("Software")).toBe("Other");
  });

  it("always answers with a member of the list", () => {
    for (const raw of ["Fuel", "Gas & Truck", "x", "", null, "Petty cash", "Fees", "Insurance & Licenses"]) {
      expect(isBusinessCostBucket(bucketOf(raw))).toBe(true);
    }
  });
});

describe("bucketCategoryPattern: bucketOf's rule as a query", () => {
  // The same words a query asks for with imatch (Postgres ~*: any letter case).
  const asks = (bucket: Parameters<typeof bucketCategoryPattern>[0], category: string) => new RegExp(bucketCategoryPattern(bucket), "i").test(category);
  const samples = ["Fuel", "fuel", " FUEL ", "gas", "Gasoline", "diesel", "Auto", "gas & truck", "Vehicle", "truck", "Tools & Supplies", "tools", "Shop Supplies", "Phone", "office", "Insurance", "Licenses", "Fees", "Fuel surcharge", "Gas station", "gas&truck", "Tools  &  Supplies", "Rent", ""];

  it("matches exactly the categories bucketOf puts in that bucket", () => {
    for (const bucket of BUSINESS_COST_BUCKETS) {
      if (bucket === "Other") continue;
      for (const s of samples) expect([bucket, s, asks(bucket, s)]).toEqual([bucket, s, bucketOf(s) === bucket]);
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
  /**
   * BUCKETS 0285 NEVER HEARD OF. It renamed the old Organize words onto the six buckets of
   * 2026-09-24, so a bucket added after it has no WHEN line of its own and cannot be expected to:
   * Fuel split off Gas & Truck in 0362, and Rent was added in 0376. Named here rather than skipped by
   * a loose rule, so the next bucket added has to be named too instead of quietly going unchecked.
   */
  const AFTER_0285 = new Set(["Fuel", "Rent"]);
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
      if (b === "Other" || AFTER_0285.has(b)) continue;
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

/**
 * THE DATABASE'S BUCKET LIST AND THIS FILE'S ARE ONE LIST (0376). The CHECK on bank_lines.bucket and
 * bank_rules.bucket names the words a row may hold; BUSINESS_COST_BUCKETS names the words the app
 * offers. A bucket in one and not the other is the defect this repo keeps paying for in both
 * directions: a word the app offers that the database refuses is a raw error in front of a person
 * mid-Apply, and a word the database holds that the app has never heard of reads as "Other" on every
 * money surface. So the two are checked against each other here, word for word, in order.
 */
describe("the bucket list the database allows (0376) and the app's are the same list", () => {
  const sql = readFileSync(fileURLToPath(new URL("../../supabase/migrations/0376_rent_is_a_bucket_and_money_can_come_from_the_owner.sql", import.meta.url)), "utf8");

  /** The words inside one of 0376's `bucket in (...)` lists, in the order it writes them. */
  const listsInSql = (): string[][] =>
    [...sql.matchAll(/bucket\s+in\s*\(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((w) => w[1]));

  it("writes the same words, in the same order, on both tables", () => {
    const lists = listsInSql();
    // bank_lines and bank_rules each get one, plus the two the verification block checks for.
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const list of lists) expect(list).toEqual([...BUSINESS_COST_BUCKETS]);
  });

  it("names Rent, so the $1,120 rent cheque has a word on both sides", () => {
    expect(BUSINESS_COST_BUCKETS).toContain("Rent");
    for (const list of listsInSql()) expect(list).toContain("Rent");
    expect(bucketOf("Rent")).toBe("Rent");
    expect(bucketOf(" rent ")).toBe("Rent");
    expect(BUCKET_SECTION.Rent).toBe("overhead");
  });

  it("leaves a cost already filed as Other exactly where it is (bills.category has no CHECK)", () => {
    // 0376 adds a word; it moves no stored row, and neither does bucketOf. A rent bill somebody
    // filed as "Other" before today stays Other until a person moves it.
    expect(bucketOf("Other")).toBe("Other");
    expect(sql.replace(/--[^\n]*/g, "")).not.toMatch(/update\s+public\./i);
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
