import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCSV } from "@/lib/csv";
import { readOpenListTable, type OpenList, type StoredOpenList } from "@/lib/supplier-open-list";

/**
 * A SUPPLIER'S OPEN LIST, APPLIED AND UNDONE, against an in-memory database that answers the way
 * PostgREST does (a filter that matches nothing is zero rows, never an error). Pinned: one Apply
 * writes exactly the plan the card showed and nothing of another company's; a stale card writes
 * nothing; a list that may be partial closes nothing until a person says it is whole; two presses
 * apply once; Undo puts back exactly what Apply replaced and names what it left.
 */

const state = vi.hoisted(() => ({ client: null as any, orgId: "org-1" }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: state.orgId })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));

import { applyOpenList, addOpenList, pickOpenListColumns } from "./open-list-actions";
import { openListViews, resolveAccount, undoOpenListCore } from "./open-list-core";
import { importCedInvoices } from "./supplier-import-actions";
import { undoPaperwork } from "@/app/(app)/organize/actions";
import { supplierNetIfPaidBy } from "./supplier-balance";
import { addPaperwork } from "@/app/(app)/organize/paperwork-actions";
import { readerFields } from "@/app/(app)/organize/paperwork-core";

type Row = Record<string, any>;
let db: Record<string, Row[]>;
let seq = 0;

function fakeDb() {
  return {
    from(table: string) {
      const rows = (db[table] ??= []);
      const filters: ((r: Row) => boolean)[] = [];
      let verb: "select" | "insert" | "update" | "delete" = "select";
      let payload: any = null;
      let one: "single" | "maybe" | null = null;
      let cap = Infinity;
      let range: [number, number] | null = null;
      const run = () => {
        if (verb === "insert") {
          // organized_items gets its org_id from the database's set_org_id trigger, as in production.
          const list = (Array.isArray(payload) ? payload : [payload]).map((r: Row): Row => ({
            id: `${table}-${++seq}`,
            ...(table === "organized_items" && !r.org_id ? { org_id: state.orgId } : {}),
            ...r,
          }));
          if (table === "organized_items") {
            for (const r of list) {
              if (r.content_sha256 && rows.some((x) => x.org_id === r.org_id && x.content_sha256 === r.content_sha256))
                return { data: null, error: { code: "23505", message: "duplicate key value" } };
            }
          }
          rows.push(...list);
          return { data: one ? list[0] : list, error: null };
        }
        let hit = rows.filter((r) => filters.every((f) => f(r))).slice(0, cap);
        if (range) hit = hit.slice(range[0], range[1] + 1);
        if (verb === "update") {
          for (const r of hit) Object.assign(r, structuredClone(payload));
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        if (verb === "delete") {
          db[table] = rows.filter((r) => !hit.includes(r));
          return { data: hit, error: null };
        }
        // PostgREST's db-max-rows: a select past it comes back cut short, with no error.
        const out = hit.slice(0, 1000).map((r) => structuredClone(r));
        if (one) return { data: out[0] ?? null, error: null };
        return { data: out, error: null };
      };
      const chain: any = {
        select: () => chain,
        insert: (p: any) => ((verb = "insert"), (payload = p), chain),
        update: (p: any) => ((verb = "update"), (payload = p), chain),
        delete: () => ((verb = "delete"), chain),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), chain),
        order: () => chain,
        limit: (n: number) => ((cap = n), chain),
        range: (a: number, b: number) => ((range = [a, b]), chain),
        single: () => ((one = "single"), chain),
        maybeSingle: () => ((one = "maybe"), chain),
        then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      };
      return chain;
    },
  };
}

const CED_OPEN_CSV = `Reference #,Account #,Type,PO Number,Inv Date,Due Date,Inv Amt,Disc Amt,Disc Date,Open Balance
8802-1107338,AC-10427,Invoice,ARR106,09/03/2026,10/15/2026,223.29,4.10,10/10/2026,223.29
8802-1106969,AC-10427,Invoice,13897 HONEYSUCKLE,09/04/2026,10/15/2026,301.81,5.54,10/10/2026,301.81
8802-1107695,AC-10427,Invoice,41 LARKSPUR,09/16/2026,10/15/2026,1062.18,8.47,10/10/2026,1062.18
8802-1107820,AC-10427,Invoice,41 LARKSPUR,09/16/2026,10/15/2026,187.64,1.77,10/10/2026,187.64
8802-1108330,AC-10427,Invoice,518 CINDER LAKE,09/17/2026,10/15/2026,653.25,,,653.25
8802-1108534,AC-10427,Invoice,13897 HONEYSUCKLE,09/22/2026,10/15/2026,873.66,10.02,10/10/2026,873.66
8802-1108540,AC-10427,Credit Memo,518 CINDER LAKE,09/22/2026,10/15/2026,-82.10,,,-82.10
8802-1108541,AC-10427,Credit Memo,518 CINDER LAKE,09/22/2026,10/15/2026,-115.33,,,-115.33
8802-1108647,AC-10427,Invoice,13897 HONEY,09/23/2026,10/15/2026,103.99,,,103.99
8802-1108648,AC-10427,Credit Memo,13897 HONEYSUCKLE,09/23/2026,10/15/2026,-51.58,-0.47,10/10/2026,-51.58
8802-1108649,AC-10427,Invoice,ARR99,09/23/2026,10/15/2026,147.92,1.36,10/10/2026,147.92
`;

const OPEN: [string, string, string, number, number | null, string | null][] = [
  ["8802-1103832", "invoice", "2026-07-22", 10.29, 11.87, "2026-08-10"],
  ["9019682437", "service_charge", "2026-07-25", 31.26, null, null],
  ["8802-1104147", "invoice", "2026-07-28", 101.96, 0.93, "2026-08-10"],
  ["8802-1104268", "invoice", "2026-07-28", 859.99, 6.25, "2026-08-10"],
  ["8802-1104644", "invoice", "2026-07-29", 95.27, 1.48, "2026-08-10"],
  ["8802-1104646", "invoice", "2026-07-29", 36.54, 0.34, "2026-08-10"],
  ["8802-1104645", "credit_memo", "2026-08-06", -31.86, null, null],
  ["8802-1105997", "invoice", "2026-08-19", 2.3, 0.04, "2026-09-10"],
  ["8802-1105963", "invoice", "2026-08-19", 84.37, 0.26, "2026-09-10"],
  ["8802-1106188", "invoice", "2026-08-21", 199.48, 3.67, "2026-09-10"],
  ["8802-1106249", "invoice", "2026-08-21", 150.27, 1.15, "2026-09-10"],
  ["9019994306", "service_charge", "2026-08-25", 15.16, null, null],
  ["8802-1107139", "invoice", "2026-09-01", 59.17, 0.9, "2026-10-10"],
  ["8802-1107088", "invoice", "2026-09-01", 456.02, 4.7, "2026-10-10"],
  ["8802-1107230", "invoice", "2026-09-03", 225.47, 4.14, "2026-10-10"],
  ["8802-1107337", "credit_memo", "2026-09-03", -225.47, null, null],
  ["8802-1107338", "invoice", "2026-09-03", 223.29, 4.1, "2026-10-10"],
  ["8802-1106969", "invoice", "2026-09-04", 301.81, 5.54, "2026-10-10"],
  ["8802-1107820", "invoice", "2026-09-16", 187.64, 1.77, "2026-10-10"],
  ["8802-1107695", "invoice", "2026-09-16", 1062.18, 8.47, "2026-10-10"],
  ["8802-1108330", "invoice", "2026-09-17", 653.25, null, null],
  ["8802-1108540", "credit_memo", "2026-09-22", -82.1, null, null],
  ["8802-1108541", "credit_memo", "2026-09-22", -115.33, null, null],
  ["8802-1108534", "invoice", "2026-09-22", 873.66, 10.02, "2026-10-10"],
];

function cedList(): OpenList {
  const r = readOpenListTable({ table: parseCSV(CED_OPEN_CSV), from: "file", name: "Open.csv", listDate: "2026-09-26", listDateFrom: "file" });
  if (!r.ok) throw new Error("fixture");
  return r.list;
}

function seed(stored: StoredOpenList = { list: cedList(), needs: null }) {
  seq = 0;
  db = {
    organizations: [{ id: "org-1", settings: { timezone: "America/Los_Angeles" } }],
    supplier_accounts: [
      { id: "acct-1", org_id: "org-1", name: "Consolidated Electrical Distributors", account_number: "AC-10427", on_account: true },
      { id: "acct-x", org_id: "org-2", name: "Someone Else's Supplier", account_number: "AC-10427", on_account: true },
    ],
    supplier_invoices: [
      ...OPEN.map(([n, kind, d, open, disc, dby], i) => ({
        id: `si-${i}`, org_id: "org-1", supplier_account_id: "acct-1", invoice_number: n, kind, invoice_date: d, due_date: null,
        total: open, open_balance: open, closed: false, discount_amount: disc, discount_by: dby, job_name_raw: null, job_id: null,
      })),
      // ANOTHER COMPANY, same supplier, same numbers: never read, never written.
      { id: "other-1", org_id: "org-2", supplier_account_id: "acct-x", invoice_number: "8802-1103832", kind: "invoice", invoice_date: "2026-07-22", total: 5, open_balance: 5, closed: false },
    ],
    organized_items: [{ id: "item-1", org_id: "org-1", status: "needs_review", kind: "job_document", doc_type: "statement", title: "Open.csv", proposal: { openList: stored } }],
    bill_supplier_invoices: [],
    supplier_invoice_lines: [],
  };
  state.client = fakeDb();
  state.orgId = "org-1";
}

const openSum = (org = "org-1") =>
  Math.round(db.supplier_invoices.filter((r) => r.org_id === org && r.supplier_account_id === (org === "org-1" ? "acct-1" : "acct-x") && !r.closed).reduce((s, r) => s + Number(r.open_balance), 0) * 100) / 100;

async function viewNow() {
  const views = await openListViews(state.client, "org-1", db.organized_items as any[]);
  return views["item-1"];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T18:00:00Z"));
  seed();
});

describe("Apply", () => {
  it("writes exactly the plan the card showed, and only in this company", async () => {
    const view = await viewNow();
    expect(view.supplier).toBe("Consolidated Electrical Distributors");
    expect(view.accountFrom).toBe("number");
    expect(view.plan!.headline).toBe("Consolidated Electrical Distributors' open list of Sep 26: 16 papers marked paid ($2,070.22), 3 new, balance now $3,304.73.");
    expect(view.plan!.complete.ok).toBe(false);

    const res = await applyOpenList("item-1", { fingerprint: view.plan!.fingerprint, wholeList: true });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("16 papers marked paid ($2,070.22)");
    expect(db.supplier_invoices.filter((r) => r.org_id === "org-1" && r.closed)).toHaveLength(16);
    const added = db.supplier_invoices.filter((r) => ["8802-1108647", "8802-1108648", "8802-1108649"].includes(r.invoice_number));
    expect(added).toHaveLength(3);
    expect(added.every((r) => r.org_id === "org-1" && r.supplier_account_id === "acct-1" && r.closed === false)).toBe(true);
    expect(added.find((r) => r.invoice_number === "8802-1108648")).toMatchObject({ kind: "credit_memo", job_name_raw: "13897 HONEYSUCKLE", open_balance: -51.58, discount_amount: -0.47 });
    expect(openSum()).toBe(3304.73);
    // THE PAY CARD FOLLOWS: it reads these same papers. CED's Total Balance ($3,273.94) takes off
    // every discount on the list, including -$0.47 on credit memo 8802-1108648, and so does the app:
    // the supplier is the truth about its own balance (documentDiscount).
    const pay = supplierNetIfPaidBy(
      db.supplier_invoices
        .filter((r) => r.org_id === "org-1" && r.supplier_account_id === "acct-1")
        .map((r) => ({
          id: r.id, invoiceNumber: r.invoice_number, kind: r.kind, invoiceDate: r.invoice_date, dueDate: r.due_date ?? null, jobNameRaw: null, jobId: null,
          total: Number(r.total), openBalance: r.open_balance, closed: r.closed, discountAmount: r.discount_amount ?? null, discountBy: r.discount_by ?? null,
        })),
      "2026-10-10",
      "2026-09-26",
    );
    expect(pay).toMatchObject({ gross: 3304.73, discount: 30.79, net: 3273.94 });
    // Another company's paper under the same number is exactly as it was.
    expect(db.supplier_invoices.find((r) => r.id === "other-1")).toMatchObject({ closed: false, open_balance: 5 });

    const item = db.organized_items[0];
    expect(item.status).toBe("filed");
    expect(item.proposal.filed).toEqual({ how: "open_list" });
    expect(item.proposal.openList.applied).toMatchObject({ pending: false });
    expect(item.proposal.openList.applied.added).toHaveLength(3);
    expect(item.proposal.openList.applied.changed).toHaveLength(16);
  });

  it("writes nothing from a stale card", async () => {
    const view = await viewNow();
    // Someone else changed a paper after the card was shown.
    db.supplier_invoices.find((r) => r.invoice_number === "8802-1103832")!.open_balance = 5;
    const res = await applyOpenList("item-1", { fingerprint: view.plan!.fingerprint, wholeList: true });
    expect(res).toMatchObject({ ok: false, stale: true });
    expect(db.supplier_invoices.filter((r) => r.closed)).toHaveLength(0);
    expect(db.organized_items[0].status).toBe("needs_review");
  });

  it("closes nothing from a list that may be partial until a person says it is whole", async () => {
    const view = await viewNow();
    const res = await applyOpenList("item-1", { fingerprint: view.plan!.fingerprint });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("could be one page of several");
    expect(db.supplier_invoices.filter((r) => r.closed)).toHaveLength(0);
  });

  it("applies once, however many times it is pressed", async () => {
    const view = await viewNow();
    const first = await applyOpenList("item-1", { fingerprint: view.plan!.fingerprint, wholeList: true });
    const second = await applyOpenList("item-1", { fingerprint: view.plan!.fingerprint, wholeList: true });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(db.supplier_invoices.filter((r) => r.org_id === "org-1")).toHaveLength(27);
  });

  it("never reads the list of another company's row", async () => {
    state.orgId = "org-2";
    const res = await applyOpenList("item-1", { fingerprint: "x", wholeList: true });
    expect(res).toMatchObject({ ok: false, error: "That list isn't here any more." });
  });
});

describe("Undo", () => {
  it("puts back exactly what Apply replaced", async () => {
    const before = structuredClone(db.supplier_invoices);
    const view = await viewNow();
    await applyOpenList("item-1", { fingerprint: view.plan!.fingerprint, wholeList: true });
    const applied = db.organized_items[0].proposal.openList.applied;
    const down = await undoOpenListCore(state.client, "org-1", applied);
    expect(down).toEqual({ ok: true, left: [] });
    expect(db.supplier_invoices).toEqual(before);
  });

  it("is the paper's own Undo: the list waits again, and can be applied again", async () => {
    const before = structuredClone(db.supplier_invoices);
    const view = await viewNow();
    await applyOpenList("item-1", { fingerprint: view.plan!.fingerprint, wholeList: true });
    const res = await undoPaperwork("item-1");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("back as it was");
    expect(db.supplier_invoices).toEqual(before);
    const item = db.organized_items[0];
    expect(item.status).toBe("needs_review");
    expect(item.proposal.filed).toBeNull();
    expect(item.proposal.openList.applied).toBeNull();
    const again = await viewNow();
    expect(again.plan!.fingerprint).toBe(view.plan!.fingerprint);
  });

  it("leaves a paper that changed since, and one something is tied to, and names both", async () => {
    const view = await viewNow();
    await applyOpenList("item-1", { fingerprint: view.plan!.fingerprint, wholeList: true });
    const applied = db.organized_items[0].proposal.openList.applied;
    // A later paid stamp re-opened nothing, but a person corrected this one's balance by hand.
    db.supplier_invoices.find((r) => r.invoice_number === "8802-1104268")!.open_balance = 12;
    const added = db.supplier_invoices.find((r) => r.invoice_number === "8802-1108649")!;
    db.bill_supplier_invoices.push({ id: "link-1", org_id: "org-1", bill_id: "bill-1", supplier_invoice_id: added.id });
    const down = await undoOpenListCore(state.client, "org-1", applied);
    expect(down.ok && down.left).toEqual(["8802-1104268 (it changed since)", "8802-1108649 (something is tied to it now)"]);
    expect(db.supplier_invoices.find((r) => r.invoice_number === "8802-1103832")).toMatchObject({ closed: false, open_balance: 10.29 });
    expect(db.supplier_invoices.some((r) => r.invoice_number === "8802-1108647")).toBe(false);
    expect(db.supplier_invoices.some((r) => r.invoice_number === "8802-1108649")).toBe(true);
  });

  it("keeps an added paper a person changed since Apply", async () => {
    const view = await viewNow();
    await applyOpenList("item-1", { fingerprint: view.plan!.fingerprint, wholeList: true });
    const applied = db.organized_items[0].proposal.openList.applied;
    db.supplier_invoices.find((r) => r.invoice_number === "8802-1108647")!.open_balance = 50;
    const down = await undoOpenListCore(state.client, "org-1", applied);
    expect(down.ok && down.left).toEqual(["8802-1108647 (it changed since)"]);
    expect(db.supplier_invoices.some((r) => r.invoice_number === "8802-1108647")).toBe(true);
    expect(db.supplier_invoices.some((r) => r.invoice_number === "8802-1108648")).toBe(false);
  });

  it("removes nothing it couldn't check for ties", async () => {
    const view = await viewNow();
    await applyOpenList("item-1", { fingerprint: view.plan!.fingerprint, wholeList: true });
    const applied = db.organized_items[0].proposal.openList.applied;
    const real = state.client;
    const failing = {
      from(table: string) {
        const q = real.from(table);
        if (table !== "organized_items") return q;
        const broken: any = { select: () => broken, eq: () => broken, in: () => broken, then: (res: any) => Promise.resolve({ data: null, error: { message: "read failed" } }).then(res) };
        return broken;
      },
    };
    const down = await undoOpenListCore(failing, "org-1", applied);
    expect(down.ok).toBe(false);
    expect(db.supplier_invoices.filter((r) => ["8802-1108647", "8802-1108648", "8802-1108649"].includes(r.invoice_number))).toHaveLength(3);
  });
});

describe("whose list it is, by its papers", () => {
  const acct = [{ id: "a", name: "A", account_number: null, on_account: true }, { id: "b", name: "B", account_number: null, on_account: true }];
  const paper = (n: string, owner: string) => ({
    id: n, invoiceNumber: n, kind: "invoice", invoiceDate: "2026-09-01", dueDate: null, total: 1, openBalance: 1, closed: false,
    discountAmount: null, discountBy: null, jobNameRaw: null, supplierAccountId: owner,
  });
  const listOf = (refs: string[]) => ({ accountId: null, accountFrom: null, accountNumber: null, rows: refs.map((reference) => ({ reference, kind: "invoice" as const })) }) as any;

  it("never decides it from one short number two stores could both print", () => {
    expect(resolveAccount(listOf(["INV-1001", "2002", "3003"]), null, acct, [paper("1001", "a")])).toBeNull();
    expect(resolveAccount(listOf(["1001", "1002"]), null, acct, [paper("1001", "a"), paper("1002", "a")])).toBeNull();
  });

  it("decides it when most of the list is long numbers already on one account", () => {
    const papers = [paper("8802-1000001", "a"), paper("8802-1000002", "a")];
    expect(resolveAccount(listOf(["8802-1000001", "8802-1000002", "8802-1000003"]), null, acct, papers)).toEqual({ id: "a", from: "papers" });
    // One hit is not enough, and neither is a minority of the list.
    expect(resolveAccount(listOf(["8802-1000001", "8802-9999998"]), null, acct, papers.slice(0, 1))).toBeNull();
    expect(resolveAccount(listOf(["8802-1000001", "8802-1000002", "8802-7", "8802-8", "8802-9"].map((x, i) => (i > 1 ? `8802-900000${i}` : x))), null, acct, papers)).toBeNull();
  });
});

describe("a short list", () => {
  it("adds and corrects what it lists and marks nothing paid when its own total says papers are missing", async () => {
    const short = cedList();
    const stored: StoredOpenList = { list: { ...short, printedTotal: 9999.99 }, needs: null };
    seed(stored);
    const view = await viewNow();
    expect(view.plan!.complete).toMatchObject({ ok: false, overridable: false });
    expect(view.plan!.close).toEqual([]);
    expect(view.plan!.keepPartial).toHaveLength(16);
    const res = await applyOpenList("item-1", { fingerprint: view.plan!.fingerprint, wholeList: true });
    expect(res.ok).toBe(true);
    expect(db.supplier_invoices.filter((r) => r.org_id === "org-1" && r.closed)).toHaveLength(0);
    expect(db.supplier_invoices.filter((r) => ["8802-1108647", "8802-1108648", "8802-1108649"].includes(r.invoice_number))).toHaveLength(3);
  });
});

describe("a company with more papers than one read returns", () => {
  it("finds a listed paper past the first thousand, and doesn't add it again", async () => {
    for (let i = 0; i < 1200; i++) {
      db.supplier_invoices.unshift({
        id: `old-${String(i).padStart(4, "0")}`, org_id: "org-1", supplier_account_id: "acct-1", invoice_number: `7700-${1000000 + i}`, kind: "invoice",
        invoice_date: "2025-01-01", total: 1, open_balance: 0, closed: true,
      });
    }
    const view = await viewNow();
    expect(view.plan!.add.map((a) => a.number)).toEqual(["8802-1108647", "8802-1108648", "8802-1108649"]);
    expect(view.plan!.close).toHaveLength(16);
  });
});

describe("the doors", () => {
  it("a dropped CSV becomes one waiting row, once", async () => {
    db.organized_items = [];
    const table = parseCSV(CED_OPEN_CSV);
    const sha = "a".repeat(64);
    const added = await addOpenList({ name: "Open.csv", sha256: sha, table, listDate: "2026-09-26", source: "bills_drop" });
    expect(added).toMatchObject({ ok: true });
    expect(added.line).toContain("11 open papers");
    const row = db.organized_items[0];
    expect(row).toMatchObject({ org_id: "org-1", doc_type: "statement", status: "needs_review", content_sha256: sha, source: "bills_drop" });
    expect(row.proposal.openList.list.rows).toHaveLength(11);
    expect(row.proposal.openList.list.listDate).toBe("2026-09-26");
    const again = await addOpenList({ name: "Open.csv", sha256: sha, table, listDate: "2026-09-26" });
    expect(again.ok).toBe(false);
    expect(db.organized_items).toHaveLength(1);
  });

  it("a date from the future is a wrong clock: the list speaks for today", async () => {
    db.organized_items = [];
    await addOpenList({ name: "Open.csv", table: parseCSV(CED_OPEN_CSV), listDate: "2099-01-01" });
    expect(db.organized_items[0].proposal.openList.list.listDateFrom).toBe("today");
  });

  it("asks for the columns once, and remembers them on the supplier's account", async () => {
    db.organized_items = [];
    const odd = parseCSV(`Doc Ref Code,Acct,When,Still Owing\nQ-1001,AC-10427,09/01/26,10.00\nQ-1002,AC-10427,09/05/26,20.00\n`);
    const added = await addOpenList({ name: "odd.csv", table: odd, listDate: "2026-09-26" });
    expect(added.ok).toBe(true);
    const id = db.organized_items[0].id;
    expect(db.organized_items[0].proposal.openList.needs.missing).toEqual(["reference", "openBalance"]);
    const firstNeeds = structuredClone(db.organized_items[0].proposal.openList.needs);
    const picked = await pickOpenListColumns(id, { reference: 0, account: 1, invoiceDate: 2, openBalance: 3 });
    expect(picked.ok).toBe(true);
    expect(picked.message).toContain("remembered for Consolidated Electrical Distributors");
    expect(db.supplier_accounts[0].open_list_columns.byHeader).toEqual({ reference: "Doc Ref Code", account: "Acct", invoiceDate: "When", openBalance: "Still Owing" });
    expect(db.supplier_accounts[1].open_list_columns).toBeUndefined();

    // Next month's list from them reads with no question.
    db.organized_items[0].status = "archived";
    db.organized_items.push({ id: "item-2", org_id: "org-1", status: "needs_review", proposal: { openList: { list: null, needs: firstNeeds } } });
    const views = await openListViews(state.client, "org-1", db.organized_items as any[]);
    expect(views["item-2"].needs).toBeNull();
    expect(views["item-2"].plan).not.toBeNull();
    // The columns came from memory; whose list it is came from the account number it prints.
    expect(views["item-2"].accountFrom).toBe("number");
  });

  /**
   * THE READ REPORT A PDF IS OWED ON THE ONE PATH THAT NEVER SAID IT (2026-10-02, the skeptic's pass).
   *
   * The report was built inside addOpenList from the reader's own figures, so a PDF whose columns went
   * to the picker — a statement printing both "Balance" and "Open Amount", say — said nothing at all
   * about its pages, and by the time a person had pointed at the columns the pages were forgotten. The
   * Reconcile page promises, for every PDF, "the line under it says how many pages and how many rows
   * came off it and what they add to". That promise was broken exactly where the parse is least verified.
   */
  it("a PDF whose columns go to the picker says its pages now, and the rest once they are picked", async () => {
    db.organized_items = [];
    const odd = parseCSV(`Doc Ref Code,Acct,When,Still Owing\nQ-1001,AC-10427,09/01/26,10.00\nQ-1002,AC-10427,09/05/26,20.00\n`);
    const added = await addOpenList({ name: "statement.pdf", table: odd, listDate: "2026-09-26", pdf: { pages: 2, rows: 37 } });
    expect(added.ok).toBe(true);
    expect(added.line).toContain("columns need a look");
    expect(added.line).toContain("2 pages, 37 rows on them");
    const needs = db.organized_items[0].proposal.openList.needs;
    expect(needs.pdf).toEqual({ pages: 2, rows: 37 });

    const picked = await pickOpenListColumns(db.organized_items[0].id, { reference: 0, account: 1, invoiceDate: 2, openBalance: 3 });
    expect(picked.ok).toBe(true);
    expect(picked.message).toContain("Read 2 papers.");
    expect(picked.message).toContain("2 pages, 37 rows on them, 2 papers");
    expect(picked.message).toContain("$30.00");
    expect(picked.message).toContain("the TOTAL DUE your statement prints");
  });

  it("a list that did not come off a PDF says nothing about pages, at either step", async () => {
    db.organized_items = [];
    const odd = parseCSV(`Doc Ref Code,Acct,When,Still Owing\nQ-1001,AC-10427,09/01/26,10.00\nQ-1002,AC-10427,09/05/26,20.00\n`);
    const added = await addOpenList({ name: "odd.csv", table: odd, listDate: "2026-09-26" });
    expect(added.line).not.toContain("Read off the PDF");
    const picked = await pickOpenListColumns(db.organized_items[0].id, { reference: 0, account: 1, invoiceDate: 2, openBalance: 3 });
    expect(picked.message).not.toContain("Read off the PDF");
  });

  it("a remembered column layout reads a list, but never decides whose list it is", async () => {
    db.organized_items = [];
    // CED's columns were remembered for a headerless 3-column list.
    db.supplier_accounts[0].open_list_columns = { byIndex: { reference: 0, invoiceDate: 1, openBalance: 2 }, width: 3 };
    db.supplier_accounts.push({ id: "acct-2", org_id: "org-1", name: "Tahoe Lumber", account_number: "55-0192", on_account: true });
    // A new supplier's headerless list of the same width: nothing on it names an account.
    const table = parseCSV(`L-20417,09/01/26,212.40\nL-20455,09/02/26,88.15\n`);
    await addOpenList({ name: "yard.csv", table, listDate: "2026-09-26" });
    const view = (await openListViews(state.client, "org-1", db.organized_items as any[]))[db.organized_items[0].id];
    expect(view.needs).toBeNull();
    expect(view.plan).toBeNull();
    expect(view.accountId).toBeNull();
    expect(view.suggestedAccountId).toBeNull();
    // Apply refuses until a person says whose it is: CED's papers are never closed by it.
    const res = await applyOpenList(db.organized_items[0].id, { fingerprint: "x", wholeList: true });
    expect(res).toMatchObject({ ok: false, error: "Pick whose list this is first." });
    expect(db.supplier_invoices.filter((r) => r.closed)).toHaveLength(0);
  });

  it("remembered header words only suggest their supplier in Whose List Is This", async () => {
    db.organized_items = [];
    db.supplier_accounts.push({
      id: "acct-2", org_id: "org-1", name: "Tahoe Lumber", account_number: "55-0192", on_account: true,
      open_list_columns: { byHeader: { reference: "Doc Ref Code", openBalance: "Still Owing" }, byIndex: { reference: 0, openBalance: 1 }, width: 2 },
    });
    await addOpenList({ name: "yard.csv", table: parseCSV(`Doc Ref Code,Still Owing\nL-20417,212.40\nL-20455,88.15\n`), listDate: "2026-09-26" });
    const view = (await openListViews(state.client, "org-1", db.organized_items as any[]))[db.organized_items[0].id];
    expect(view.plan).toBeNull();
    expect(view.suggestedAccountId).toBe("acct-2");
  });

  it("a statement PDF dropped anywhere is recognised from its own text, with no model", async () => {
    db.organized_items = [];
    const text = `STATEMENT\nACCOUNT\nAC-10427\nDATE\n09/25/26\nPAGE\n1 of 1\nDATE\n09-17-26\n09-22-26\nCODE\nINV\nCRM\nREFERENCE\n8802-1108330\n8802-1108540\nAMOUNT\n653.25\n-82.10\nTOTAL DUE\n$571.15\n`;
    const res = await addPaperwork({ path: "org-1/organize/1-statement.pdf", name: "statement.pdf", mime: "application/pdf", size: 1000, sha256: "b".repeat(64), source: "organize", pdfText: text });
    expect(res).toMatchObject({ ok: true, needsRead: false });
    const row = db.organized_items[0];
    expect(row).toMatchObject({ doc_type: "statement", file_url: "org-1/organize/1-statement.pdf", source: "organize" });
    expect(row.proposal.openList.list).toMatchObject({ from: "statement", listDate: "2026-09-25", accountNumber: "AC-10427", printedTotal: 571.15 });
    const view = (await openListViews(state.client, "org-1", db.organized_items as any[]))[row.id];
    expect(view.plan!.complete.ok).toBe(true);
    // Everything on the account dated on or before 9/25 that the statement doesn't list is marked paid.
    expect(view.plan!.close).toHaveLength(22);
    expect(view.plan!.headline).toMatch(/^Consolidated Electrical Distributors' statement of Sep 25: 22 papers marked paid/);
  });

  it("a scanned statement the reader transcribed becomes the same card", () => {
    const f = readerFields(
      { paper_type: "statement", vendor: "Tahoe Lumber", statement: { date: "2026-09-20", total_due: 300.55, lines: [{ reference: "L-20417", open_balance: 212.4 }, { reference: "L-20455", open_balance: 88.15 }] } },
      "scan.jpg",
    );
    expect(f.doc_type).toBe("statement");
    expect(f.proposal.openList?.list?.rows.map((r) => r.reference)).toEqual(["L-20417", "L-20455"]);
    expect(f.proposal.openList?.list?.from).toBe("reader");
  });

  it("the paste box sends a pasted open list to Needs You instead of refusing it", async () => {
    db.organized_items = [];
    const tsv = parseCSV(CED_OPEN_CSV).map((r) => r.join("\t")).join("\n");
    const res = await importCedInvoices({ text: tsv });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("waiting under Needs You on Bills");
    expect(db.organized_items).toHaveLength(1);
    expect(db.organized_items[0].proposal.openList.list.rows).toHaveLength(11);
    // No supplier paper was touched by the paste itself.
    expect(db.supplier_invoices.filter((r) => r.closed)).toHaveLength(0);
  });
});
