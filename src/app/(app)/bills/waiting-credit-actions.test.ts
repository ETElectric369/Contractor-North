import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WAITING ON A CREDIT, THE WRITE (Erik, 2026-09-26; 0346). Pinned: staff only, the org and the
 * paper on every write, the row read back (a zero-row update is a 204 that reads like success),
 * only a purchase can wait, Undo clears exactly what the tap set, and before 0346 is applied the
 * button says it needs one database update instead of failing.
 *
 * The fixture is his real 8802-1107139, $59.17, 13683 HILLSIDE.
 */

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { stopWaitingOnCredit, waitOnCredit } from "./waiting-credit-actions";
import { WAIT_NEEDS_UPDATE } from "./supplier-papers";

type Call = { table: string; verb: string; payload?: any; filters: [string, unknown][]; selected?: string };

function fakeSupabase(script: Record<string, any[]>, calls: Call[], role = "owner") {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      if (table === "profiles") {
        const p: any = { select: () => p, eq: () => p, maybeSingle: async () => ({ data: { role, org_id: "org-1", active: true }, error: null }) };
        return p;
      }
      const call: Call = { table, verb: "select", filters: [] };
      calls.push(call);
      const chain: any = {
        select: (cols: string) => ((call.selected = cols), chain),
        update: (payload: any) => ((call.verb = "update"), (call.payload = payload), chain),
        eq: (col: string, v: unknown) => (call.filters.push([col, v]), chain),
        maybeSingle: () => Promise.resolve(next(`${table}.${call.verb}`)),
        then(resolve: any, reject: any) {
          try {
            resolve(next(`${table}.${call.verb}`));
          } catch (e) {
            reject?.(e);
          }
        },
      };
      return chain;
    },
  };
}

const HILLSIDE = {
  id: "43cf4f98-7660-4214-9dc0-b797edeaab25",
  invoice_number: "8802-1107139",
  kind: "invoice",
  total: "59.17",
  supplier_account_id: "acct-ced",
  waiting_credit_since: null,
  waiting_credit_by: null,
};
let calls: Call[];
beforeEach(() => {
  calls = [];
});

describe("waitOnCredit", () => {
  it("a tech is refused before anything is read or written (supplier costs)", async () => {
    state.client = fakeSupabase({}, calls, "tech");
    const res = await waitOnCredit(HILLSIDE.id);
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("stamps who and when, on this org's paper only, and reads the row back", async () => {
    state.client = fakeSupabase(
      {
        "supplier_invoices.select": [{ data: HILLSIDE, error: null }],
        "supplier_invoices.update": [{ data: [{ id: HILLSIDE.id }], error: null }],
      },
      calls,
    );
    const before = Date.now();
    const res = await waitOnCredit(HILLSIDE.id);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("8802-1107139 is waiting on a credit.");
    expect(res.message).toContain("30 days");
    const read = calls.find((c) => c.verb === "select")!;
    expect(read.filters).toEqual([
      ["org_id", "org-1"],
      ["id", HILLSIDE.id],
    ]);
    const write = calls.find((c) => c.verb === "update")!;
    expect(write.filters).toEqual([
      ["org_id", "org-1"],
      ["id", HILLSIDE.id],
    ]);
    expect(write.selected).toBe("id");
    expect(write.payload.waiting_credit_by).toBe("user-1");
    expect(Date.parse(write.payload.waiting_credit_since)).toBeGreaterThanOrEqual(before - 1000);
    // Undo's token: it was not waiting, so Undo clears.
    expect(res.waitBefore).toEqual({ since: null, by: null });
  });

  it("Wait 30 More Days hands back the first stamp, so Undo can put it back", async () => {
    const first = { ...HILLSIDE, waiting_credit_since: "2026-08-20T17:00:00+00:00", waiting_credit_by: "user-2" };
    state.client = fakeSupabase(
      {
        "supplier_invoices.select": [{ data: first, error: null }],
        "supplier_invoices.update": [{ data: [{ id: HILLSIDE.id }], error: null }],
      },
      calls,
    );
    const res = await waitOnCredit(HILLSIDE.id);
    expect(res.ok).toBe(true);
    expect(res.waitBefore).toEqual({ since: "2026-08-20T17:00:00+00:00", by: "user-2" });
  });

  it("a bill on no supplier account can't wait (a credit pairs on its account): said, nothing written", async () => {
    state.client = fakeSupabase({ "supplier_invoices.select": [{ data: { ...HILLSIDE, supplier_account_id: null }, error: null }] }, calls);
    const res = await waitOnCredit(HILLSIDE.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Put it on a supplier account first");
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("a paper in another company is 'not here', and nothing is written", async () => {
    state.client = fakeSupabase({ "supplier_invoices.select": [{ data: null, error: null }] }, calls);
    const res = await waitOnCredit(HILLSIDE.id);
    expect(res).toEqual({ ok: false, error: "That bill isn't here anymore. Reload the page." });
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("only a purchase can wait on a credit: a credit memo, a statement or interest cannot", async () => {
    state.client = fakeSupabase({ "supplier_invoices.select": [{ data: { ...HILLSIDE, kind: "credit_memo", total: "-59.17" }, error: null }] }, calls);
    const res = await waitOnCredit(HILLSIDE.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("can't wait on one");
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("a zero-row write is said, never read as saved", async () => {
    state.client = fakeSupabase(
      { "supplier_invoices.select": [{ data: HILLSIDE, error: null }], "supplier_invoices.update": [{ data: [], error: null }] },
      calls,
    );
    const res = await waitOnCredit(HILLSIDE.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Nothing was changed.");
  });

  it("before 0346 is applied, the read naming the wait columns fails, and the button says it needs one database update", async () => {
    state.client = fakeSupabase(
      { "supplier_invoices.select": [{ data: null, error: { code: "42703", message: 'column supplier_invoices.waiting_credit_since does not exist' } }] },
      calls,
    );
    const res = await waitOnCredit(HILLSIDE.id);
    expect(res).toEqual({ ok: false, error: WAIT_NEEDS_UPDATE });
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("before 0346 is applied, a failed write says it needs one database update too", async () => {
    state.client = fakeSupabase(
      {
        "supplier_invoices.select": [{ data: HILLSIDE, error: null }],
        "supplier_invoices.update": [{ data: null, error: { code: "PGRST204", message: "Could not find the 'waiting_credit_by' column of 'supplier_invoices' in the schema cache" } }],
      },
      calls,
    );
    const res = await waitOnCredit(HILLSIDE.id);
    expect(res).toEqual({ ok: false, error: WAIT_NEEDS_UPDATE });
    expect(WAIT_NEEDS_UPDATE).toMatch(/^Waiting On A Credit needs one database update\./);
  });
});

describe("stopWaitingOnCredit (Undo, and Stop Waiting on /bills)", () => {
  it("clears both halves of the stamp, on this org's paper, and reads it back", async () => {
    state.client = fakeSupabase({ "supplier_invoices.update": [{ data: [{ id: HILLSIDE.id, invoice_number: "8802-1107139" }], error: null }] }, calls);
    const res = await stopWaitingOnCredit(HILLSIDE.id);
    expect(res).toEqual({ ok: true, message: "8802-1107139 isn't waiting any more. It's back on your list." });
    const write = calls[0];
    expect(write.payload).toEqual({ waiting_credit_since: null, waiting_credit_by: null });
    expect(write.filters).toEqual([
      ["org_id", "org-1"],
      ["id", HILLSIDE.id],
    ]);
    expect(write.selected).toBe("id, invoice_number");
  });

  it("Undo after Wait 30 More Days puts the first stamp back, not a blank one", async () => {
    state.client = fakeSupabase({ "supplier_invoices.update": [{ data: [{ id: HILLSIDE.id, invoice_number: "8802-1107139" }], error: null }] }, calls);
    const res = await stopWaitingOnCredit(HILLSIDE.id, { since: "2026-08-20T17:00:00+00:00", by: "user-1" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("back as it was");
    const write = calls.find((c) => c.verb === "update")!;
    expect(write.payload).toEqual({ waiting_credit_since: "2026-08-20T17:00:00.000Z", waiting_credit_by: "user-1" });
  });

  it("a restore stamp that isn't a real past moment is not trusted: the wait is cleared", async () => {
    state.client = fakeSupabase({ "supplier_invoices.update": [{ data: [{ id: HILLSIDE.id, invoice_number: "8802-1107139" }], error: null }] }, calls);
    await stopWaitingOnCredit(HILLSIDE.id, { since: "2999-01-01T00:00:00Z", by: "someone" });
    expect(calls.find((c) => c.verb === "update")!.payload).toEqual({ waiting_credit_since: null, waiting_credit_by: null });
  });

  it("a tech is refused", async () => {
    state.client = fakeSupabase({}, calls, "tech");
    expect((await stopWaitingOnCredit(HILLSIDE.id)).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
