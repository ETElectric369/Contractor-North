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
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: vi.fn(async () => {}), currentOrgId: vi.fn(async () => "org-1") }));

import { generateMaterialDraft } from "./actions";

describe("generateMaterialDraft", () => {
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
