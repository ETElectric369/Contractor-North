import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUTO_FILE_BUCKETS,
  BUSINESS_COST_BUCKETS,
  bucketOf,
  isBusinessCostBucket,
  looksLikeSupplierFee,
} from "./business-cost-buckets";

describe("the business-cost bucket list", () => {
  it("is exactly the six names Erik approved, in order", () => {
    expect([...BUSINESS_COST_BUCKETS]).toEqual([
      "Gas & Truck",
      "Tools & Supplies",
      "Phone & Office",
      "Insurance & Licenses",
      "Fees",
      "Other",
    ]);
  });

  it("has no duplicates, even ignoring case", () => {
    const lower = BUSINESS_COST_BUCKETS.map((b) => b.toLowerCase());
    expect(new Set(lower).size).toBe(BUSINESS_COST_BUCKETS.length);
  });

  it("has no em-dashes in a name a person reads", () => {
    for (const b of BUSINESS_COST_BUCKETS) expect(b).not.toMatch(/—/);
  });

  it("lets the Organize reader file everything but Fees", () => {
    expect(AUTO_FILE_BUCKETS).not.toContain("Fees");
    expect(AUTO_FILE_BUCKETS.length).toBe(BUSINESS_COST_BUCKETS.length - 1);
    for (const b of AUTO_FILE_BUCKETS) expect(isBusinessCostBucket(b)).toBe(true);
  });

  it("knows a bucket from anything else", () => {
    for (const b of BUSINESS_COST_BUCKETS) expect(isBusinessCostBucket(b)).toBe(true);
    expect(isBusinessCostBucket("Fuel")).toBe(false);
    expect(isBusinessCostBucket("gas & truck")).toBe(false);
    expect(isBusinessCostBucket("")).toBe(false);
    expect(isBusinessCostBucket(null)).toBe(false);
    expect(isBusinessCostBucket(undefined)).toBe(false);
  });
});

describe("bucketOf: an old category word to its bucket", () => {
  it("maps the seven old Organize words the way the migration does", () => {
    expect(bucketOf("Fuel")).toBe("Gas & Truck");
    expect(bucketOf("Vehicle")).toBe("Gas & Truck");
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
    expect(bucketOf("FUEL")).toBe("Gas & Truck");
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
    for (const raw of ["Fuel", "x", "", null, "Petty cash", "Fees", "Insurance & Licenses"]) {
      expect(isBusinessCostBucket(bucketOf(raw))).toBe(true);
    }
  });
});

describe("the 0285 migration and bucketOf say the same thing", () => {
  // The stored rows are moved by SQL and new ones by bucketOf. Two copies of one table is how a
  // report ends up with "Fuel" and "Gas & Truck" side by side, so every WHEN line in the migration
  // is checked against the app's answer, and so is its ELSE.
  const sql = readFileSync(
    fileURLToPath(new URL("../../supabase/migrations/0285_business_cost_buckets.sql", import.meta.url)),
    "utf8",
  );
  const pairs = [...sql.matchAll(/when '([^']+)' then '([^']+)'/g)].map((m) => [m[1], m[2]] as const);

  it("has a WHEN line for every old word and every bucket but Other", () => {
    const olds = new Set(pairs.map(([old]) => old));
    for (const w of ["fuel", "vehicle", "shop supplies", "tools", "office", "insurance"]) expect(olds.has(w)).toBe(true);
    for (const b of BUSINESS_COST_BUCKETS) if (b !== "Other") expect(olds.has(b.toLowerCase())).toBe(true);
  });

  it("maps each WHEN line to the bucket bucketOf gives", () => {
    expect(pairs.length).toBeGreaterThan(0);
    for (const [old, bucket] of pairs) {
      expect(isBusinessCostBucket(bucket)).toBe(true);
      expect(bucketOf(old)).toBe(bucket);
    }
  });

  it("sends everything else to Other, as bucketOf does", () => {
    const elses = [...sql.matchAll(/else '([^']+)'\s+end as bucket/g)].map((m) => m[1]);
    expect(elses.length).toBe(2);
    for (const e of elses) expect(e).toBe(bucketOf("anything else"));
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
