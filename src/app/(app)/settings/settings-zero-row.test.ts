import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A ZERO-ROW WRITE IS A 204, NOT A SAVE (the silent-write law). The web address, the custom domain
 * and the document numbering write organizations.settings, which RLS lets only an owner or admin
 * change: an office seat's UPDATE matches no row and PostgREST calls that success. Each setter now
 * asks for the written row back and says so in words when there isn't one, before it drops any
 * stored PDF or moves a counter.
 */
const state = vi.hoisted(() => ({ wrote: [] as { id: string }[], updates: 0, rpcs: 0 }));

function builder(table: string) {
  const b: any = {
    select: () => b,
    eq: () => b,
    neq: () => b,
    maybeSingle: async () => (table === "profiles" ? { data: { org_id: "org-1" }, error: null } : { data: null, error: null }),
    single: async () => ({ data: { settings: { public_handle: "old", doc_prefixes: { invoice: "INV-" } } }, error: null }),
    update: () => {
      state.updates++;
      const u: any = { eq: () => u, select: async () => ({ data: state.wrote, error: null }) };
      return u;
    },
  };
  return b;
}
const client = {
  auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
  from: (t: string) => builder(t),
  rpc: async () => {
    state.rpcs++;
    return { data: null, error: null };
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: client, userId: "me", orgId: "org-1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
const bust = vi.fn(async () => {});
vi.mock("@/lib/pdf-cache", () => ({ bustOrgPdfs: (...a: unknown[]) => (bust as any)(...a) }));

const { setPublicHandle, setCustomDomain, saveNumbering } = await import("./actions");
const NOT_SAVED = "That didn't save — your role can't change company settings. Ask an owner or admin.";

beforeEach(() => {
  state.wrote = [];
  state.updates = 0;
  state.rpcs = 0;
  bust.mockClear();
});

describe("a settings write that matched no row says so", () => {
  it("setPublicHandle", async () => {
    expect(await setPublicHandle("main-street")).toEqual({ ok: false, error: NOT_SAVED });
    expect(bust).not.toHaveBeenCalled();
    state.wrote = [{ id: "org-1" }];
    expect(await setPublicHandle("main-street")).toEqual({ ok: true, handle: "main-street" });
    expect(bust).toHaveBeenCalledTimes(1);
  });

  it("setCustomDomain", async () => {
    expect(await setCustomDomain("mainstreetbuilders.com")).toEqual({ ok: false, error: NOT_SAVED });
    expect(bust).not.toHaveBeenCalled();
    state.wrote = [{ id: "org-1" }];
    expect(await setCustomDomain("mainstreetbuilders.com")).toEqual({ ok: true, domain: "mainstreetbuilders.com" });
  });

  it("saveNumbering, before any counter moves", async () => {
    expect(await saveNumbering({ invoice: "INV-" }, { invoice: 100 })).toEqual({ ok: false, error: NOT_SAVED });
    expect(state.rpcs).toBe(0);
    state.wrote = [{ id: "org-1" }];
    expect(await saveNumbering({ invoice: "INV-" }, { invoice: 100 })).toEqual({ ok: true });
    expect(state.rpcs).toBe(1);
  });
});
