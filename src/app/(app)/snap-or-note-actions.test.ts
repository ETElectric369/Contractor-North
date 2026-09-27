import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TIMBER_CREEK } from "@/test/ced-timber-creek";

/**
 * SNAP OR NOTE'S SERVER HALF (W1-30), and the one note writer's read. What these pin: pasted supplier
 * text is imported instead of kept as a note; a plain note stays a note; a tech's context carries job
 * LABELS and no price; and an office note is saved first, so a read that fails leaves it saved.
 */

const state = vi.hoisted(() => ({ client: null as any, member: null as any, staff: null as any, aiThrows: false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => state.staff),
  requireMember: vi.fn(async () => state.member),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));
vi.mock("@/lib/anthropic", () => ({
  DEFAULT_MODEL: "test-model",
  getAnthropic: () => ({
    messages: {
      create: async () => {
        if (state.aiThrows) throw new Error("model unreachable");
        return { model: "test-model", content: [{ type: "text", text: "{}" }], usage: {} };
      },
    },
  }),
}));
vi.mock("@/lib/ai-json", () => ({ parseAiJson: async () => ({ action: "keep_note", reason: "Reference." }) }));
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: async () => {}, modelFor: () => "test-model" }));
const imports = vi.hoisted(() => ({ importCedInvoices: vi.fn() }));
vi.mock("@/app/(app)/bills/supplier-import-actions", () => imports);

import { routePastedText, snapContext } from "./snap-or-note-actions";
import { saveVoiceNote } from "./organize/actions";

type Call = { table: string; verb: string; payload?: any; selected?: boolean; eqs: [string, unknown][]; cols?: string };
let calls: Call[];

/** A scriptable PostgREST fake that records every write, .eq() and select list. */
function fake(script: Record<string, any[]>) {
  const next = (key: string) => {
    const q = script[key];
    if (!q?.length) return { data: [], error: null };
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      let verb = "select";
      const mine: Call = { table, verb, eqs: [] };
      calls.push(mine);
      const chain: any = {
        insert(payload: any) { verb = "insert"; mine.verb = verb; mine.payload = payload; return chain; },
        update(payload: any) { verb = "update"; mine.verb = verb; mine.payload = payload; return chain; },
        select(cols?: string) { if (verb === "select") mine.cols = cols; else mine.selected = true; return chain; },
        eq(col: string, val: unknown) { mine.eqs.push([col, val]); return chain; },
        in() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        not() { return chain; },
        maybeSingle: () => Promise.resolve(next(`${table}.${verb}`)),
        single: () => Promise.resolve(next(`${table}.${verb}`)),
        then(resolve: any, reject: any) {
          try { resolve(next(`${table}.${verb}`)); } catch (e) { reject?.(e); }
        },
      };
      return chain;
    },
  };
}

beforeEach(() => {
  calls = [];
  state.aiThrows = false;
  imports.importCedInvoices.mockReset();
});

describe("routePastedText: pasted supplier text is imported, not kept as a note", () => {
  beforeEach(() => {
    state.staff = { supabase: fake({}), userId: "user-1", orgId: "org-1" };
  });

  it("a supplier invoice pasted into the note box goes to the importer, and the line says what came in", async () => {
    imports.importCedInvoices.mockResolvedValue({
      ok: true,
      message: "Read 1 document. 1 document is new. The new ones come to $162.45.",
      landed: [{ invoiceNumber: "8802-1101363" }],
      updated: [],
      unchanged: [],
      refused: [],
    });
    const res = await routePastedText(TIMBER_CREEK);
    expect(imports.importCedInvoices).toHaveBeenCalledWith({ text: TIMBER_CREEK.trim() });
    expect(res).toEqual({
      kind: "imported",
      ok: true,
      line: "Imported 1 supplier invoice from the pasted text: Read 1 document. 1 document is new. The new ones come to $162.45.",
    });
  });

  it("an import that refuses says so, and nothing is saved as a note", async () => {
    imports.importCedInvoices.mockResolvedValue({ ok: false, error: "Nothing could be read. 8802-1101363: the lines don't add up", landed: [], updated: [], unchanged: [], refused: [] });
    const res = await routePastedText(TIMBER_CREEK);
    expect(res).toEqual({ kind: "imported", ok: false, line: "Not imported: Nothing could be read. 8802-1101363: the lines don't add up" });
  });

  it("a supplier's open list pasted as a table is imported too (the importer puts it in Sort These)", async () => {
    imports.importCedInvoices.mockResolvedValue({ ok: true, message: "Pasted list is a supplier's open list, not invoices: it is waiting in Sort These.", landed: [], updated: [], unchanged: [], refused: [] });
    const table = "Invoice #,Invoice Date,Open Balance\n8802-1101363,06/15/2026,162.45\n8802-1103059,07/02/2026,80.00";
    const res = await routePastedText(table);
    expect(imports.importCedInvoices).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ kind: "imported", ok: true, line: "From the pasted text: Pasted list is a supplier's open list, not invoices: it is waiting in Sort These." });
  });

  it("a plain note, even one naming an invoice number, stays a note and never reaches the importer", async () => {
    for (const note of ["call the inspector Tuesday", "ask CED about invoice 8802-1101363, it looks high"]) {
      expect(await routePastedText(note)).toEqual({ kind: "note" });
    }
    expect(imports.importCedInvoices).not.toHaveBeenCalled();
  });

  it("a crew member's text is never routed (the importer is the office's): it is a note", async () => {
    state.staff = { error: "This action is staff-only." };
    expect(await routePastedText(TIMBER_CREEK)).toEqual({ kind: "note" });
    expect(imports.importCedInvoices).not.toHaveBeenCalled();
  });
});

describe("snapContext: who is asking, and a tech's jobs as labels only", () => {
  const JOB_ROWS = [
    { id: "j-2", job_number: "J-002", name: "Smith Panel", address: "1 Main St", status: "scheduled", created_at: "2026-09-20", customers: { name: "Ann Smith" } },
    { id: "j-7", job_number: "J-007", name: "13897 Herringbone", address: "13897 Herringbone Way", status: "in_progress", created_at: "2026-09-10", customers: { name: "Bo Lee" } },
    { id: "j-9", job_number: "J-009", name: "Lake House", address: "9 Shore Rd", status: "scheduled", created_at: "2026-09-01", customers: null },
  ];

  it("a tech gets his open punch's job first, then the jobs going, each a label and nothing that costs money", async () => {
    const client = fake({
      "organizations.select": [{ data: { settings: { timeclock_job_codes: true } }, error: null }],
      "time_entries.select": [{ data: { job_id: "j-9" }, error: null }],
      "jobs.select": [{ data: JOB_ROWS, error: null }],
    });
    state.member = { supabase: client, userId: "tech-1", orgId: "org-1", staff: false, name: "Sam" };
    const ctx = await snapContext();
    expect(ctx).toEqual({
      ok: true,
      orgId: "org-1",
      staff: false,
      punchJobId: "j-9",
      jobs: [
        { id: "j-9", label: "Lake House" },
        { id: "j-7", label: "13897 Herringbone" },
        { id: "j-2", label: "Smith Panel" },
      ],
      shopStock: true,
    });
    // Every read names the company, and the job read asks for no money column.
    for (const c of calls) expect(c.eqs.some(([col, v]) => (col === "org_id" || col === "id") && v === "org-1")).toBe(true);
    const jobs = calls.find((c) => c.table === "jobs")!;
    expect(jobs.cols).not.toMatch(/amount|total|price|cost|budget|rate/i);
    expect(JSON.stringify(ctx)).not.toMatch(/\$|amount|total/i);
  });

  it("the office gets no job list here (its cards carry their own), and a lost jobs read is said, never an empty 'no jobs'", async () => {
    state.member = {
      supabase: fake({ "organizations.select": [{ data: { settings: {} }, error: null }], "time_entries.select": [{ data: null, error: null }] }),
      userId: "u",
      orgId: "org-1",
      staff: true,
      name: "Erik",
    };
    expect(await snapContext()).toEqual({ ok: true, orgId: "org-1", staff: true, punchJobId: null, jobs: [], shopStock: true });
    state.member = {
      supabase: fake({
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "time_entries.select": [{ data: null, error: null }],
        "jobs.select": [{ data: null, error: { code: "57014", message: "timeout" } }],
      }),
      userId: "t",
      orgId: "org-1",
      staff: false,
      name: "Sam",
    };
    const lost = await snapContext();
    expect(lost).toMatchObject({ ok: true, staff: false, jobs: [], jobsError: "Couldn't load the jobs just now. Check your signal and open Snap Or Note again." });
  });

  it("no seat, no door: the refusal is said", async () => {
    state.member = { error: "This account has been deactivated." };
    expect(await snapContext()).toEqual({ ok: false, error: "This account has been deactivated." });
  });
});

describe("saveVoiceNote: the one note writer, and its read for the office", () => {
  it("saves the note FIRST, with .select('id'), and a read that fails leaves it saved and says Not Read", async () => {
    state.aiThrows = true;
    state.client = fake({
      "organized_items.insert": [{ data: [{ id: "note-1" }], error: null }],
      "organized_items.select": [{ data: { id: "note-1", kind: "note", status: "needs_review", title: "call the inspector", summary: "call the inspector", org_id: "org-1", proposal: null }, error: null }],
      "jobs.select": [{ data: [], error: null }],
    });
    state.staff = { supabase: state.client, userId: "user-1", orgId: "org-1" };
    const res = await saveVoiceNote("call the inspector", { read: true });
    expect(res).toEqual({ ok: true, id: "note-1", read: false });
    const ins = calls.find((c) => c.table === "organized_items" && c.verb === "insert")!;
    expect(ins.selected).toBe(true);
    expect(ins.payload).toMatchObject({ kind: "note", summary: "call the inspector", status: "needs_review", created_by: "user-1" });
  });

  it("a read that answers says so; no read asked (Nort, a tech) reads nothing", async () => {
    state.client = fake({
      "organized_items.insert": [{ data: [{ id: "note-2" }], error: null }, { data: [{ id: "note-3" }], error: null }],
      "organized_items.select": [{ data: { id: "note-2", kind: "note", status: "needs_review", title: "x", summary: "x", org_id: "org-1", proposal: null }, error: null }],
      "jobs.select": [{ data: [], error: null }],
      "organized_items.update": [{ data: [{ id: "note-2" }], error: null }],
    });
    state.staff = { supabase: state.client, userId: "user-1", orgId: "org-1" };
    expect(await saveVoiceNote("x", { read: true })).toEqual({ ok: true, id: "note-2", read: true });
    calls = [];
    expect(await saveVoiceNote("y")).toEqual({ ok: true, id: "note-3" });
    expect(calls.map((c) => `${c.table}.${c.verb}`)).toEqual(["organized_items.insert"]);
  });

  it("an insert that comes back with no row did not land, and says so (the silent-write law)", async () => {
    state.client = fake({ "organized_items.insert": [{ data: [], error: null }] });
    const res = await saveVoiceNote("lost words", { read: true });
    expect(res).toEqual({ ok: false, error: "The note didn't save, so nothing was kept. Try again." });
  });

  it("Nort's organize.saveNote still calls it with no read", () => {
    const entity = readFileSync(join(process.cwd(), "src/lib/actions/entities/organize.ts"), "utf8");
    expect(entity).toContain("handler: (i) => saveVoiceNote(i.text),");
  });
});
