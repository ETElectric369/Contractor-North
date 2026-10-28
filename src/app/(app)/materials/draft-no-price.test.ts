import { describe, it, expect, vi } from "vitest";

/**
 * THE SCOPE DRAFT GUESSES NO PRICE AND NO VENDOR (2026-10-15). "Generate from a scope" used to ask
 * the model for a "rough per-unit USD" and a vendor on every line — a guess (the model only
 * structures; it never prices — the no-speculation law) into est_cost, the column the checklist
 * stopped showing in cn-v1108. The prompt no longer asks, and anything the model volunteers anyway
 * is dropped before it reaches a line.
 */
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => true), officeRecipients: vi.fn(async () => []), ringOffice: vi.fn(async () => {}) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));
vi.mock("@/app/(app)/tasks/actions", () => ({ createTask: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    throw new Error("no database in this test");
  }),
}));
const calls: Record<string, unknown>[] = [];
vi.mock("@/lib/anthropic", () => ({
  DEFAULT_MODEL: "test-model",
  getAnthropic: () => ({
    messages: {
      create: async (req: Record<string, unknown>) => {
        calls.push(req);
        return {
          content: [
            {
              type: "text",
              text: '[{"description":"12/2 NM-B","part_number":null,"quantity":250,"unit":"ft","vendor":"Northline Supply","est_cost":1.1},{"description":"20A breaker","quantity":2,"unit":"ea"}]',
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  }),
}));
// THE OFFICE'S DOOR, GATED (cn-v1137): requireStaff and aiAllowed both stood at nothing before.
const door = vi.hoisted(() => ({
  staff: { supabase: {}, userId: "user-1", orgId: "org-1" } as any,
  gate: { ok: true } as { ok: true } | { ok: false; why: string; reason: "lapsed" | "ceiling" },
}));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => door.staff) }));
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: vi.fn(async () => {}), aiAllowed: vi.fn(async () => door.gate) }));

import { generateMaterialDraft } from "./actions";

describe("generateMaterialDraft", () => {
  it("is the office's: the crew is refused in words, and no model is reached", async () => {
    door.staff = { error: "This action is staff-only." };
    const before = calls.length;
    expect(await generateMaterialDraft("200A panel swap")).toEqual({ ok: false, error: "This action is staff-only." });
    expect(calls.length).toBe(before);
    door.staff = { supabase: {}, userId: "user-1", orgId: "org-1" };
  });

  it("a company whose plan has ended is told the one action, and no model is reached (cn-v1137)", async () => {
    const why = "This company's plan has ended, so Nort is paused. Pick a plan in Settings › Getting Paid.";
    door.gate = { ok: false, reason: "lapsed", why };
    const before = calls.length;
    expect(await generateMaterialDraft("200A panel swap")).toEqual({ ok: false, error: why });
    expect(calls.length).toBe(before);
    door.gate = { ok: true };
  });

  it("asks the model for no price and no vendor, and drops any it volunteers", async () => {
    const r = await generateMaterialDraft("200A panel swap, 12 circuits");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toEqual([
      { description: "12/2 NM-B", part_number: null, quantity: 250, unit: "ft", vendor: null, est_cost: null },
      { description: "20A breaker", part_number: null, quantity: 2, unit: "ea", vendor: null, est_cost: null },
    ]);
    const system = String(calls[0]?.system ?? "");
    expect(system).toContain("No prices and no vendors");
    expect(system).not.toContain("est_cost");
    expect(system).not.toContain('"vendor"');
    expect(system).not.toContain("USD");
  });
});
