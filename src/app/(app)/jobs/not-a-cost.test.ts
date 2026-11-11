import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * NOT A COST (the owner, 2026-11-10: "it's a quote from my supplier not a bill, everything is
 * closed"). A supplier's quote had been filed on a job as a Receipt, so Needs You asked for it to be
 * recorded months after the job was finished and paid, and its one door led to adding a cost nobody
 * spent. markPaperNotACost files the paper as Not a Cost through updateDocument, the pencil's own
 * write. Pinned without a database:
 *
 *   - the write is { category: "Not a Cost" } on that paper, in the caller's company, checked
 *     (.select("id")): a zero-row update is a refusal said in words;
 *   - it widens nobody's view: the word is on neither the crew's list nor the customer's, so the
 *     paper stays the office's alone, as the Receipt was (never "Other", which the crew is handed);
 *   - nothing else is written: the fake has no insert and no delete, so a bill, a tie or a removal
 *     would throw;
 *   - the row is a hint and the write reads again: a paper gone, re-filed, on the books by now, or
 *     whose ties can't be read is left as it is and said, each naming one thing to do;
 *   - a tech is refused before anything is read (the paper list refuses a tech the same way);
 *   - the pencil's own save (updateDocument) keeps the silent-write law too.
 */
const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const JOB = "1b1b1b1b-1111-4111-8111-111111111111";
const DOC = "2c2c2c2c-2222-4222-8222-222222222222";
const PATH = `${ORG}/${JOB}/supplier-quote.pdf`;

type Call = { table: string; verb: "select" | "update"; payload?: unknown; columns: string | null; eqs: [string, unknown][]; ors: string[] };

const s = vi.hoisted(() => ({
  staff: true,
  language: "en",
  doc: null as null | Record<string, unknown>,
  ties: [] as Record<string, unknown>[],
  tieError: null as null | { code: string; message: string },
  /** What the update answers with; null = the rows the fake itself finds (the paper, when the filters name it). */
  updated: null as null | { id: string }[],
  calls: [] as Call[],
  revalidated: [] as string[],
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => (s.staff ? { supabase: client(), userId: "user-office", orgId: ORG, role: "owner" } : { error: "This action is staff-only." })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn((p: string) => void s.revalidated.push(p)), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(), deleteCalendarItem: vi.fn() }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { markPaperNotACost, updateDocument } from "./actions";
import { NOT_A_COST_CATEGORY, isCostableCategory, isMoneyCategory } from "@/lib/job-photos";
import { TECH_DOCUMENT_CATEGORIES, documentsForViewer, isTechDocument } from "@/lib/tech-documents";
import { PORTAL_SHOWABLE_CATEGORIES, categoryIsShowable } from "@/lib/portal/doc-kinds";
import { paperRefusal } from "@/lib/portal/share-input";
import { RECEIPT_TIE_COLUMNS, tieReadFilters } from "@/lib/action-items/receipts-not-on-a-bill";

/** The session client, as far as these two actions use it. It has NO insert and NO delete: a bill, a
 *  tie or a removal written by this door would throw. The documents read applies its own filters, so
 *  the company the read names is tested as the query, not as a stub's answer; and an update that
 *  does not ask its rows back answers the way PostgREST does, with no rows at all (a 204), so a
 *  write that forgot .select("id") reads here as the nothing it would be told in production. */
function client() {
  return {
    from(table: string) {
      const call: Call = { table, verb: "select", columns: null, eqs: [], ors: [] };
      s.calls.push(call);
      const named = () => !!s.doc && call.eqs.every(([col, val]) => s.doc![col] === val);
      const answer = (): { data: unknown; error: unknown } => {
        if (table === "documents" && call.verb === "update") {
          const rows = s.updated ?? (named() ? [{ id: s.doc!.id }] : []);
          return { data: call.columns === null ? null : rows, error: null };
        }
        if (table === "documents") return { data: named() ? s.doc : null, error: null };
        if (table === "organized_items") return s.tieError ? { data: null, error: s.tieError } : { data: s.ties, error: null };
        if (table === "profiles") return { data: { language: s.language }, error: null };
        throw new Error(`unscripted table: ${table}`);
      };
      const chain: Record<string, unknown> = {
        select(columns?: string) {
          call.columns = columns ?? "*";
          return chain;
        },
        update(payload: unknown) {
          call.verb = "update";
          call.payload = payload;
          return chain;
        },
        eq(col: string, val: unknown) {
          call.eqs.push([col, val]);
          return chain;
        },
        or(expr: string) {
          call.ors.push(expr);
          return chain;
        },
        limit: () => chain,
        maybeSingle: async () => answer(),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(answer).then(ok, bad),
      };
      return chain;
    },
  };
}

const writes = () => s.calls.filter((c) => c.verb === "update");
const tie = (o: Record<string, unknown>) => ({ id: "tie-1", kind: "receipt", category: "Receipt", status: "filed", document_id: null, bill_id: null, tied_bill_id: null, tied_supplier_invoice_id: null, petty_cash_id: null, file_url: null, ...o });

const GONE = "That paper isn't there any more. Reload to see the list as it is.";
const CHANGED = "That paper changed a moment ago: it isn't waiting to be recorded any more. Reload to see it.";
const UNREAD = "Couldn't check whether that paper is on a bill just now, so it was left as it is. Try again.";

beforeEach(() => {
  s.staff = true;
  s.language = "en";
  // The live case: a supplier's quote (a PDF) filed on a job as a Receipt, with no bill behind it.
  s.doc = { id: DOC, org_id: ORG, job_id: JOB, name: "supplier-quote.pdf", category: "Receipt", file_url: PATH };
  s.ties = [];
  s.tieError = null;
  s.updated = null;
  s.calls = [];
  s.revalidated = [];
});

describe("Not a Cost: a paper filed as a Receipt that never was one", () => {
  it("files it as Not a Cost, on that paper, in the caller's company, and checks the write landed", async () => {
    expect(await markPaperNotACost(DOC)).toEqual({ ok: true });
    expect(writes()).toHaveLength(1);
    const w = writes()[0];
    expect(w.table).toBe("documents");
    // The category and nothing else: the name, the file and the job are not touched.
    expect(w.payload).toEqual({ category: "Not a Cost" });
    expect(w.eqs).toEqual(expect.arrayContaining([["id", DOC], ["org_id", ORG]]));
    // THE SILENT-WRITE LAW: the write asks its row back, and that answer is what "ok" stands on.
    expect(w.columns).toBe("id");
    // Every write this door makes is that one: no bill, no tie, no file (the fake would have thrown).
    expect(s.calls.filter((c) => c.table !== "documents" && c.verb !== "select")).toEqual([]);
  });

  it("the job comes from the row, never the caller: its page, Needs You and Bills are refreshed", async () => {
    await markPaperNotACost(DOC);
    expect(s.revalidated).toEqual(expect.arrayContaining([`/jobs/${JOB}`, "/planner", "/bills"]));
  });

  it("the read names the company and asks only what the feeder's rule reads", async () => {
    await markPaperNotACost(DOC);
    const read = s.calls.find((c) => c.table === "documents" && c.verb === "select")!;
    expect(read.eqs).toEqual([["id", DOC], ["org_id", ORG]]);
    expect(read.columns).toBe("id, name, category, file_url, job_id");
    // Another company's paper is not there, in words, and nothing is written.
    s.calls = [];
    s.doc = { ...s.doc!, org_id: "9f9f9f9f-9999-4999-8999-999999999999" };
    expect(await markPaperNotACost(DOC)).toEqual({ ok: false, error: GONE });
    expect(writes()).toEqual([]);
  });

  it("a Bill paper is re-filed too, and a reader's tie that accounts for nothing does not stand in the way", async () => {
    s.doc = { ...s.doc!, category: "Bill" };
    s.ties = [tie({ document_id: DOC })];
    expect(await markPaperNotACost(DOC)).toEqual({ ok: true });
    expect(writes()[0].payload).toEqual({ category: NOT_A_COST_CATEGORY });
  });

  it("the ties are asked the way the feeder asks them: by the paper and by its file", async () => {
    await markPaperNotACost(DOC);
    const ties = s.calls.find((c) => c.table === "organized_items")!;
    expect(ties.verb).toBe("select");
    expect(ties.columns).toBe(RECEIPT_TIE_COLUMNS);
    expect(ties.ors).toEqual(tieReadFilters([{ id: DOC, name: "supplier-quote.pdf", category: "Receipt", file_url: PATH, job_id: JOB }]));
    expect(ties.ors[0]).toBe(`document_id.in.("${DOC}"),file_url.in.("${PATH}")`);
    expect(RECEIPT_TIE_COLUMNS).toContain("status");
  });

  it("a zero-row write is a refusal said in words, never 'done': the row comes back and nothing is refreshed", async () => {
    s.updated = [];
    expect(await markPaperNotACost(DOC)).toEqual({ ok: false, error: GONE });
    expect(s.revalidated).toEqual([]);
  });

  it("a tech is refused before anything is read or written, as the paper list's pencil refuses one", async () => {
    s.staff = false;
    expect(await markPaperNotACost(DOC)).toEqual({ ok: false, error: "This action is staff-only." });
    expect(await updateDocument(DOC, { category: "Other" }, JOB)).toEqual({ ok: false, error: "This action is staff-only." });
    expect(s.calls).toEqual([]);
    expect(s.revalidated).toEqual([]);
  });

  it("a paper that is gone is said, and nothing is written", async () => {
    s.doc = null;
    expect(await markPaperNotACost(DOC)).toEqual({ ok: false, error: GONE });
    expect(writes()).toEqual([]);
    expect(s.calls.some((c) => c.table === "organized_items")).toBe(false);
  });

  it("the row is a hint: a paper somebody re-filed since keeps the category they gave it", async () => {
    // "Not a Cost" itself is among them: a second tap from a stale list writes nothing.
    for (const category of ["Plan", "Permit", "Photo", "Invoice", "Other", "Not a Cost", null]) {
      s.calls = [];
      s.doc = { ...s.doc!, category };
      expect(await markPaperNotACost(DOC), String(category)).toEqual({ ok: false, error: CHANGED });
      expect(writes(), String(category)).toEqual([]);
    }
    // A paper no longer on a job is no row either.
    s.calls = [];
    s.doc = { ...s.doc!, category: "Receipt", job_id: null };
    expect(await markPaperNotACost(DOC)).toEqual({ ok: false, error: CHANGED });
    expect(writes()).toEqual([]);
  });

  it("…and one the books account for by now IS a cost: it is left as it is, whichever way it is tied", async () => {
    const accounted = [
      tie({ document_id: DOC, bill_id: "bill-1" }), // Record as Cost made its bill
      tie({ file_url: PATH, tied_bill_id: "bill-2" }), // Same Purchase: Tie Them, by the file alone
      tie({ document_id: DOC, tied_supplier_invoice_id: "si-1" }), // a supplier's own document
      tie({ document_id: DOC, petty_cash_id: "pc-1" }), // petty cash
      tie({ document_id: DOC, status: "needs_review" }), // waiting in the tray: that row answers it
    ];
    for (const t of accounted) {
      s.calls = [];
      s.ties = [t];
      expect(await markPaperNotACost(DOC), JSON.stringify(t)).toEqual({ ok: false, error: CHANGED });
      expect(writes(), JSON.stringify(t)).toEqual([]);
    }
    expect(s.revalidated).toEqual([]);
  });

  it("ties that can't be read claim nothing: nothing is changed, and it says to try again", async () => {
    s.tieError = { code: "57014", message: "canceling statement due to statement timeout" };
    expect(await markPaperNotACost(DOC)).toEqual({ ok: false, error: UNREAD });
    expect(writes()).toEqual([]);
  });

  it("a Spanish-speaking office reads each refusal in Spanish", async () => {
    s.language = "es";
    s.doc = { ...s.doc!, category: "Plan" };
    expect(await markPaperNotACost(DOC)).toEqual({ ok: false, error: "Ese papel cambió hace un momento: ya no está pendiente de registrar. Recarga para verlo." });
    s.doc = { ...s.doc!, category: "Receipt" };
    s.tieError = { code: "57014", message: "timeout" };
    expect(await markPaperNotACost(DOC)).toEqual({ ok: false, error: "No se pudo revisar si ese papel está en una cuenta ahora, así que se dejó como está. Inténtalo de nuevo." });
    s.tieError = null;
    s.updated = [];
    expect(await markPaperNotACost(DOC)).toEqual({ ok: false, error: "Ese papel ya no está. Recarga para ver la lista como está." });
  });

  it("no language is read on the way through: the words are asked only when a refusal is said", async () => {
    await markPaperNotACost(DOC);
    expect(s.calls.some((c) => c.table === "profiles")).toBe(false);
  });
});

describe("the pencil's own save keeps the silent-write law (updateDocument)", () => {
  it("a paper deleted meanwhile is said, where it used to answer 'saved' over nothing", async () => {
    s.updated = [];
    expect(await updateDocument(DOC, { name: "Quote from the supplier", category: "Plan" }, JOB)).toEqual({ ok: false, error: GONE });
    expect(s.revalidated).toEqual([]);
  });

  it("a save that lands is ok, names the company, trims the name and refreshes the job", async () => {
    expect(await updateDocument(DOC, { name: "  Quote from the supplier ", category: "Plan" }, JOB)).toEqual({ ok: true });
    expect(writes()[0].payload).toEqual({ name: "Quote from the supplier", category: "Plan" });
    expect(writes()[0].eqs).toEqual([["id", DOC], ["org_id", ORG]]);
    expect(s.revalidated).toEqual([`/jobs/${JOB}`]);
  });

  it("a blank name is refused before any write, and a patch that asks for nothing writes nothing", async () => {
    expect(await updateDocument(DOC, { name: "   " }, JOB)).toEqual({ ok: false, error: "Name is required." });
    expect(await updateDocument(DOC, {}, JOB)).toEqual({ ok: true });
    expect(writes()).toEqual([]);
  });
});

describe("the word it files the paper under", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("is its own stored value, Not a Cost: on the pencil's list for the office, and on neither the crew's list nor the customer's", () => {
    expect(NOT_A_COST_CATEGORY).toBe("Not a Cost");
    // Not costable (Receipt and Bill alone are), and not money paper either: it made no bill.
    expect(isCostableCategory(NOT_A_COST_CATEGORY)).toBe(false);
    expect(["Receipt", "Bill"].every(isCostableCategory)).toBe(true);
    expect(isMoneyCategory(NOT_A_COST_CATEGORY)).toBe(false);
    // The office sees the paper under that name and can re-file it: the pencil's choices hold it.
    expect(src("src/app/(app)/jobs/[id]/job-documents.tsx")).toContain('const CATEGORIES = ["Receipt", "Bill", "Invoice", NOT_A_COST_CATEGORY, "Photo", "Plan", "Permit", "Other"];');
    // IT WIDENS NOBODY'S VIEW. The crew's list names what it lets through, and this is not on it:
    // a tech is handed the paper no more than he was handed the Receipt it was.
    const paper = { id: DOC, name: "supplier-quote.pdf", file_url: PATH };
    expect(isTechDocument({ category: NOT_A_COST_CATEGORY })).toBe(false);
    expect(TECH_DOCUMENT_CATEGORIES as readonly string[]).not.toContain(NOT_A_COST_CATEGORY);
    for (const category of ["Receipt", NOT_A_COST_CATEGORY]) {
      expect(documentsForViewer([{ ...paper, category }], false), category).toEqual([]);
      expect(documentsForViewer([{ ...paper, category }], true), category).toHaveLength(1);
    }
    // ("Other" is what the crew IS handed, which is why the door never files a paper under it.)
    expect(documentsForViewer([{ ...paper, category: "Other" }], false)).toHaveLength(1);
    // Nor is it the customer's: not showable, and refused in words if the office tries.
    expect(categoryIsShowable(NOT_A_COST_CATEGORY)).toBe(false);
    expect(PORTAL_SHOWABLE_CATEGORIES as readonly string[]).not.toContain(NOT_A_COST_CATEGORY);
    expect(paperRefusal({ category: NOT_A_COST_CATEGORY, file_url: PATH, job_id: JOB }, ORG)).toBe(
      "Only a photo, a plan, a permit or another job paper can be shown to the customer, not a Not a Cost.",
    );
    // File a Paper (Not a Cost)'s Other Paper is a person choosing Other on purpose: left as it was.
    expect(src("src/app/(app)/jobs/[id]/job-cost-capture.tsx")).toContain('{ category: "Other", label: "Other Paper" }');
  });

  it("the column takes the word: documents.category is free text, and no migration lists its allowed values", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(300);
    // 0013 added it as plain text, and nothing since has put a CHECK on the documents table.
    expect(src("supabase/migrations/0013_job_documents.sql")).toMatch(/alter table public\.documents\s+add column if not exists category text,/);
    const checked = files.filter((f) => /alter table[^;]*\bdocuments\b[^;]*\bcheck\s*\(/i.test(readFileSync(join(dir, f), "utf8")));
    expect(checked).toEqual([]);
    // The one rule the database keeps on the word is the customer's allow-list (0326), and it leaves this out.
    expect(src("supabase/migrations/0326_the_customer_sees_the_latest_drawing.sql")).toContain("select coalesce(p_category in ('Photo', 'Plan', 'Permit', 'Other'), false)");
  });

  it("the door runs the pencil's write and the feeder's rule, never a copy of either, and removes nothing", () => {
    const actions = src("src/app/(app)/jobs/actions.ts");
    const door = actions.slice(actions.indexOf("export async function markPaperNotACost"), actions.indexOf("export async function deleteDocument"));
    expect(door).toContain("const ctx = await requireStaff();");
    expect(door).toContain("updateDocument(paper.id, { category: NOT_A_COST_CATEGORY }, paper.job_id)");
    expect(door).toContain("receiptsNotOnABill([paper]");
    expect(door).not.toMatch(/\.(insert|delete|upsert|update)\(/);
    expect(door).not.toContain("storage");
    // The pencil's write asks its row back.
    const pencil = actions.slice(actions.indexOf("export async function updateDocument"), actions.indexOf("export async function markPaperNotACost"));
    expect(pencil).toContain('await write.select("id")');
    expect(pencil).toContain("if (!saved?.length) return { ok: false");
  });

  it("the row door reaches it through the registry, and the assistant is not offered it", () => {
    expect(src("src/lib/actions/entities/document.ts")).toContain("handler: (i) => markPaperNotACost(i.id),");
    expect(src("src/lib/action-items/dispatch-map.ts")).toContain('{ name: "document.notACost", input: { id: doc } }');
    expect(src("src/lib/actions/agent-tools.ts")).not.toContain("document.notACost");
  });
});
