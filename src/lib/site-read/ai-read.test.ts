import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one small model call behind Fill From Their Site, and the guard on its answer. The model is a
 * scripted client (no paid call, no internet) and the meter is stubbed. Every organization, number
 * and address is made up.
 */

const metered = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/ai-cost", () => ({
  modelFor: () => "claude-haiku-4-5",
  recordAiUsage: vi.fn(async (a: unknown) => {
    metered.push(a);
  }),
}));

import { guardModelFields, readWithModel } from "./ai-read";

const CATEGORIES = ["Building Department", "Utility", "Supplier / Distributor", "Other"] as const;

function client(reply: string) {
  const calls: any[] = [];
  const create = vi.fn(async (params: any, opts?: any) => {
    calls.push({ params, opts });
    return { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 900, output_tokens: 80 }, stop_reason: "end_turn", content: [{ type: "text", text: reply }] };
  });
  return { calls, c: { messages: { create } } as any };
}

beforeEach(() => {
  metered.length = 0;
});

describe("readWithModel: one call, never a second", () => {
  it("a prose reply fills nothing and makes no repair call (no second, unfenced, untimed request)", async () => {
    const { calls, c } = client("Sorry, I can't find any contact details on that page.");
    const out = await readWithModel({ client: c, orgId: "org-1", pageText: "Acme Electric Supply home page", categories: CATEGORIES });
    expect(out).toEqual({});
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toEqual({ timeout: 12_000, maxRetries: 0 });
    expect(metered).toHaveLength(1);
  });

  it("broken JSON (an unescaped quote) also fills nothing, in one call", async () => {
    const { calls, c } = client('{"name":"Acme 6" Supply"}');
    expect(await readWithModel({ client: c, orgId: "org-1", pageText: "Acme", categories: CATEGORIES })).toEqual({});
    expect(calls).toHaveLength(1);
  });

  it("a fenced JSON reply is read and guarded", async () => {
    const { calls, c } = client('Here you go:\n```json\n{"name":"Acme Electric Supply","phones":["530-555-0150"],"category":"Utility",}\n```');
    const out = await readWithModel({ client: c, orgId: "org-1", pageText: "Acme Electric Supply. Call 530-555-0150.", categories: CATEGORIES });
    expect(out).toEqual({ name: "Acme Electric Supply", phones: ["(530) 555-0150"], category: "Utility" });
    expect(calls).toHaveLength(1);
  });
});

describe("guardModelFields: the page's own words back up every contact detail", () => {
  it("drops a phone, email or zip the page doesn't show", () => {
    const page = "Acme Electric Supply. Call (530) 555-0150. 9 Oak Ave, Portola, CA 96122.";
    expect(
      guardModelFields({ name: "Acme Electric Supply", phones: ["530-555-0150", "530-555-0666"], email: "sales@acme.example", zip: "96199" }, page, CATEGORIES),
    ).toEqual({ name: "Acme Electric Supply", phones: ["(530) 555-0150"] });
  });

  it("drops a category outside the list", () => {
    expect(guardModelFields({ category: "Bank" }, "x", CATEGORIES)).toEqual({});
  });
});
