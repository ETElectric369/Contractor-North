import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * RECURRING BILLING OFF (0352, rule h) at the office's own Generate doors: an invoice's Generate is
 * not drawn while off, and refused in plain words if reached anyway, with the engine never asked. A
 * repeat job or expense is not the switch's: it generates as before. On, or no switches stored, they
 * run and render as today. (The engine's own skip is pinned in lib/recurring-switch.test.)
 */
let settings: unknown = {};
let kind = "invoice";
const writes: string[] = [];
const client = {
  from: (table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      insert: () => (writes.push(`insert ${table}`), b),
      update: () => (writes.push(`update ${table}`), b),
      then: (ok: any, err?: any) => Promise.resolve({ data: [{ id: "t1" }], error: null }).then(ok, err),
      maybeSingle: async () =>
        table === "recurring_templates"
          ? { data: { id: "t1", kind, next_date: "2026-09-01", frequency: "monthly" }, error: null }
          : { data: { settings }, error: null },
    };
    return b;
  },
};
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: client, userId: "u1", orgId: "org-1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
const runInvoiceTemplate = vi.fn(async () => true);
const runTemplate = vi.fn(async () => true);
const generateDueTemplates = vi.fn(async () => 2);
vi.mock("@/lib/recurring-engine", () => ({
  runInvoiceTemplate: (...a: unknown[]) => (runInvoiceTemplate as any)(...a),
  runTemplate: (...a: unknown[]) => (runTemplate as any)(...a),
  generateDueTemplates: (...a: unknown[]) => (generateDueTemplates as any)(...a),
}));

const { generateOne, generateDue, saveRecurring } = await import("./actions");
const { RecurringRowActions } = await import("./recurring-actions-ui");

beforeEach(() => {
  settings = {};
  kind = "invoice";
  writes.length = 0;
  runInvoiceTemplate.mockClear();
  runTemplate.mockClear();
  generateDueTemplates.mockClear();
});

describe("Generate One Now on each row", () => {
  const row = (p: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(RecurringRowActions as any, { id: "t1", active: true, ...p }));
  it("on / not passed: today's row; off: no Generate button, Pause still there", () => {
    expect(row({ canGenerate: true })).toBe(row());
    expect(row()).toContain('title="Generate One Now"');
    const off = row({ canGenerate: false });
    expect(off).not.toContain('title="Generate One Now"');
    expect(off).toContain('title="Pause"');
  });
});

describe("the toast says what was made", () => {
  it("Generate One Now: a job is created, an expense added, an invoice generated", async () => {
    const { madeWords } = await import("./recurring-actions-ui");
    expect(madeWords("invoice")).toBe("Invoice generated");
    expect(madeWords("job")).toBe("Job created");
    expect(madeWords("expense")).toBe("Expense added");
  });

  it("each row is told its kind, and Generate Due counts recurring items, not invoices", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "src/app/(app)/recurring");
    expect(readFileSync(join(dir, "page.tsx"), "utf8")).toContain("<RecurringRowActions id={t.id} active={t.active} kind={t.kind}");
    const ui = readFileSync(join(dir, "recurring-actions-ui.tsx"), "utf8");
    expect(ui).not.toMatch(/Generated \$\{n\} invoices|Generated 1 invoice"/);
    expect(ui).toContain("`Generated ${n} recurring items`");
  });
});

describe("Generate while Recurring Billing is off", () => {
  it("no switches stored: both run exactly as today", async () => {
    expect(await generateOne("t1")).toEqual({ ok: true });
    expect(runInvoiceTemplate).toHaveBeenCalledTimes(1);
    expect(await generateDue()).toEqual({ ok: true, count: 2 });
    expect(generateDueTemplates).toHaveBeenCalledTimes(1);
  });

  it("off: an invoice's Generate One Now refuses in words, and the engine is never asked for it", async () => {
    settings = { features: { recurring_billing: false } };
    const one = await generateOne("t1");
    expect(one.ok).toBe(false);
    expect(one.error).toBe("Recurring Billing is off. The owner can turn it on in Settings, Features.");
    expect(runInvoiceTemplate).not.toHaveBeenCalled();
  });

  it("off: a repeat job or expense still generates, and Generate Due runs the engine (which skips only invoices)", async () => {
    settings = { features: { recurring_billing: false } };
    for (const k of ["job", "expense"]) {
      kind = k;
      expect(await generateOne("t1")).toEqual({ ok: true });
    }
    expect(runTemplate).toHaveBeenCalledTimes(2);
    expect(await generateDue()).toEqual({ ok: true, count: 2 });
    expect(generateDueTemplates).toHaveBeenCalledTimes(1);
  });

  it("another switch off changes nothing", async () => {
    settings = { features: { sales_tax: false } };
    expect(await generateOne("t1")).toEqual({ ok: true });
  });
});

describe("New Recurring while Recurring Billing is off (the switch takes only repeat invoices)", () => {
  const form = (k: string) => {
    const f = new FormData();
    f.set("kind", k);
    f.set("title", "Monthly");
    f.set("next_date", "2026-10-01");
    f.set("frequency", "monthly");
    f.set("customer_id", "c1");
    f.set("line_items", JSON.stringify([{ description: "Service", quantity: 1, unit_price: 100 }]));
    f.set("category", "Other");
    return f;
  };

  it("no switches stored: a new repeat invoice saves exactly as today", async () => {
    expect(await saveRecurring(form("invoice"))).toEqual({ ok: true });
    expect(writes).toEqual(["insert recurring_templates"]);
  });

  it("off: a new repeat invoice is refused in words, and nothing is written", async () => {
    settings = { features: { recurring_billing: false } };
    const r = await saveRecurring(form("invoice"));
    expect(r).toEqual({ ok: false, error: "Recurring Billing is off. The owner can turn it on in Settings, Features." });
    expect(writes).toEqual([]);
  });

  it("off: a job or expense can't be turned into a repeat invoice either", async () => {
    settings = { features: { recurring_billing: false } };
    kind = "job"; // the stored template
    expect((await saveRecurring(form("invoice"), "t1")).ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it("off: an existing repeat invoice still saves its edits; a new job or expense saves as today", async () => {
    settings = { features: { recurring_billing: false } };
    expect(await saveRecurring(form("invoice"), "t1")).toEqual({ ok: true });
    expect(await saveRecurring(form("job"))).toEqual({ ok: true });
    expect(await saveRecurring(form("expense"))).toEqual({ ok: true });
    expect(writes).toEqual(["update recurring_templates", "insert recurring_templates", "insert recurring_templates"]);
  });
});
