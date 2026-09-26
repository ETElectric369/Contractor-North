import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The switches for a page that doesn't read its company already (0352): the person's role and their
 * company's normalized map, in one read. Anything that fails reads as today's app (all on) and never
 * as the owner, so no Turn On button is drawn that might refuse.
 */
let user: { id: string } | null = { id: "u1" };
let row: unknown = null;
let error: unknown = null;
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => {
      const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: row, error }) };
      return b;
    },
  }),
}));

const { readViewerFeatures, featureOffSentence } = await import("./viewer-features");
const { ALL_ON } = await import("./features");

beforeEach(() => {
  user = { id: "u1" };
  row = null;
  error = null;
});

describe("readViewerFeatures", () => {
  it("the owner, with the company's switches (missing = on)", async () => {
    row = { role: "owner", organizations: { settings: { features: { sales_tax: false } } } };
    const v = await readViewerFeatures();
    expect(v.isOwner).toBe(true);
    expect(v.features).toEqual({ ...ALL_ON, sales_tax: false });
  });
  it("anyone else is not the owner; an embed that comes back as a list is read the same", async () => {
    row = { role: "office", organizations: [{ settings: { features: { website: false } } }] };
    const v = await readViewerFeatures();
    expect(v).toEqual({ features: { ...ALL_ON, website: false }, isOwner: false });
  });
  it("no switches stored: everything on", async () => {
    row = { role: "tech", organizations: { settings: {} } };
    expect(await readViewerFeatures()).toEqual({ features: ALL_ON, isOwner: false });
  });
  it("signed out, a failed read, or no row: today's app, and never the owner", async () => {
    user = null;
    expect(await readViewerFeatures()).toEqual({ features: ALL_ON, isOwner: false });
    user = { id: "u1" };
    error = { code: "57014" };
    row = { role: "owner", organizations: { settings: { features: { sales_tax: false } } } };
    expect(await readViewerFeatures()).toEqual({ features: ALL_ON, isOwner: false });
    error = null;
    row = null;
    expect(await readViewerFeatures()).toEqual({ features: ALL_ON, isOwner: false });
  });
});

describe("featureOffSentence", () => {
  it("names the feature and who can turn it on, in plain words", () => {
    expect(featureOffSentence("recurring_billing")).toBe("Recurring Billing is off. The owner can turn it on in Settings, Features.");
  });
});
