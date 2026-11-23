import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE TWO DOORS OF 0419's send-again dismissal (Erik, 2026-11-22: "I know its been revised and I
 * don't want to send it again, can we put a dismiss button on those please").
 *
 * The stand-in HONOURS a read's filters: an invoice of another company is simply not found, the way
 * Postgres answers a query naming the wrong org_id, and an update lands only on rows its filters match.
 */

const state = vi.hoisted(() => ({
  guard: { supabase: null as any, userId: "user-1", orgId: "org-1" } as any,
  rows: [] as any[],
  calls: [] as { verb: string; cols?: string; payload?: any; filters: [string, unknown][] }[],
  failUpdate: null as null | { message: string },
  dropUpdate: false,
}));

vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => state.guard) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";
import { dismissResendNotice, restoreResendNotice } from "./resend-notice-actions";

function fake() {
  return {
    from(table: string) {
      expect(table).toBe("invoices");
      const filters: [string, unknown][] = [];
      let verb = "select";
      let cols = "";
      let payload: any;
      const match = () => state.rows.filter((r) => filters.every(([k, v]) => r[k] === v));
      const chain: any = {
        select(c: string) {
          if (verb === "select") cols = c;
          return chain;
        },
        update(p: any) {
          verb = "update";
          payload = p;
          return chain;
        },
        eq(k: string, v: unknown) {
          filters.push([k, v]);
          return chain;
        },
        async maybeSingle() {
          state.calls.push({ verb, cols, filters: [...filters] });
          return { data: match()[0] ?? null, error: null };
        },
        then(resolve: any, reject: any) {
          state.calls.push({ verb, cols, payload, filters: [...filters] });
          if (state.failUpdate) return Promise.resolve({ data: null, error: state.failUpdate }).then(resolve, reject);
          const hit = state.dropUpdate ? [] : match();
          for (const r of hit) Object.assign(r, payload);
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

const INV = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
/** A notice that stands: paid before the change, the money moved since the send, a balance left. */
const standing = () => ({
  id: INV,
  org_id: "org-1",
  status: "partial",
  sent_at: "2026-10-01T18:04:00.000Z",
  revised_at: "2026-10-05T21:30:00.000Z",
  total: 1250,
  amount_paid: 500,
  sent_total: 1000,
  resend_dismissed_at: null as string | null,
  payments: [{ paid_at: "2026-10-02T17:00:00.000Z" }],
});

beforeEach(() => {
  state.guard = { supabase: fake(), userId: "user-1", orgId: "org-1" };
  state.rows = [standing()];
  state.calls = [];
  state.failUpdate = null;
  state.dropUpdate = false;
  vi.mocked(revalidatePath).mockClear();
});

const updates = () => state.calls.filter((c) => c.verb === "update");

describe("dismissResendNotice", () => {
  it("the guard: a person who is not staff gets the guard's sentence and nothing is read", async () => {
    state.guard = { error: "This action is staff-only." };
    expect(await dismissResendNotice(INV)).toEqual({ ok: false, error: "This action is staff-only." });
    expect(state.calls).toEqual([]);
  });

  it("a sign-in with no company is refused before any read", async () => {
    state.guard = { supabase: fake(), userId: "user-1", orgId: null };
    expect((await dismissResendNotice(INV)).ok).toBe(false);
    expect(state.calls).toEqual([]);
  });

  it("not a uuid: refused before any read", async () => {
    expect(await dismissResendNotice("INV-900")).toEqual({ ok: false, error: "That invoice couldn't be found." });
    expect(state.calls).toEqual([]);
  });

  it("reads by id AND company, everything the rule needs", async () => {
    await dismissResendNotice(INV);
    const read = state.calls[0];
    expect(read.filters).toEqual([["id", INV], ["org_id", "org-1"]]);
    for (const col of ["status", "sent_at", "revised_at", "total", "amount_paid", "sent_total", "resend_dismissed_at", "payments(paid_at)"]) expect(read.cols).toContain(col);
  });

  it("another company's invoice is not found, and nothing is written", async () => {
    state.rows = [{ ...standing(), id: OTHER, org_id: "org-2" }];
    expect(await dismissResendNotice(OTHER)).toEqual({ ok: false, error: "That invoice couldn't be found." });
    expect(updates()).toEqual([]);
    expect(state.rows[0].resend_dismissed_at).toBeNull();
  });

  it("the write: a stamp later than the send, named by id and company, read back, and both pages refreshed", async () => {
    expect(await dismissResendNotice(INV)).toEqual({ ok: true });
    const [u] = updates();
    expect(Object.keys(u.payload)).toEqual(["resend_dismissed_at"]);
    expect(u.filters).toEqual([["id", INV], ["org_id", "org-1"]]);
    expect(Date.parse(state.rows[0].resend_dismissed_at)).toBeGreaterThan(Date.parse(state.rows[0].sent_at));
    // never a revision, never a send
    expect(state.rows[0].sent_at).toBe("2026-10-01T18:04:00.000Z");
    expect(state.rows[0].revised_at).toBe("2026-10-05T21:30:00.000Z");
    expect(revalidatePath).toHaveBeenCalledWith("/billing");
    expect(revalidatePath).toHaveBeenCalledWith(`/billing/${INV}`);
  });

  it("nothing standing: ok, and NO write (unpaid, already dismissed, void)", async () => {
    for (const row of [
      { ...standing(), amount_paid: 0, payments: [] },
      { ...standing(), resend_dismissed_at: "2026-10-06T09:00:00.000Z" },
      { ...standing(), status: "void" },
      { ...standing(), sent_total: 1250 },
    ]) {
      state.rows = [row];
      state.calls = [];
      expect(await dismissResendNotice(INV)).toEqual({ ok: true });
      expect(updates()).toEqual([]);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a zero-row write is a failure said to the caller", async () => {
    state.dropUpdate = true;
    const res = await dismissResendNotice(INV);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("wasn't dismissed");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a write the database refuses is said", async () => {
    state.failUpdate = { message: "permission denied" };
    expect((await dismissResendNotice(INV)).ok).toBe(false);
  });
});

describe("restoreResendNotice", () => {
  it("the guard holds here too", async () => {
    state.guard = { error: "Not signed in." };
    expect(await restoreResendNotice(INV)).toEqual({ ok: false, error: "Not signed in." });
    expect(state.calls).toEqual([]);
  });

  it("clears a dismissal: null, by id and company, read back, refreshed", async () => {
    state.rows = [{ ...standing(), resend_dismissed_at: "2026-10-06T09:00:00.000Z" }];
    expect(await restoreResendNotice(INV)).toEqual({ ok: true });
    const [u] = updates();
    expect(u.payload).toEqual({ resend_dismissed_at: null });
    expect(u.filters).toEqual([["id", INV], ["org_id", "org-1"]]);
    expect(state.rows[0].resend_dismissed_at).toBeNull();
    expect(revalidatePath).toHaveBeenCalledWith(`/billing/${INV}`);
  });

  it("nothing to clear: ok, no write", async () => {
    expect(await restoreResendNotice(INV)).toEqual({ ok: true });
    expect(updates()).toEqual([]);
  });

  it("another company's invoice is not found", async () => {
    state.rows = [{ ...standing(), id: OTHER, org_id: "org-2", resend_dismissed_at: "2026-10-06T09:00:00.000Z" }];
    expect((await restoreResendNotice(OTHER)).ok).toBe(false);
    expect(updates()).toEqual([]);
  });

  it("a zero-row write is said", async () => {
    state.rows = [{ ...standing(), resend_dismissed_at: "2026-10-06T09:00:00.000Z" }];
    state.dropUpdate = true;
    expect((await restoreResendNotice(INV)).ok).toBe(false);
  });
});

describe("the file", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/billing/resend-notice-actions.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  it("is never a revision and never a send", () => {
    expect(code).not.toContain("stampInvoiceRevised");
    const writes = [...code.matchAll(/\.update\(\{([^}]*)\}\)/g)].map((m) => m[1].trim());
    expect(writes).toEqual(["resend_dismissed_at: new Date().toISOString()", "resend_dismissed_at: null"]);
  });
});
