import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE ROLE GATE BEHIND THE SETTINGS SAVE (cn-v1193, fixer #93). updateOrgSettings asks
 * resolveSiteContext who the caller is: staff of their own company get the full settings write;
 * an outside site collaborator gets only the update_site_content RPC; anyone else is refused.
 * Before this file, treating a tech as staff here left every test green, and this gate now stands
 * in front of a company-wide switch (Clock-In Reminders). Its answer per role:
 *  - owner, admin, office: staff of their own company (isCollaborator false).
 *  - tech: NOT staff. With no grant, refused. With a site_collaborators grant for their own company,
 *    let through as a COLLABORATOR (isCollaborator true), which only reaches the marketing-key RPC.
 * This is now THE rule for the Clock-In Reminders box (the owner, 2026-11-26: "Office too"): owner,
 * admin and office save it like every other key on the Scheduling card; a tech never can.
 */
const state = vi.hoisted(() => ({
  user: { id: "u-sam" } as { id: string } | null,
  me: { org_id: "org-901", role: "owner" } as { org_id: string | null; role: string } | null,
  grants: [] as { org_id: string }[],
}));

function builder(table: string) {
  const b: any = {
    select: () => b,
    eq: () => b,
    order: async () => ({ data: table === "site_collaborators" ? state.grants : [], error: null }),
    maybeSingle: async () => ({ data: table === "profiles" ? state.me : null, error: null }),
  };
  return b;
}
const client = {
  auth: { getUser: async () => ({ data: { user: state.user } }) },
  from: (t: string) => builder(t),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client) }));

const { resolveSiteContext, SITE_CONTENT_KEYS } = await import("./site-editor-guard");
const { liveFunctionBody } = await import("@/lib/migration-body.test-util");

beforeEach(() => {
  state.user = { id: "u-sam" };
  state.me = { org_id: "org-901", role: "owner" };
  state.grants = [];
});

describe("resolveSiteContext: who is let through as staff", () => {
  for (const role of ["owner", "admin", "office"]) {
    it(`${role}: staff of their own company`, async () => {
      state.me = { org_id: "org-901", role };
      const ctx = await resolveSiteContext();
      expect(ctx).toMatchObject({ orgId: "org-901", isCollaborator: false, userId: "u-sam" });
      expect(await resolveSiteContext("org-901")).toMatchObject({ orgId: "org-901", isCollaborator: false });
    });
  }

  it("tech: not staff, refused with no grant (inferred or named)", async () => {
    state.me = { org_id: "org-901", role: "tech" };
    expect(await resolveSiteContext()).toEqual({ error: "You don't have access to manage articles." });
    expect(await resolveSiteContext("org-901")).toEqual({ error: "You don't have access to that site." });
  });

  it("tech who is a site collaborator: let through only as a collaborator, never as staff", async () => {
    state.me = { org_id: "org-901", role: "tech" };
    state.grants = [{ org_id: "org-901" }];
    expect(await resolveSiteContext()).toMatchObject({ orgId: "org-901", isCollaborator: true });
    expect(await resolveSiteContext("org-901")).toMatchObject({ orgId: "org-901", isCollaborator: true });
  });

  it("not signed in: refused", async () => {
    state.user = null;
    expect(await resolveSiteContext()).toEqual({ error: "Not signed in." });
  });
});

describe("a tech who is a site collaborator reaches only the whitelisted site keys, never remind_clock_in", () => {
  it("the app's read list names only marketing keys, and not remind_clock_in", () => {
    expect(SITE_CONTENT_KEYS as readonly string[]).not.toContain("remind_clock_in");
    expect(SITE_CONTENT_KEYS as readonly string[]).toContain("splash_headline");
  });

  it("the live update_site_content RPC (the collaborator's only write) does not name remind_clock_in", () => {
    const live = liveFunctionBody("update_site_content");
    expect(live, "no migration creates public.update_site_content").not.toBeNull();
    expect(live!.body).toContain("'splash_headline'");
    expect(live!.body).not.toContain("remind_clock_in");
  });
});
