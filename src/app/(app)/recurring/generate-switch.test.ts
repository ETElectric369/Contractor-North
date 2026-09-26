import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * RECURRING BILLING OFF (0352, rule h) at the office's own Generate doors: not drawn while off, and
 * refused in plain words if reached anyway, with the engine never asked. On, or no switches stored,
 * they run and render as today. (The engine's own skip is pinned in lib/recurring-switch.test.)
 */
let settings: unknown = {};
const client = {
  from: (table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () =>
        table === "recurring_templates"
          ? { data: { id: "t1", kind: "invoice", next_date: "2026-09-01", frequency: "monthly" }, error: null }
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

const { generateOne, generateDue } = await import("./actions");
const { RecurringRowActions } = await import("./recurring-actions-ui");

beforeEach(() => {
  settings = {};
  runInvoiceTemplate.mockClear();
  generateDueTemplates.mockClear();
});

describe("Generate One Now on each row", () => {
  const row = (p: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(RecurringRowActions as any, { id: "t1", active: true, ...p }));
  it("on / not passed: today's row; off: no Generate button, Pause still there", () => {
    expect(row({ canGenerate: true })).toBe(row());
    expect(row()).toContain('title="Generate one now"');
    const off = row({ canGenerate: false });
    expect(off).not.toContain('title="Generate one now"');
    expect(off).toContain('title="Pause"');
  });
});

describe("Generate while Recurring Billing is off", () => {
  it("no switches stored: both run exactly as today", async () => {
    expect(await generateOne("t1")).toEqual({ ok: true });
    expect(runInvoiceTemplate).toHaveBeenCalledTimes(1);
    expect(await generateDue()).toEqual({ ok: true, count: 2 });
    expect(generateDueTemplates).toHaveBeenCalledTimes(1);
  });

  it("off: both refuse in words, and the engine is never asked", async () => {
    settings = { features: { recurring_billing: false } };
    const one = await generateOne("t1");
    const due = await generateDue();
    for (const r of [one, due]) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe("Recurring Billing is off. The owner can turn it on in Settings, Features.");
    }
    expect(runInvoiceTemplate).not.toHaveBeenCalled();
    expect(generateDueTemplates).not.toHaveBeenCalled();
  });

  it("another switch off changes nothing", async () => {
    settings = { features: { sales_tax: false } };
    expect(await generateOne("t1")).toEqual({ ok: true });
  });
});
