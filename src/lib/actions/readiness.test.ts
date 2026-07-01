import { describe, it, expect } from "vitest";
import { z } from "zod";
import { REGISTRY } from "./registry";
import { computeReadiness, missingFieldPaths } from "./readiness";

// The fragment kernel: the ACTION schemas are the "what am I missing" engine, and an
// update input is a true PATCH — an omitted field must never materialize as a default
// that the handler then writes (the silent-wipe bug this wave fixed).

describe("computeReadiness — schemas as the missing-field engine", () => {
  it("names the absent required fields of a fragment", () => {
    const r = computeReadiness("bill.create", {});
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("supplier");
  });

  it("a complete fragment is ready", () => {
    expect(computeReadiness("bill.create", { supplier: "CED" })).toEqual({ ready: true, missing: [] });
    expect(computeReadiness("task.create", { title: "Order breakers" }).ready).toBe(true);
  });

  it("an unknown action is never ready (and never throws)", () => {
    expect(computeReadiness("nope.nope", {})).toEqual({ ready: false, missing: [] });
  });

  it("a present-but-invalid value blocks readiness WITHOUT appearing in missing", () => {
    const r = computeReadiness("task.create", { title: "x", category: "nonsense" });
    expect(r.ready).toBe(false);
    expect(r.missing).not.toContain("category");
  });

  it("missingFieldPaths reports dot-joined nested paths", () => {
    const schema = z.object({ items: z.array(z.object({ description: z.string() })) });
    const err = schema.safeParse({ items: [{}] });
    expect(err.success).toBe(false);
    if (!err.success) expect(missingFieldPaths(err.error)).toEqual(["items.0.description"]);
  });
});

describe("time.addEntry — the two shapes + the payroll boundary", () => {
  const schema = REGISTRY["time.addEntry"].input;

  it("accepts exact times OR an explicit work_date + hours", () => {
    expect(schema.safeParse({ clock_in: "2026-06-30T08:00:00Z", clock_out: "2026-06-30T16:00:00Z" }).success).toBe(true);
    expect(schema.safeParse({ work_date: "2026-06-30", hours: 6 }).success).toBe(true);
  });

  it("a day WITHOUT the hours asks for hours — never infers them", () => {
    expect(computeReadiness("time.addEntry", { work_date: "2026-06-30" })).toEqual({
      ready: false,
      missing: ["hours"],
    });
  });

  it("half of the exact-times shape names the other half", () => {
    expect(computeReadiness("time.addEntry", { clock_in: "2026-06-30T08:00:00Z" }).missing).toEqual(["clock_out"]);
  });
});

describe("update inputs are true PATCHES — no schema default may resurrect the wipe bug", () => {
  // Each pair: [action, minimal identifying input]. Parsing the minimal input must yield
  // EXACTLY those keys — any extra key is a default that the handler would then WRITE,
  // silently overwriting data (money fields included).
  const cases: [string, Record<string, string>][] = [
    ["quote.update", { id: "q1" }],
    ["quote.updateItem", { item_id: "i1", quote_id: "q1" }],
    ["invoice.updateItem", { item_id: "i1", invoice_id: "v1" }],
    ["invoice.setCustomerJob", { invoice_id: "v1" }],
    ["changeorder.update", { id: "c1" }],
    ["purchaseorder.update", { id: "p1" }],
    ["workorder.update", { id: "w1" }],
    ["customer.update", { id: "c1" }],
    ["bill.update", { id: "b1" }],
    ["lien.update", { job_id: "j1" }],
  ];
  for (const [name, minimal] of cases) {
    it(`${name} parses a minimal patch without injecting defaults`, () => {
      const parsed = REGISTRY[name].input.safeParse(minimal);
      expect(parsed.success, `${name} rejected its minimal patch`).toBe(true);
      if (parsed.success)
        expect(Object.keys(parsed.data as object).sort()).toEqual(Object.keys(minimal).sort());
    });
  }

  it("single-field setters now REQUIRE their field instead of defaulting to a wipe", () => {
    // Omitting the payload used to clear the column via .default(null)/.default("").
    expect(REGISTRY["invoice.setDueDate"].input.safeParse({ invoice_id: "v1" }).success).toBe(false);
    expect(REGISTRY["invoice.setTitle"].input.safeParse({ invoice_id: "v1" }).success).toBe(false);
    expect(REGISTRY["quote.setCustomer"].input.safeParse({ id: "q1" }).success).toBe(false);
    expect(REGISTRY["job.assign"].input.safeParse({ id: "j1" }).success).toBe(false);
    // …while an explicit null (a deliberate clear) still parses.
    expect(REGISTRY["invoice.setDueDate"].input.safeParse({ invoice_id: "v1", due_date: null }).success).toBe(true);
    expect(REGISTRY["job.assign"].input.safeParse({ id: "j1", assignee: null }).success).toBe(true);
  });
});
