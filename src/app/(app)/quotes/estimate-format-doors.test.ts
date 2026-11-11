import { describe, it, expect, vi, beforeEach } from "vitest";
import { ESTIMATE_FORMATS, type EstimateFormat } from "@/lib/doc-style";

/**
 * THE ESTIMATE'S OWN PAPER FORMAT, THROUGH ITS THREE SERVER DOORS (cn-v1131, 0395), driven against a
 * recording fake client:
 *
 *   saveQuote        an insert carries the format in the row; an update writes it as ONE statement
 *                    after the draft RPC, on a DRAFT only, read back (the silent-write law) — zero rows
 *                    is a refusal in words; omitted = the column is not touched.
 *   updateQuoteMeta  the saved page's pill: a word the paper knows is written as it is, anything else is
 *                    "the company's" (null); a zero-row write is said.
 *   duplicateQuote   a copy or a Revise keeps the format (it used to come back on the company default);
 *                    before 0395 lands (no column) the copy is made as before, with none of its own.
 *
 * THREE WORDS SINCE cn-v1158 (0408): 'grouped' — One Materials Line — joins 'tasks' and 'detailed'. Each
 * door asks the one check (lib/doc-style isEstimateFormat) where it used to hold its own pair of words,
 * and a pair would have written a grouped estimate back as "the company's" without a word: a first save
 * dropping the choice, the pill snapping to Company Default, a Revise printing every part again. The
 * cases marked cn-v1158 drive the third word through every door, and the last one drives EVERY word the
 * paper knows, so a fourth is held to the same doors the day it is added.
 */
type Call = { table: string; verb: "select" | "insert" | "update" | "delete" | "rpc"; payload?: unknown; select?: string; filters: unknown[][] };
const s = vi.hoisted(() => ({ calls: [] as Call[], answer: null as null | ((c: Call) => unknown) }));

function builder(table: string) {
  const c: Call = { table, verb: "select", filters: [] };
  const run = () => s.answer?.(c) ?? { data: null, error: null };
  const b: any = {
    select: (cols?: string) => ((c.select = cols), b),
    insert: (p: unknown) => ((c.verb = "insert"), (c.payload = p), b),
    update: (p: unknown) => ((c.verb = "update"), (c.payload = p), b),
    delete: () => ((c.verb = "delete"), b),
    maybeSingle: async () => (s.calls.push(c), run()),
    single: async () => (s.calls.push(c), run()),
    then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => (s.calls.push(c), Promise.resolve(run()).then(ok, err)),
  };
  for (const m of ["eq", "in", "is", "order", "limit", "neq"]) b[m] = (...a: unknown[]) => (c.filters.push([m, ...a]), b);
  return b;
}
const client = {
  from: (t: string) => builder(t),
  rpc: async (fn: string, args: unknown) => {
    const c: Call = { table: fn, verb: "rpc", payload: args, filters: [] };
    s.calls.push(c);
    return s.answer?.(c) ?? { data: null, error: null };
  },
  auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", async (importOriginal) => ({ ...(await importOriginal<object>()), bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));

const { saveQuote, updateQuoteMeta, duplicateQuote } = await import("./actions");

/** The reads every door makes on the way (recalcQuote, the previous lead pointer): answered plainly. */
const base = (c: Call): unknown => {
  if (c.table === "quotes" && c.verb === "select" && c.select === "tax_rate") return { data: { tax_rate: 0 }, error: null };
  // The one read before an update (cn-v1132): the row stands here as a draft, with no lead behind it.
  if (c.table === "quotes" && c.verb === "select" && c.select === "id, status, inquiry_id") return { data: { id: "q1", status: "draft", inquiry_id: null }, error: null };
  if (c.table === "quote_line_items" && c.verb === "select") return { data: [], error: null };
  if (c.table === "quote_line_items" && c.verb === "insert") return { data: null, error: null };
  if (c.table === "quotes" && c.verb === "insert") return { data: { id: "q-new", quote_number: "E-010" }, error: null };
  if (c.table === "quotes" && c.verb === "update") return { data: [{ id: "q1" }], error: null };
  if (c.verb === "rpc" && c.table === "save_quote_draft") return { data: [{ id: "q1", quote_number: "E-001" }], error: null };
  return { data: null, error: null };
};
const formatWrites = () => s.calls.filter((c) => c.table === "quotes" && c.verb === "update" && "estimate_format" in (c.payload as object));
const line = { description: "Trench", quantity: 1, unit: "ea", unit_price: 290 };
const header = { customer_id: null, job_id: null, title: "Larkspur panel", notes: "", tax_rate: 0, valid_until: null, items: [line] };

beforeEach(() => {
  s.calls = [];
  s.answer = base;
});

describe("saveQuote", () => {
  it("an INSERT carries the format in the row: a word as given, null for the company's, nothing when omitted", async () => {
    expect((await saveQuote({ ...header, estimate_format: "detailed" })).ok).toBe(true);
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).toMatchObject({ estimate_format: "detailed", title: "Larkspur panel" });
    s.calls = [];
    await saveQuote({ ...header, estimate_format: null });
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).toMatchObject({ estimate_format: null });
    s.calls = [];
    await saveQuote(header);
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).not.toHaveProperty("estimate_format");
    expect(formatWrites()).toEqual([]);
  });

  it("an UPDATE writes it as one statement after the draft RPC, on a draft only, read back", async () => {
    const res = await saveQuote({ ...header, id: "q1", estimate_format: "tasks" });
    expect(res.ok).toBe(true);
    const rpc = s.calls.findIndex((c) => c.verb === "rpc" && c.table === "save_quote_draft");
    const write = s.calls.findIndex((c) => c.table === "quotes" && c.verb === "update" && "estimate_format" in (c.payload as object));
    expect(rpc).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(rpc);
    expect(s.calls[write]).toMatchObject({ payload: { estimate_format: "tasks" }, select: "id", filters: [["eq", "id", "q1"], ["eq", "status", "draft"]] });
    // The RPC's own header never carries it (save_quote_draft, 0211, is not edited).
    expect((s.calls[rpc].payload as { p_fields: object }).p_fields).not.toHaveProperty("estimate_format");
  });

  it("cn-v1158 — One Materials Line: a FIRST SAVE carries 'grouped' in the row, and a later save writes it as the one statement after the draft RPC", async () => {
    expect((await saveQuote({ ...header, estimate_format: "grouped" })).ok).toBe(true);
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).toMatchObject({ estimate_format: "grouped", title: "Larkspur panel" });
    expect(formatWrites()).toEqual([]); // the insert IS the write: no second statement behind it
    s.calls = [];
    expect((await saveQuote({ ...header, id: "q1", estimate_format: "grouped" })).ok).toBe(true);
    expect(formatWrites()).toHaveLength(1);
    expect(formatWrites()[0]).toMatchObject({ payload: { estimate_format: "grouped" }, select: "id", filters: [["eq", "id", "q1"], ["eq", "status", "draft"]] });
    // A word the paper does not know is not written at all on a save (untouched), never stored as given.
    s.calls = [];
    expect((await saveQuote({ ...header, id: "q1", estimate_format: "itemized" as never })).ok).toBe(true);
    expect(formatWrites()).toEqual([]);
    s.calls = [];
    await saveQuote({ ...header, estimate_format: "itemized" as never });
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).not.toHaveProperty("estimate_format");
  });

  it("an UPDATE with the format omitted touches no column; zero rows on the write is a refusal in words; a database error is said", async () => {
    expect((await saveQuote({ ...header, id: "q1" })).ok).toBe(true);
    expect(formatWrites()).toEqual([]);
    s.answer = (c) => (c.table === "quotes" && c.verb === "update" && "estimate_format" in (c.payload as object) ? { data: [], error: null } : base(c));
    expect(await saveQuote({ ...header, id: "q1", estimate_format: "detailed" })).toEqual({ ok: false, error: "The paper format didn't land — reload the estimate and try again." });
    s.answer = (c) => (c.table === "quotes" && c.verb === "update" && "estimate_format" in (c.payload as object) ? { data: null, error: { code: "42703", message: "column quotes.estimate_format does not exist" } } : base(c));
    const refused = await saveQuote({ ...header, id: "q1", estimate_format: "detailed" });
    expect(refused.ok).toBe(false);
    // dbError's words for the database's refusal (a missing column reads as "mid-update"), never the zero-row line, never a bare ok.
    const words = String((refused as { error?: string }).error ?? "");
    expect(words.length).toBeGreaterThan(0);
    expect(words).not.toBe("The paper format didn't land — reload the estimate and try again.");
  });
});

describe("updateQuoteMeta", () => {
  it("writes a word the paper knows as given and anything else as the company's (null), read back", async () => {
    expect(await updateQuoteMeta("q1", { estimate_format: "detailed" })).toEqual({ ok: true });
    expect(formatWrites().map((c) => c.payload)).toEqual([{ estimate_format: "detailed" }]);
    s.calls = [];
    // cn-v1158 — the pill's One Materials Line: THE ONE HEADER WRITE, with the third word as given. The
    // inline pair this door held before would have written null here, and the pill would have snapped back.
    expect(await updateQuoteMeta("q1", { estimate_format: "grouped" })).toEqual({ ok: true });
    expect(formatWrites().map((c) => c.payload)).toEqual([{ estimate_format: "grouped" }]);
    expect(formatWrites()[0]).toMatchObject({ select: "id", filters: [["eq", "id", "q1"]] });
    s.calls = [];
    expect(await updateQuoteMeta("q1", { estimate_format: null })).toEqual({ ok: true });
    expect(formatWrites().map((c) => c.payload)).toEqual([{ estimate_format: null }]);
    s.calls = [];
    expect(await updateQuoteMeta("q1", { estimate_format: "bogus" as never })).toEqual({ ok: true });
    expect(formatWrites().map((c) => c.payload)).toEqual([{ estimate_format: null }]);
    expect(formatWrites()[0]).toMatchObject({ select: "id", filters: [["eq", "id", "q1"]] });
  });

  it("a zero-row write is said; an omitted format is 'Nothing to update.'", async () => {
    s.answer = (c) => (c.table === "quotes" && c.verb === "update" ? { data: [], error: null } : base(c));
    expect(await updateQuoteMeta("q-gone", { estimate_format: "tasks" })).toEqual({ ok: false, error: "That estimate isn't here to update." });
    expect(await updateQuoteMeta("q1", {})).toEqual({ ok: false, error: "Nothing to update." });
  });
});

describe("duplicateQuote", () => {
  const original = { customer_id: "c1", title: "Larkspur panel", description: null, notes: "", tax_rate: 0, valid_until: null, doc_type: "estimate", circuits: [], job_id: "j1", inquiry_id: null, status: "sent" };
  it("a copy and a Revise both carry the original's format into the new draft's insert", async () => {
    s.answer = (c) => (c.table === "quotes" && c.verb === "select" && c.select?.includes("estimate_format") ? { data: { ...original, estimate_format: "detailed" }, error: null } : base(c));
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new" });
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).toMatchObject({ estimate_format: "detailed", title: "Larkspur panel (copy)", job_id: null });
    s.calls = [];
    expect((await duplicateQuote("q1", { revision: true })).ok).toBe(true);
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).toMatchObject({ estimate_format: "detailed", title: "Larkspur panel", job_id: "j1" });
    // The company's (null) is carried as null, never as a word.
    s.calls = [];
    s.answer = (c) => (c.table === "quotes" && c.verb === "select" && c.select?.includes("estimate_format") ? { data: { ...original, estimate_format: null }, error: null } : base(c));
    await duplicateQuote("q1");
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).toMatchObject({ estimate_format: null });
  });

  it("cn-v1158 — a copy and a Revise of a One Materials Line estimate stay 'grouped' (the door kept only two words, so both came back as the company's)", async () => {
    s.answer = (c) => (c.table === "quotes" && c.verb === "select" && c.select?.includes("estimate_format") ? { data: { ...original, estimate_format: "grouped" }, error: null } : base(c));
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new" });
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).toMatchObject({ estimate_format: "grouped", title: "Larkspur panel (copy)", job_id: null });
    s.calls = [];
    expect((await duplicateQuote("q1", { revision: true })).ok).toBe(true);
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).toMatchObject({ estimate_format: "grouped", title: "Larkspur panel", job_id: "j1" });
    // A stored word the paper does not know is carried as the company's, never copied forward as it is.
    s.calls = [];
    s.answer = (c) => (c.table === "quotes" && c.verb === "select" && c.select?.includes("estimate_format") ? { data: { ...original, estimate_format: "itemized" }, error: null } : base(c));
    await duplicateQuote("q1");
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).toMatchObject({ estimate_format: null });
  });

  it("before 0395 (no column) the read falls to the select without it and the copy is made with no format of its own", async () => {
    s.answer = (c) => {
      if (c.table === "quotes" && c.verb === "select" && c.select?.includes("estimate_format")) return { data: null, error: { code: "42703", message: "column quotes.estimate_format does not exist" } };
      if (c.table === "quotes" && c.verb === "select" && c.select?.includes("circuits")) return { data: original, error: null };
      return base(c);
    };
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new" });
    const reads = s.calls.filter((c) => c.table === "quotes" && c.verb === "select" && c.select?.includes("circuits"));
    expect(reads.length).toBe(2);
    expect(reads[1].select).not.toContain("estimate_format");
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).not.toHaveProperty("estimate_format");
  });
});

describe("every word the paper knows goes through every door as itself (cn-v1158)", () => {
  const original = { customer_id: "c1", title: "Larkspur panel", description: null, notes: "", tax_rate: 0, valid_until: null, doc_type: "estimate", circuits: [], job_id: "j1", inquiry_id: null, status: "sent" };
  const inserted = () => (s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload as { estimate_format?: unknown }).estimate_format;

  it("the list is the paper's own (three words today), and each is stored as given by the first save, the later save, the pill, a copy and a Revise", async () => {
    expect([...ESTIMATE_FORMATS].sort()).toEqual(["detailed", "grouped", "tasks"]);
    for (const word of ESTIMATE_FORMATS as readonly EstimateFormat[]) {
      s.calls = [];
      s.answer = base;
      await saveQuote({ ...header, estimate_format: word });
      expect(inserted(), `first save: ${word}`).toBe(word);

      s.calls = [];
      await saveQuote({ ...header, id: "q1", estimate_format: word });
      expect(formatWrites().map((c) => c.payload), `later save: ${word}`).toEqual([{ estimate_format: word }]);

      s.calls = [];
      await updateQuoteMeta("q1", { estimate_format: word });
      expect(formatWrites().map((c) => c.payload), `the pill: ${word}`).toEqual([{ estimate_format: word }]);

      for (const revision of [false, true]) {
        s.calls = [];
        s.answer = (c) => (c.table === "quotes" && c.verb === "select" && c.select?.includes("estimate_format") ? { data: { ...original, estimate_format: word }, error: null } : base(c));
        await duplicateQuote("q1", revision ? { revision: true } : undefined);
        expect(inserted(), `${revision ? "Revise" : "copy"}: ${word}`).toBe(word);
      }
    }
  });

  it("null still means the company's at every door: stored as null, never as a word", async () => {
    await saveQuote({ ...header, estimate_format: null });
    expect(inserted()).toBeNull();
    s.calls = [];
    await saveQuote({ ...header, id: "q1", estimate_format: null });
    expect(formatWrites().map((c) => c.payload)).toEqual([{ estimate_format: null }]);
    s.calls = [];
    expect(await updateQuoteMeta("q1", { estimate_format: null })).toEqual({ ok: true });
    expect(formatWrites().map((c) => c.payload)).toEqual([{ estimate_format: null }]);
    s.calls = [];
    s.answer = (c) => (c.table === "quotes" && c.verb === "select" && c.select?.includes("estimate_format") ? { data: { ...original, estimate_format: null }, error: null } : base(c));
    await duplicateQuote("q1", { revision: true });
    expect(inserted()).toBeNull();
  });
});
