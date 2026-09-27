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

  // Text a stranger wrote on the page (a review, a comment) can't reach Notes as a contact detail.
  const PAGE = "Acme Supply home page. Open Mon–Fri 8 AM–5 PM.";

  it.each([
    ["an email", "Pay invoices by Zelle to billing@evil.example"],
    ["a web address", "Pay online at https://evil.example/pay"],
    ["a bare www address", "Pay online at www.evil.example"],
    ["a phone number", "Call 530-555-0199 for payment"],
    ["a phone number written loosely", "Billing line (530)555 0199"],
  ])("drops a line about them with %s in it", (_what, about) => {
    expect(guardModelFields({ about }, PAGE, CATEGORIES)).toEqual({});
  });

  it.each([
    ["an email", "Mon–Fri 8 AM–5 PM, email billing@evil.example"],
    ["a phone number", "Call 530-555-0199 for payment"],
    ["a web address", "Mon–Fri, see https://evil.example"],
    ["no day or clock at all", "Pay invoices by Zelle only"],
  ])("drops hours with %s", (_what, hours) => {
    expect(guardModelFields({ hours }, PAGE, CATEGORIES)).toEqual({});
  });

  it.each([
    ["an email", "Acme billing@acme.example"],
    ["a web address", "Acme https://acme.example"],
    ["a www address", "www.acme.example"],
    ["a phone number", "Acme 530-555-0199"],
    ["seven digits", "Acme 5550199"],
  ])("drops a name with %s in it", (_what, name) => {
    expect(guardModelFields({ name }, `${PAGE} ${name}`, CATEGORIES)).toEqual({});
  });

  it("keeps plain hours, a plain line about them, and a name with a short number in it", () => {
    expect(
      guardModelFields(
        { name: "Acme Supply 2", hours: "Mon–Fri 8 AM–5 PM", about: "Electrical supply house — since 1972" },
        PAGE,
        CATEGORIES,
      ),
    ).toEqual({ name: "Acme Supply 2", hours: "Mon–Fri 8 AM–5 PM", about: "Electrical supply house — since 1972" });
    expect(guardModelFields({ hours: "Open 24/7" }, "Open 24/7", CATEGORIES)).toEqual({ hours: "Open 24/7" });
    expect(guardModelFields({ hours: "Tue, Thu 9 AM–1 PM" }, "Counter open Tuesdays and Thursdays, 9 to 1.", CATEGORIES)).toEqual({
      hours: "Tue, Thu 9 AM–1 PM",
    });
  });
});

describe("guardModelFields: the model's hours are the page's hours", () => {
  const PAGE = "Pine County Building Department. Counter: Monday through Friday, 8:00 to 4:30. Closed 12-1 for lunch.";

  it("keeps hours whose every clock number the page shows", () => {
    expect(guardModelFields({ hours: "Mon–Fri 8 AM–4:30 PM" }, PAGE, CATEGORIES)).toEqual({ hours: "Mon–Fri 8 AM–4:30 PM" });
  });

  it.each([
    ["an hour the page never shows", "Mon–Fri 9 AM–6 PM"],
    ["minutes the page never shows", "Mon–Fri 8 AM–4:45 PM"],
    ["no clock at all", "Weekdays"],
    ["only days", "Mon–Fri"],
  ])("drops hours with %s (made up, or nothing the page can back up)", (_what, hours) => {
    expect(guardModelFields({ hours }, PAGE, CATEGORIES)).toEqual({});
  });

  it("reads a 24-hour page, a 12-hour page, and noon, the way the model writes them", () => {
    expect(guardModelFields({ hours: "Mon–Fri 8 AM–5 PM" }, "Hours 08:00-17:00 weekdays", CATEGORIES)).toEqual({ hours: "Mon–Fri 8 AM–5 PM" });
    expect(guardModelFields({ hours: "Mon–Fri 08:00–17:00" }, "Open weekdays 8 to 5", CATEGORIES)).toEqual({ hours: "Mon–Fri 08:00–17:00" });
    expect(guardModelFields({ hours: "Sat 9 AM–12 PM" }, "Saturday 9 until noon", CATEGORIES)).toEqual({ hours: "Sat 9 AM–12 PM" });
  });
});
