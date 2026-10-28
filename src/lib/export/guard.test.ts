import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE OWNER-ONLY EXPORT GUARD (cn-v1138): built on requireStaff's refusals, one more step for the
 * role, the owner named by first name for everyone else, and NO subscription read — a lapsed owner
 * passes. requireStaff and the owner read are mocked the way the accountant export's test mocks them.
 */
const state = vi.hoisted(() => ({
  ctx: null as null | Record<string, unknown>,
  owner: "Larkspur" as string | null,
  ownerReads: [] as unknown[],
}));

vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => state.ctx) }));
vi.mock("@/lib/lapse-words", () => ({
  ownerFirstName: vi.fn(async (orgId: unknown) => {
    state.ownerReads.push(orgId);
    return state.owner;
  }),
}));
vi.mock("@/lib/subscription", () => {
  throw new Error("the export guard must read no subscription state");
});

import { requireOwnerExport, OWNER_ONLY_WORDS, SIGN_IN_WORDS } from "./guard";

beforeEach(() => {
  state.ctx = { supabase: {}, userId: "u-owner", orgId: "org-1", role: "owner" };
  state.owner = "Larkspur";
  state.ownerReads = [];
});

describe("requireOwnerExport", () => {
  it("the owner passes with the company and their own id, and nobody's name is read", async () => {
    expect(await requireOwnerExport()).toEqual({ ok: true, orgId: "org-1", profileId: "u-owner" });
    expect(state.ownerReads).toEqual([]);
  });

  it("not signed in: 401, one action", async () => {
    state.ctx = { error: "Not signed in." };
    expect(await requireOwnerExport()).toEqual({ ok: false, status: 401, words: SIGN_IN_WORDS });
    expect(SIGN_IN_WORDS).toBe("Sign in to download the company's data.");
  });

  it("not staff, or deactivated: 403 in the owner-only words", async () => {
    state.ctx = { error: "This action is staff-only." };
    expect(await requireOwnerExport()).toEqual({ ok: false, status: 403, words: OWNER_ONLY_WORDS });
    state.ctx = { error: "This account has been deactivated." };
    expect(await requireOwnerExport()).toEqual({ ok: false, status: 403, words: OWNER_ONLY_WORDS });
    // ONE action named, never a bare "only the owner can".
    expect(OWNER_ONLY_WORDS).toBe("Ask the owner to download the company's data.");
    expect(OWNER_ONLY_WORDS).toMatch(/^Ask /);
    expect(state.ownerReads).toEqual([]);
  });

  it("staff who is not the owner: 403 naming the owner by first name, through the one owner read", async () => {
    state.ctx = { supabase: {}, userId: "u-office", orgId: "org-1", role: "office" };
    expect(await requireOwnerExport()).toEqual({ ok: false, status: 403, words: "Ask Larkspur to download the company's data." });
    expect(state.ownerReads).toEqual(["org-1"]);
    state.ctx = { supabase: {}, userId: "u-admin", orgId: "org-1", role: "admin" };
    state.owner = null;
    expect(await requireOwnerExport()).toEqual({ ok: false, status: 403, words: "Ask the owner to download the company's data." });
  });

  it("staff with no company to scope to is refused, never run unscoped", async () => {
    state.ctx = { supabase: {}, userId: "u-owner", orgId: null, role: "owner" };
    expect(await requireOwnerExport()).toEqual({ ok: false, status: 403, words: OWNER_ONLY_WORDS });
  });
});
