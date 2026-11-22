import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE ESTIMATE STORES ITS DEPOSIT (cn-v1177, 0414), driven against a recording fake client: every door
 * is CALLED and what it wrote is read off the recording.
 *
 *   recalcQuote (through saveQuote: the editor's autosave, the Won sheet's approval, Nort, the copy)
 *     writes deposit_amount in the SAME statement as the totals: the company's rule over the total, or
 *     the typed figure (never above the total); an offer no longer open keeps what it stated; a rule
 *     that could not be read writes no deposit.
 *   setQuoteDeposit (the editor's Deposit field): a typed figure is stored with the flag; one above the
 *     total, a negative, an accepted estimate are refused in words and write nothing; Use the Default
 *     writes the rule's figure with the flag off; zero rows is a refusal.
 *   duplicateQuote: a typed deposit rides to the copy (and a revision).
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
  for (const m of ["eq", "in", "is", "or", "order", "limit", "neq", "not"]) b[m] = (...a: unknown[]) => (c.filters.push([m, ...a]), b);
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
const pdf = vi.hoisted(() => ({ bust: vi.fn(async () => {}) }));
vi.mock("@/lib/pdf-cache", async (importOriginal) => ({ ...(await importOriginal<object>()), bustDocPdf: pdf.bust, warmDocPdf: vi.fn(async () => {}) }));

const { saveQuote, setQuoteDeposit, duplicateQuote, updateQuoteMeta } = await import("./actions");

const ID = "a0000000-0000-4000-8000-0000000000e9";
const recalcRead = (c: Call) => c.table === "quotes" && c.verb === "select" && c.select === "tax_rate, status, org_id, deposit_amount, deposit_by_hand";
const ruleRead = (c: Call) => c.table === "organizations" && c.verb === "select" && c.select === "settings";
const totalsWrite = (c: Call) => c.table === "quotes" && c.verb === "update" && "subtotal" in (c.payload as object);
const depositWrite = (c: Call) => c.table === "quotes" && c.verb === "update" && "deposit_by_hand" in (c.payload as object);

/** The world: one estimate, its stored deposit facts, its lines, and the company's settings. */
type World = { status?: string; stored?: number | null; byHand?: boolean; lines?: number[]; settings?: unknown; ruleFails?: boolean; total?: number; zeroRows?: boolean };
function world(w: World) {
  return (c: Call): unknown => {
    if (recalcRead(c)) return { data: { tax_rate: 0, status: w.status ?? "draft", org_id: "org-1", deposit_amount: w.stored ?? null, deposit_by_hand: w.byHand ?? false }, error: null };
    if (c.table === "quote_line_items" && c.verb === "select" && c.select === "line_total") return { data: (w.lines ?? [4800]).map((line_total) => ({ line_total })), error: null };
    if (ruleRead(c)) return w.ruleFails ? { data: null, error: { message: "the reader tripped" } } : { data: { settings: w.settings ?? {} }, error: null };
    if (c.table === "quotes" && c.verb === "select" && c.select === "id, status, inquiry_id") return { data: { id: ID, status: w.status ?? "draft", inquiry_id: null }, error: null };
    if (c.table === "quotes" && c.verb === "select" && c.select === "id, status, total, org_id") return { data: { id: ID, status: w.status ?? "draft", total: w.total ?? 4800, org_id: "org-1" }, error: null };
    if (c.table === "quotes" && c.verb === "select" && c.select === "status, job_id, quote_number, doc_type") return { data: { status: w.status ?? "draft", job_id: null, quote_number: "E-900", doc_type: "estimate" }, error: null };
    if (c.table === "quotes" && c.verb === "update") return { data: w.zeroRows ? [] : [{ id: ID }], error: null };
    if (c.table === "quotes" && c.verb === "insert") return { data: { id: (c.payload as { id?: string }).id ?? "q-copy", quote_number: "E-901" }, error: null };
    if (c.table === "quote_line_items" && c.verb === "insert") return { data: null, error: null };
    if (c.verb === "rpc" && c.table === "save_quote_draft") return { data: [{ id: (c.payload as { p_id: string }).p_id, quote_number: "E-900" }], error: null };
    return { data: null, error: null };
  };
}

const input = (over: Partial<Parameters<typeof saveQuote>[0]> = {}) => ({
  id: ID,
  customer_id: null,
  title: "Snowbell deck",
  notes: "",
  tax_rate: 0,
  valid_until: null,
  items: [{ description: "Deck", quantity: 1, unit: "ea", unit_price: 4800 }],
  ...over,
});

beforeEach(() => {
  s.calls = [];
  s.answer = world({});
  pdf.bust.mockClear();
});

describe("every save writes the deposit with the totals (recalcQuote)", () => {
  it("a new estimate: the company's default, 10% up to $1,000, in the same statement as the total", async () => {
    // No id standing: the insert path.
    s.answer = ((w) => (c: Call) => (c.table === "quotes" && c.verb === "select" && c.select === "id, status, inquiry_id" ? { data: null, error: null } : w(c)))(world({}));
    const res = await saveQuote(input());
    expect(res.ok).toBe(true);
    const writes = s.calls.filter(totalsWrite);
    expect(writes.at(-1)!.payload).toEqual({ subtotal: 4800, tax: 0, total: 4800, deposit_amount: 480 });
    expect(writes.at(-1)!.select).toBe("id");
    // The rule is read for THIS estimate's company.
    expect(s.calls.find(ruleRead)!.filters).toEqual([["eq", "id", "org-1"]]);
  });

  it("the cap holds: a $25,000 estimate asks $1,000; a company that chose 0% asks nothing", async () => {
    s.answer = world({ lines: [25000] });
    await saveQuote(input());
    expect(s.calls.filter(totalsWrite).at(-1)!.payload).toMatchObject({ total: 25000, deposit_amount: 1000 });
    s.calls = [];
    s.answer = world({ settings: { deposit_percent: 0 } });
    await saveQuote(input());
    expect(s.calls.filter(totalsWrite).at(-1)!.payload).toMatchObject({ total: 4800, deposit_amount: 0 });
  });

  it("THE WON SHEET'S APPROVAL: a standing draft saved under its id (the RPC path) stores the deposit too", async () => {
    const res = await saveQuote(input());
    expect(res.ok).toBe(true);
    expect(s.calls.some((c) => c.verb === "rpc" && c.table === "save_quote_draft")).toBe(true);
    expect(s.calls.filter(totalsWrite).at(-1)!.payload).toEqual({ subtotal: 4800, tax: 0, total: 4800, deposit_amount: 480 });
  });

  it("the Won sheet's approval goes through this save, from ../quotes/actions (source pin)", () => {
    const won = readFileSync(join(process.cwd(), "src/app/(app)/appointments/won-actions.ts"), "utf8");
    expect(won).toMatch(/import \{[^}]*\bsaveQuote\b[^}]*\} from "\.\.\/quotes\/actions"/);
    expect(won).toMatch(/await saveQuote\(\{/);
  });

  it("a typed deposit survives a later save, and is lowered to the total when the total falls under it", async () => {
    s.answer = world({ stored: 2000, byHand: true });
    await saveQuote(input());
    expect(s.calls.filter(totalsWrite).at(-1)!.payload).toMatchObject({ total: 4800, deposit_amount: 2000 });
    expect(s.calls.some(ruleRead)).toBe(false);
    s.calls = [];
    s.answer = world({ stored: 2000, byHand: true, lines: [1500] });
    await saveQuote(input({ items: [{ description: "Deck", quantity: 1, unit: "ea", unit_price: 1500 }] }));
    expect(s.calls.filter(totalsWrite).at(-1)!.payload).toMatchObject({ total: 1500, deposit_amount: 1500 });
  });

  it("an accepted estimate keeps what it stated; one saved before 0414 stays null (nothing written)", async () => {
    s.answer = world({ status: "accepted", stored: 480, lines: [9000] });
    await updateQuoteMeta(ID, { title: "Snowbell deck, phase two" });
    expect(s.calls.filter(totalsWrite).at(-1)!.payload).toEqual({ subtotal: 9000, tax: 0, total: 9000 });
    s.calls = [];
    s.answer = world({ status: "accepted", stored: null, lines: [9000] });
    await updateQuoteMeta(ID, { title: "Snowbell deck" });
    expect(s.calls.filter(totalsWrite).at(-1)!.payload).toEqual({ subtotal: 9000, tax: 0, total: 9000 });
    expect(s.calls.some(ruleRead)).toBe(false);
  });

  it("a company rule that could not be read writes no deposit (the totals still land)", async () => {
    s.answer = world({ ruleFails: true, stored: 300 });
    await saveQuote(input());
    expect(s.calls.filter(totalsWrite).at(-1)!.payload).toEqual({ subtotal: 4800, tax: 0, total: 4800 });
  });
});

describe("setQuoteDeposit (the editor's Deposit field)", () => {
  it("a typed figure is stored as typed, on an open offer only, read back, and the stored PDF dropped", async () => {
    const res = await setQuoteDeposit(ID, 1250);
    expect(res).toEqual({ ok: true, deposit: 1250, byHand: true });
    const w = s.calls.find(depositWrite)!;
    expect(w.payload).toEqual({ deposit_by_hand: true, deposit_amount: 1250 });
    expect(w.filters).toEqual([["eq", "id", ID], ["eq", "org_id", "org-1"], ["in", "status", ["draft", "sent"]]]);
    expect(w.select).toBe("id");
    expect(pdf.bust).toHaveBeenCalledWith("quote", ID);
  });

  it("above the total, negative, or not a number: refused in one sentence, nothing written", async () => {
    expect(await setQuoteDeposit(ID, 5000)).toEqual({ ok: false, error: "A deposit can't be more than this estimate's total of $4,800.00. Type a smaller amount." });
    expect(await setQuoteDeposit(ID, -1)).toEqual({ ok: false, error: "Type the deposit as an amount of $0 or more." });
    expect(await setQuoteDeposit(ID, Number.NaN)).toEqual({ ok: false, error: "Type the deposit as an amount of $0 or more." });
    expect(s.calls.some(depositWrite)).toBe(false);
  });

  it("an accepted estimate's deposit was part of the offer: refused, naming the one way (revise it)", async () => {
    s.answer = world({ status: "accepted" });
    const res = await setQuoteDeposit(ID, 100);
    expect(res).toEqual({ ok: false, error: "This estimate's deposit can't change now: it was part of the offer. Revise the estimate to offer a different deposit." });
    expect(s.calls.some(depositWrite)).toBe(false);
  });

  it("Use the Default: the company's rule over the stored total, flag off, one statement", async () => {
    s.answer = world({ total: 4800, settings: { deposit_percent: 25, deposit_cap_amount: 0 } });
    const res = await setQuoteDeposit(ID, null);
    expect(res).toEqual({ ok: true, deposit: 1200, byHand: false });
    expect(s.calls.find(depositWrite)!.payload).toEqual({ deposit_by_hand: false, deposit_amount: 1200 });
  });

  it("zero rows is not success", async () => {
    s.answer = world({ zeroRows: true });
    expect(await setQuoteDeposit(ID, 100)).toEqual({ ok: false, error: "That estimate isn't here to update." });
  });
});

describe("duplicateQuote carries a typed deposit", () => {
  const original = { customer_id: null, title: "Snowbell deck", description: null, notes: "", tax_rate: 0, valid_until: null, doc_type: "estimate", circuits: null, job_id: null, inquiry_id: null, status: "sent", address: null, unit: null, city: null, state: null, zip: null, estimate_format: null };
  const withSource = (row: Record<string, unknown>) => {
    const w = world({});
    return (c: Call) => {
      if (c.table === "quotes" && c.verb === "select" && c.select?.includes("circuits")) return { data: row, error: null };
      if (c.table === "quote_line_items" && c.verb === "select" && c.select?.startsWith("description")) return { data: [{ description: "Deck", quantity: 1, unit: "ea", unit_price: 4800, category: null, detail: null }], error: null };
      if (c.table === "quotes" && c.verb === "select" && c.select === "id, status, inquiry_id") return { data: null, error: null };
      return w(c);
    };
  };

  it("the source select names both columns; a typed figure is written onto the copy (a draft) and read back", async () => {
    s.answer = withSource({ ...original, deposit_amount: "2000.00", deposit_by_hand: true });
    const res = await duplicateQuote(ID);
    expect(res.ok).toBe(true);
    const read = s.calls.find((c) => c.table === "quotes" && c.verb === "select" && c.select?.includes("circuits"))!;
    expect(read.select!.split(", ")).toEqual(expect.arrayContaining(["deposit_amount", "deposit_by_hand"]));
    const w = s.calls.find(depositWrite)!;
    expect(w.payload).toEqual({ deposit_by_hand: true, deposit_amount: 2000 });
    expect(w.filters).toEqual([["eq", "id", "q-copy"], ["eq", "status", "draft"]]);
    expect(w.select).toBe("id");
  });

  it("a deposit that followed the rule is not carried by hand: the copy's own save states the company's", async () => {
    s.answer = withSource({ ...original, deposit_amount: 480, deposit_by_hand: false });
    await duplicateQuote(ID);
    expect(s.calls.some(depositWrite)).toBe(false);
    expect(s.calls.filter(totalsWrite).at(-1)!.payload).toMatchObject({ deposit_amount: 480 });
  });
});

describe("no other door writes an estimate's totals", () => {
  it("in quotes/actions the totals are written only by recalcQuote, and saveQuote ends in it", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/actions.ts"), "utf8");
    const updates = [...src.matchAll(/\.update\(\{[^}]*\bsubtotal\b/g)];
    expect(updates).toHaveLength(1);
    const recalc = src.slice(src.indexOf("async function recalcQuote"), src.indexOf("async function appendQuoteLine("));
    expect(recalc).toContain(".update({ subtotal, tax, total, ...(deposit !== undefined ? { deposit_amount: deposit } : {}) })");
    const save = src.slice(src.indexOf("export async function saveQuote("), src.indexOf("async function siteACopyLeavesBehind"));
    expect(save).toContain("const stored = await recalcQuote(supabase, quote.id);");
  });

  it("the projection law: the editor's named read and the office paper (print, and the PDF made from it) carry the deposit", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/actions.ts"), "utf8");
    const cols = src.slice(src.indexOf("const EDITOR_QUOTE_COLUMNS"), src.indexOf("const EDITOR_ITEM_COLUMNS"));
    expect(cols).toContain("deposit_amount, deposit_by_hand");
    const print = readFileSync(join(process.cwd(), "src/app/print/quote/[id]/page.tsx"), "utf8");
    expect(print).toMatch(/\.select\(`\*, customers/);
    expect(print).toContain("depositDue={(q as { deposit_amount?: number | string | null }).deposit_amount ?? null}");
    const page = readFileSync(join(process.cwd(), "src/app/(app)/quotes/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/\.select\("\*, customers/);
  });
});
