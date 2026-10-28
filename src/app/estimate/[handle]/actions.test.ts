import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE PUBLIC DECK CONFIGURATOR'S SUBMIT IS BEHIND THE ONE GATE (cn-v1135, lib/org-trade
 * deckConfiguratorOn): a POST straight at submitEstimateLead for a company that is not a deck company
 * pricing from its catalog is refused BEFORE any pricing read — no price list read, no lead filed,
 * no inspection booked — with the same words the page's absence reads as. Driven on a recording fake
 * of the service client; the triage is a fake too, so a deck company's path is proven to reach it.
 */
const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  reads: [] as string[],
  triaged: 0,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: async () => false, clientIp: () => "203.0.113.9" }));
vi.mock("@/lib/inquiries/create-triaged-inquiry", () => ({
  createTriagedInquiry: async () => {
    state.triaged++;
    return { triage: { showInstantPrice: false, siteInspectionRequired: true, bucket: "C" } };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      state.reads.push(table);
      const q: any = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        maybeSingle: async () => (table === "organizations" ? { data: { id: "org-1", settings: { public_handle: "fixture", ...state.settings } }, error: null } : { data: null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      };
      return q;
    },
  }),
}));

const { submitEstimateLead } = await import("./actions");

const payload = () => ({
  answers: { projectType: "new_deck", material: "wood", lengthFt: 12, widthFt: 16, heightFt: 3, railingLf: 40, stairFlights: 1, stairSteps: 4, stairRailing: true, stairRailingLf: 8, shape: "rectangle", wrapAround: false, manDoors: 1, sliderDoors: 0, trpa: false } as any,
  qualifying: { hasPlans: false, plansApproved: null, noPlansPath: "dimensions" as const },
  contact: { name: "Thistlewood", phone: "530-555-0100" },
});

beforeEach(() => {
  state.settings = {};
  state.reads = [];
  state.triaged = 0;
});

describe("submitEstimateLead on a company that is not a deck company pricing from its catalog", () => {
  it.each([
    ["a catalog-mode landscaper", { trade: "landscaping", estimating_mode: "catalog" }],
    ["a deck company in research mode", { trade: "deck", estimating_mode: "research" }],
    ["a company whose trade isn't known", { estimating_mode: "catalog" }],
  ])("%s: refused in the page's words, before any pricing read, and no lead is filed", async (_who, settings) => {
    state.settings = settings;
    const res = await submitEstimateLead("fixture", payload());
    expect(res).toEqual({ ok: false, error: "This estimator isn't available right now." });
    expect(state.reads).toEqual(["organizations"]);
    expect(state.triaged).toBe(0);
  });
});

describe("the same door for a deck company pricing from its catalog", () => {
  it("reads the price list and files the lead (so the refusal above is the gate, not the fake)", async () => {
    state.settings = { trade: "deck", estimating_mode: "catalog" };
    const res = await submitEstimateLead("fixture", payload());
    expect(res.ok).toBe(true);
    expect(state.reads).toEqual(["organizations", "price_list_items"]);
    expect(state.triaged).toBe(1);
  });
});
