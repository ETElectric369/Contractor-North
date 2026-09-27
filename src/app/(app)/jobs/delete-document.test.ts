import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A DELETED RECEIPT LEAVES NO DEAD DOOR ON ITS BILL (2026-09-27: bills and job photos kept
 * separate). The link that says which paper made which bill (organized_items) names the file
 * itself, and only its document_id is SET NULL when the documents row goes. Deleting the receipt
 * then removed the file the link still named, so the bill's row said "The receipt couldn't load just
 * now. Reload to try again." forever. Pinned: every link naming the file lets go of it (org-scoped,
 * after the row is gone), and the file is removed only when that write answered; a failed write
 * keeps the file so the bill still opens it. Unscripted calls throw, so every statement is counted.
 */

const state = vi.hoisted(() => ({
  client: null as any,
  reportError: vi.fn(),
  adminOn: true,
  // What the service role reads naming the file: by file_url, then by document_id.
  adminRows: [] as { byFile: any; byDoc: any }[],
  adminReads: 0,
}));
vi.mock("@/lib/supabase/admin", () => ({
  adminConfigured: () => state.adminOn,
  createAdminClient: () => ({
    from(table: string) {
      if (table !== "organized_items") throw new Error(`unscripted admin table: ${table}`);
      const eqs: [string, unknown][] = [];
      const chain: any = {
        select: () => chain,
        eq(col: string, val: unknown) { eqs.push([col, val]); return chain; },
        limit: () => {
          state.adminReads++;
          const next = state.adminRows[0];
          if (!next) throw new Error("unscripted admin read");
          const byFile = eqs.some(([c]) => c === "file_url");
          if (!byFile) state.adminRows.shift();
          return Promise.resolve(byFile ? next.byFile : next.byDoc);
        },
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-erik", orgId: ORG })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(), deleteCalendarItem: vi.fn() }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: state.reportError }));

import { deleteDocument } from "./actions";

const ORG = "60195593-0000-4000-8000-000000000001";
const JOB = "22222222-2222-4222-8222-222222222222";
const DOC = "55555555-5555-4555-8555-555555555555";
const PATH = `${ORG}/${JOB}/1727312345678-ced-ticket.jpg`;

type Call = { table: string; verb: string; payload?: any; eqs: [string, unknown][] };

function fakeSupabase(script: Record<string, any[]>, calls: Call[], removed: string[][]) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-erik" } } }) },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          calls.push({ table: "storage", verb: "remove", eqs: [] });
          removed.push(paths);
          return { error: null };
        },
      }),
    },
    from(table: string) {
      const mine: Call = { table, verb: "select", eqs: [] };
      calls.push(mine);
      const chain: any = {
        update(payload: any) { mine.verb = "update"; mine.payload = payload; return chain; },
        delete() { mine.verb = "delete"; return chain; },
        select() { return chain; },
        eq(col: string, val: unknown) { mine.eqs.push([col, val]); return chain; },
        maybeSingle: () => Promise.resolve(next(`${table}.${mine.verb}`)),
        then(resolve: any, reject: any) {
          try { resolve(next(`${table}.${mine.verb}`)); } catch (e) { reject?.(e); }
        },
      };
      return chain;
    },
  };
}

let calls: Call[];
let removed: string[][];
function officeWith(script: Record<string, any[]>) {
  calls = [];
  removed = [];
  state.client = fakeSupabase(
    {
      "documents.select": [{ data: { id: DOC, org_id: ORG, file_url: PATH, uploaded_by: "user-erik" }, error: null }],
      "profiles.select": [{ data: { role: "owner", active: true }, error: null }],
      ...script,
    },
    calls,
    removed,
  );
}

beforeEach(() => state.reportError.mockClear());

describe("deleting a receipt that made a bill", () => {
  it("its bill's link lets go of the file, then the file is removed", async () => {
    officeWith({
      "documents.delete": [{ data: [{ id: DOC }], error: null }],
      "organized_items.update": [{ data: [{ id: "tie-1" }], error: null }],
    });
    const res = await deleteDocument(DOC, null, JOB);
    expect(res).toEqual({ ok: true });
    const tie = calls.find((c) => c.table === "organized_items")!;
    expect(tie.verb).toBe("update");
    expect(tie.payload).toEqual({ file_url: null });
    // Org-scoped, and by the file itself: a link Organize wrote with no document names it too.
    expect(tie.eqs).toEqual(expect.arrayContaining([["org_id", ORG], ["file_url", PATH]]));
    expect(removed).toEqual([[PATH]]);
    // The row goes first (a refused delete touches no link), and the file last.
    const order = calls.map((c) => `${c.table}.${c.verb}`).filter((k) => k !== "profiles.select" && k !== "documents.select");
    expect(order).toEqual(["documents.delete", "organized_items.update", "storage.remove"]);
  });

  it("a photo no bill names: the write finds nothing, which is an answer, and the file is removed", async () => {
    officeWith({
      "documents.delete": [{ data: [{ id: DOC }], error: null }],
      "organized_items.update": [{ data: [], error: null }],
    });
    expect(await deleteDocument(DOC, null, JOB)).toEqual({ ok: true });
    expect(removed).toEqual([[PATH]]);
  });

  it("the link's write failed: the file is kept, so the bill still opens its receipt, and it is logged", async () => {
    officeWith({
      "documents.delete": [{ data: [{ id: DOC }], error: null }],
      "organized_items.update": [{ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }],
    });
    expect(await deleteDocument(DOC, null, JOB)).toEqual({ ok: true });
    expect(removed).toEqual([]);
    expect(state.reportError).toHaveBeenCalledWith("deleteDocument.tiesLetGo", expect.anything(), { documentId: DOC });
  });

  it("a delete that doesn't land touches no link and no file", async () => {
    officeWith({ "documents.delete": [{ data: [], error: null }] });
    expect(await deleteDocument(DOC, null, JOB)).toEqual({ ok: false, error: "Document not found." });
    expect(calls.some((c) => c.table === "organized_items")).toBe(false);
    expect(removed).toEqual([]);
  });
});

/**
 * A TECH DELETING WHAT THEY PUT THERE (review of release/v1026). Their sign-in sees only the links
 * they made, so the office's link from a bill to the tech's receipt was invisible: the release found
 * nothing and the file went out from under the bill. The links are read past RLS first.
 */
describe("a tech deleting a receipt or photo they added", () => {
  const techWith = (script: Record<string, any[]>) =>
    officeWith({ "profiles.select": [{ data: { role: "tech", active: true }, error: null }], ...script });
  const none = { data: [], error: null };
  beforeEach(() => {
    state.adminOn = true;
    state.adminRows = [];
    state.adminReads = 0;
  });

  it("one the office recorded as a cost is refused in words, and nothing is deleted", async () => {
    state.adminRows = [{ byFile: { data: [{ id: "tie-1", created_by: "user-office", bill_id: "bill-1" }], error: null }, byDoc: none }];
    techWith({});
    const res = await deleteDocument(DOC, null, JOB);
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/^The office recorded this receipt as a cost, so only the office can delete it/) });
    expect(calls.some((c) => c.verb === "delete" || c.verb === "update")).toBe(false);
    expect(removed).toEqual([]);
  });

  it("a link by the document alone counts too (a receipt tied to a supplier invoice)", async () => {
    state.adminRows = [{ byFile: none, byDoc: { data: [{ id: "tie-2", created_by: "user-office", tied_supplier_invoice_id: "si-1" }], error: null } }];
    techWith({});
    expect(await deleteDocument(DOC, null, JOB)).toMatchObject({ ok: false });
    expect(removed).toEqual([]);
  });

  it("a blurry photo nobody else names goes, file and all", async () => {
    state.adminRows = [{ byFile: none, byDoc: none }];
    techWith({ "documents.delete": [{ data: [{ id: DOC }], error: null }], "organized_items.update": [none] });
    expect(await deleteDocument(DOC, null, JOB)).toEqual({ ok: true });
    expect(state.adminReads).toBe(2);
    expect(removed).toEqual([[PATH]]);
  });

  it("a link somebody else made that holds no money: the row goes, the file stays (the link still opens it)", async () => {
    state.adminRows = [{ byFile: { data: [{ id: "tie-3", created_by: "user-office" }], error: null }, byDoc: none }];
    techWith({ "documents.delete": [{ data: [{ id: DOC }], error: null }] });
    expect(await deleteDocument(DOC, null, JOB)).toEqual({ ok: true });
    expect(calls.some((c) => c.table === "organized_items")).toBe(false);
    expect(removed).toEqual([]);
  });

  it("the links can't be read (no service role, or a failed read): the row goes, the file stays", async () => {
    state.adminOn = false;
    techWith({ "documents.delete": [{ data: [{ id: DOC }], error: null }] });
    expect(await deleteDocument(DOC, null, JOB)).toEqual({ ok: true });
    expect(state.adminReads).toBe(0);
    expect(removed).toEqual([]);
    state.adminOn = true;
    state.adminRows = [{ byFile: { data: null, error: { code: "57014", message: "timeout" } }, byDoc: none }];
    techWith({ "documents.delete": [{ data: [{ id: DOC }], error: null }] });
    expect(await deleteDocument(DOC, null, JOB)).toEqual({ ok: true });
    expect(removed).toEqual([]);
    expect(state.reportError).toHaveBeenCalledWith("deleteDocument.fileHeldByOthers", expect.anything(), { documentId: DOC });
  });

  it("staff never need the read: their own sign-in reaches every link", async () => {
    officeWith({ "documents.delete": [{ data: [{ id: DOC }], error: null }], "organized_items.update": [none] });
    expect(await deleteDocument(DOC, null, JOB)).toEqual({ ok: true });
    expect(state.adminReads).toBe(0);
    expect(removed).toEqual([[PATH]]);
  });
});
