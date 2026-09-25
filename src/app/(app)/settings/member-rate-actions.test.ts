import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AUDIT v994 MR7 (Erik): an owner may leave his personal bill rate empty; his hours then bill at
 * the customer's level rate or the org's default, NEVER his old stored wage. profile_pay reads an
 * owner's bill rate as coalesce(bill_rate, hourly_rate) (0286), so clearing the Bill box has to
 * take that stored wage with it, on the server. A pay figure for an owner is still refused.
 */
const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { updateMemberRate } from "./actions";

type Row = { id: string; org_id: string; role: string; full_name: string; active?: boolean };

function fake(rows: Row[], writes: { patch: any; filters: [string, unknown][] }[]) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
    from(table: string) {
      if (table !== "profiles") throw new Error(`unexpected table ${table}`);
      const filters: [string, unknown][] = [];
      let patch: any = null;
      const chain: any = {
        select() {
          return chain;
        },
        update(p: any) {
          patch = p;
          return chain;
        },
        eq(col: string, v: unknown) {
          filters.push([col, v]);
          return chain;
        },
        maybeSingle: async () => ({ data: rows.find((r) => filters.every(([c, v]) => (r as any)[c] === v)) ?? null, error: null }),
        then(ok: (v: any) => any, err?: (e: any) => any) {
          writes.push({ patch, filters: [...filters] });
          const hit = rows.filter((r) => filters.every(([c, v]) => (r as any)[c] === v));
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(ok, err);
        },
      };
      return chain;
    },
  };
}

const ROWS: Row[] = [
  { id: "me", org_id: "org-1", role: "owner", full_name: "Erik Taylor", active: true },
  { id: "chris", org_id: "org-1", role: "owner", full_name: "Chris Taylor" },
  { id: "brian", org_id: "org-1", role: "tech", full_name: "Brian Taylor" },
  { id: "other", org_id: "org-2", role: "tech", full_name: "Someone Else" },
];

describe("updateMemberRate (audit v994 MR7)", () => {
  let writes: { patch: any; filters: [string, unknown][] }[];
  beforeEach(() => {
    writes = [];
    state.client = fake(ROWS, writes);
  });

  it("an owner's cleared bill rate clears the stored wage with it, so billing never falls back to it", async () => {
    const res = await updateMemberRate("chris", undefined, null);
    expect(res).toEqual({ ok: true });
    expect(writes.at(-1)!.patch).toEqual({ bill_rate: null, hourly_rate: null });
    expect(writes.at(-1)!.filters).toContainEqual(["org_id", "org-1"]);
  });

  it("an owner's bill rate saves on its own and leaves everything else alone", async () => {
    await updateMemberRate("chris", undefined, 110);
    expect(writes.at(-1)!.patch).toEqual({ bill_rate: 110 });
  });

  it("an owner still has no pay rate to set", async () => {
    const res = await updateMemberRate("chris", 120, 110);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("paid by owner's draw");
    expect(writes.every((w) => w.patch === null)).toBe(true);
  });

  it("a crew member's cleared bill rate leaves his pay rate alone", async () => {
    await updateMemberRate("brian", 40, null);
    expect(writes.at(-1)!.patch).toEqual({ hourly_rate: 40, bill_rate: null });
  });

  it("another org's member is not found", async () => {
    const res = await updateMemberRate("other", 40, 80);
    expect(res).toEqual({ ok: false, error: "Member not found." });
  });
});
