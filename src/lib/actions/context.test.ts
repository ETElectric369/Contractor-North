import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE ACTION CONTEXT CARRIES THE CALLER'S LANGUAGE (cn-v1138). buildActionCtx is the ONE place a
 * caller is resolved for every surface (the chat route's tool loop, a UI button, the voice), and
 * the language rides the same profile read as the role (projection law: the select names it, one
 * trip). A handler whose sentence the person hears word for word reads ctx.lang; "en" when there is
 * nobody or the column is empty; never from a client.
 */
const db = vi.hoisted(() => ({ user: true, row: { role: "tech", org_id: "org-1", language: "es" } as Record<string, unknown> | null, selects: [] as string[] }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: db.user ? { id: "user-1" } : null } }) },
    from: () => {
      const q: any = {};
      q.select = (cols: string) => {
        db.selects.push(cols);
        return q;
      };
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: db.row, error: null });
      return q;
    },
  })),
}));

describe("buildActionCtx", () => {
  beforeEach(() => {
    db.user = true;
    db.row = { role: "tech", org_id: "org-1", language: "es" };
    db.selects = [];
  });

  it("reads the language on the same trip as the role, and puts it on the context", async () => {
    const { buildActionCtx } = await import("./context");
    const ctx = await buildActionCtx();
    expect(ctx).toEqual({ userId: "user-1", orgId: "org-1", role: "tech", lang: "es" });
    expect(db.selects).toEqual(["role, org_id, language"]);
  });

  it("an empty or unknown language is English; so is nobody signed in", async () => {
    const { buildActionCtx } = await import("./context");
    db.row = { role: "owner", org_id: "org-1", language: null };
    expect((await buildActionCtx()).lang).toBe("en");
    db.row = { role: "owner", org_id: "org-1", language: "fr" };
    expect((await buildActionCtx()).lang).toBe("en");
    db.user = false;
    expect(await buildActionCtx()).toEqual({ userId: null, orgId: null, role: null, lang: "en" });
  });
});
