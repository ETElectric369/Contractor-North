import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A COPY AND A REVISION KEEP THE ESTIMATE'S OWN JOB SITE (cn-v1158).
 *
 * The Job Site line is the first door that writes an estimate's own address (setQuoteSite). Until it
 * existed no estimate carried one, so the copy door (duplicateQuote) had nothing to lose, and its
 * select list never named the five columns. The day the line shipped, that became a hole: an estimate
 * set to a customer's second building, copied to price the unit next door or revised after a change,
 * came back printing the customer's OWN address with no unit. The same paper, a different place,
 * and nothing said. Found by the builder of the line, before anybody met it.
 *
 * saveQuote has no address field (it is the builder's autosave), so the copy's address is written
 * onto the row saveQuote just made, as it is on file, and read back; a write that did not land is
 * said beside the copy, never a failed copy and never a quiet one. Driven against a recording fake.
 *
 * THE OTHER HALF (found by the skeptic of the same release): an estimate with NO address of its own prints its
 * job's, else its lead's, and a plain copy keeps neither the job nor the lead. So the copy of an
 * estimate that printed its job's address came back printing the customer's, and nothing said. A
 * plain copy now reads the address it is about to leave behind (the job's, else the lead's: the
 * paper's own order) and carries it as its own. A revision keeps the job and the lead and reads
 * nothing; a read that fails is said with the same sentence, never a failed copy.
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

const { duplicateQuote } = await import("./actions");
const { bustDocPdf } = await import("@/lib/pdf-cache");
const { reportError } = await import("@/lib/observe");
const { translator } = await import("@/lib/i18n");
const { SITE_COLS } = await import("@/lib/site-address");

const original = {
  customer_id: "c1",
  title: "Larkspur panel",
  description: null,
  notes: "",
  tax_rate: 0,
  valid_until: null,
  doc_type: "estimate",
  circuits: [] as unknown[],
  job_id: null as string | null,
  inquiry_id: null as string | null,
  status: "sent",
  estimate_format: null,
  address: null as string | null,
  unit: null as string | null,
  city: null as string | null,
  state: null as string | null,
  zip: null as string | null,
};
const secondBuilding = { address: "40 Snowbell Ct", unit: "14", city: "Bayberry", state: "CA", zip: "96145" };
/** The job the original is on, and the lead it was started from: each has an address of its own. */
const jobSite = { address: "9 Bayberry Lane", unit: "3", city: "Bayberry", state: "CA", zip: "96145" };
const leadSite = { address: "16 Larkspur Circle", unit: null, city: "Thistlewood", state: "CA", zip: "96146" };

const isSiteWrite = (c: Call) => c.table === "quotes" && c.verb === "update" && "address" in (c.payload as object);
const isCircuitWrite = (c: Call) => c.table === "quotes" && c.verb === "update" && "circuits" in (c.payload as object);
const siteWrites = () => s.calls.filter(isSiteWrite);
/** The copy door's own two reads: a record's five address columns, asked for by id. (saveQuote's
 *  check of a lead reads "id" alone, so it is not one of these.) */
const FIVE = "address, unit, city, state, zip";
const isJobRead = (c: Call) => c.table === "jobs" && c.verb === "select" && c.select === FIVE;
const isLeadRead = (c: Call) => c.table === "inquiries" && c.verb === "select" && c.select === FIVE;
const siteReads = () => s.calls.filter((c) => isJobRead(c) || isLeadRead(c));
/** What those two reads answer: the job's row and the lead's (null = no such row for this caller). */
const behind = (rows: { job?: unknown; lead?: unknown }) => (c: Call): unknown =>
  isJobRead(c) ? { data: rows.job ?? null, error: null } : isLeadRead(c) ? { data: rows.lead ?? null, error: null } : undefined;

/** The world as the copy door reads it: the estimate being copied is `row`; every write lands unless `over` says otherwise. */
const world = (row: typeof original, over?: (c: Call) => unknown) => (c: Call): unknown => {
  const mine = over?.(c);
  if (mine !== undefined) return mine;
  if (c.table === "quotes" && c.verb === "select" && c.select?.includes("circuits")) return { data: row, error: null };
  if (c.table === "quotes" && c.verb === "select" && c.select === "tax_rate") return { data: { tax_rate: 0 }, error: null };
  if (c.table === "quote_line_items" && c.verb === "select") return { data: [], error: null };
  if (c.table === "quote_line_items" && c.verb === "insert") return { data: null, error: null };
  if (c.table === "quotes" && c.verb === "insert") return { data: { id: "q-new", quote_number: "E-010" }, error: null };
  if (c.table === "quotes" && c.verb === "update") return { data: [{ id: "q-new" }], error: null };
  return { data: null, error: null };
};

beforeEach(() => {
  s.calls = [];
  vi.mocked(bustDocPdf).mockClear();
  vi.mocked(reportError).mockClear();
});

describe("a copy keeps the estimate's own job site", () => {
  it("the copy door reads the five address columns with the rest of the header", async () => {
    s.answer = world({ ...original, ...secondBuilding });
    await duplicateQuote("q1");
    const read = s.calls.find((c) => c.table === "quotes" && c.verb === "select" && c.select?.includes("circuits"))!;
    for (const col of ["address", "unit", "city", "state", "zip"]) expect(read.select!.split(/,\s*/)).toContain(col);
  });

  it("a plain copy: the five columns are written onto the new row as they are on file, read back, and its stored PDF is dropped", async () => {
    s.answer = world({ ...original, ...secondBuilding });
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new" });
    const insertAt = s.calls.findIndex((c) => c.table === "quotes" && c.verb === "insert");
    const writeAt = s.calls.findIndex(isSiteWrite);
    expect(insertAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(insertAt); // onto the row saveQuote just made
    expect(siteWrites()).toHaveLength(1);
    expect(s.calls[writeAt]).toMatchObject({ payload: secondBuilding, select: "id", filters: [["eq", "id", "q-new"]] });
    expect(bustDocPdf).toHaveBeenCalledWith("quote", "q-new", "org-1");
  });

  it("a Revise on a job keeps it too: the revision is the same paper, so it prints the same place", async () => {
    s.answer = world({ ...original, ...secondBuilding, job_id: "j1" });
    expect((await duplicateQuote("q1", { revision: true })).ok).toBe(true);
    expect(s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload).toMatchObject({ job_id: "j1", title: "Larkspur panel" });
    expect(siteWrites()).toHaveLength(1);
    expect(siteWrites()[0]).toMatchObject({ payload: secondBuilding, filters: [["eq", "id", "q-new"]] });
  });

  it("a street with no unit or town is copied as that: the gaps stay null, nothing is made up", async () => {
    s.answer = world({ ...original, address: "40 Snowbell Ct" });
    await duplicateQuote("q1");
    expect(siteWrites()[0].payload).toEqual({ address: "40 Snowbell Ct", unit: null, city: null, state: null, zip: null });
  });

  it("an estimate with no address of its own, no job and no lead writes none and reads nothing: the copy follows its customer, as the original does", async () => {
    s.answer = world(original);
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new" });
    expect(siteWrites()).toEqual([]);
    expect(siteReads()).toEqual([]);
    // A town with no street is not a job site (lib/quote-site siteKey): nothing is copied from it either.
    s.calls = [];
    s.answer = world({ ...original, address: "   ", city: "Bayberry" });
    await duplicateQuote("q1");
    expect(siteWrites()).toEqual([]);
    expect(siteReads()).toEqual([]);
  });
});

describe("a plain copy keeps the place its paper printed: the address of the job or the lead it leaves behind", () => {
  const inserted = () => s.calls.find((c) => c.table === "quotes" && c.verb === "insert")!.payload as Record<string, unknown>;

  it("a job's estimate with no address of its own: the job's five columns are read by id and written onto the copy as its own", async () => {
    // The job's row as the database holds it; only the five columns are asked for, and only they are written.
    s.answer = world({ ...original, job_id: "j1" }, behind({ job: { ...jobSite } }));
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new" });
    // The copy stands on its own, off the job: that is exactly why its paper would have moved.
    expect(inserted()).toMatchObject({ job_id: null, title: "Larkspur panel (copy)" });
    expect(siteReads().map((c) => [c.table, c.select, c.filters])).toEqual([["jobs", FIVE, [["eq", "id", "j1"]]]]);
    expect(siteWrites()).toHaveLength(1);
    expect(siteWrites()[0]).toMatchObject({ payload: jobSite, select: "id", filters: [["eq", "id", "q-new"]] });
    // After the row exists, and its stored PDF (made with the customer's address, or none) is dropped.
    expect(s.calls.findIndex(isSiteWrite)).toBeGreaterThan(s.calls.findIndex((c) => c.table === "quotes" && c.verb === "insert"));
    expect(bustDocPdf).toHaveBeenCalledWith("quote", "q-new", "org-1");
  });

  it("the job answered, so the lead is not asked: the paper printed the job's address, never the lead's", async () => {
    s.answer = world({ ...original, job_id: "j1", inquiry_id: "l1" }, behind({ job: { ...jobSite }, lead: { ...leadSite } }));
    await duplicateQuote("q1");
    // A plain copy keeps neither: both pointers are gone from the new row.
    expect(inserted()).toMatchObject({ job_id: null, inquiry_id: null });
    expect(siteReads().map((c) => c.table)).toEqual(["jobs"]);
    expect(siteWrites().map((c) => c.payload)).toEqual([jobSite]);
  });

  it("a job with no street falls to the lead's address (the paper's own order: the job, then the lead)", async () => {
    for (const job of [{ address: null, unit: null, city: "Bayberry", state: "CA", zip: "96145" }, { address: "   ", unit: "3", city: null, state: null, zip: null }, null]) {
      s.calls = [];
      s.answer = world({ ...original, job_id: "j1", inquiry_id: "l1" }, behind({ job, lead: { ...leadSite } }));
      expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new" });
      expect(siteReads().map((c) => [c.table, c.filters])).toEqual([["jobs", [["eq", "id", "j1"]]], ["inquiries", [["eq", "id", "l1"]]]]);
      // The lead's address WHOLE: nothing of the job's row (its town, its unit) is mixed into it.
      expect(siteWrites().map((c) => c.payload)).toEqual([leadSite]);
    }
  });

  it("an estimate started from a lead, with no job: the lead's address, and only the lead is read", async () => {
    s.answer = world({ ...original, customer_id: null as never, inquiry_id: "l1" }, behind({ lead: { ...leadSite } }));
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new" });
    expect(siteReads().map((c) => c.table)).toEqual(["inquiries"]);
    expect(siteWrites()[0]).toMatchObject({ payload: leadSite, select: "id", filters: [["eq", "id", "q-new"]] });
  });

  it("a street with no unit or town is carried as that: the gaps stay null", async () => {
    s.answer = world({ ...original, job_id: "j1" }, behind({ job: { address: "9 Bayberry Lane", unit: null, city: null, state: null, zip: null } }));
    await duplicateQuote("q1");
    expect(siteWrites()[0].payload).toEqual({ address: "9 Bayberry Lane", unit: null, city: null, state: null, zip: null });
  });

  it("neither the job nor the lead has a street: nothing is written and nothing is said (the original printed its customer's address, and the copy keeps the customer)", async () => {
    const blank = { address: null, unit: null, city: null, state: null, zip: null };
    for (const rows of [{ job: blank, lead: blank }, { job: null, lead: null }, { job: { ...blank, city: "Bayberry" }, lead: { ...blank, address: " " } }]) {
      s.calls = [];
      vi.mocked(bustDocPdf).mockClear();
      s.answer = world({ ...original, job_id: "j1", inquiry_id: "l1" }, behind(rows));
      expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new" });
      expect(siteReads()).toHaveLength(2);
      expect(siteWrites()).toEqual([]);
      expect(bustDocPdf).not.toHaveBeenCalledWith("quote", "q-new", "org-1");
    }
  });

  it("its OWN address still wins over the job's and the lead's, and then neither is read", async () => {
    s.answer = world({ ...original, ...secondBuilding, job_id: "j1", inquiry_id: "l1" }, behind({ job: { ...jobSite }, lead: { ...leadSite } }));
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new" });
    expect(siteReads()).toEqual([]);
    expect(siteWrites().map((c) => c.payload)).toEqual([secondBuilding]);
  });

  it("a REVISION makes no such read: it keeps the job and the lead, so it goes on following their address", async () => {
    s.answer = world({ ...original, job_id: "j1", inquiry_id: "l1" }, (c) => (c.table === "inquiries" && c.verb === "select" && c.select === "id" ? { data: { id: "l1" }, error: null } : behind({ job: { ...jobSite }, lead: { ...leadSite } })(c)));
    expect((await duplicateQuote("q1", { revision: true })).ok).toBe(true);
    expect(inserted()).toMatchObject({ job_id: "j1", inquiry_id: "l1", title: "Larkspur panel" });
    expect(siteReads()).toEqual([]);
    expect(siteWrites()).toEqual([]);
  });
});

describe("a job site that did not land is said, and the copy stands", () => {
  const said = translator("en")("qs_copyNoSite");

  it("the sentence says what happened and where to look, in both languages", () => {
    expect(said).toBe("The copy is made, but the job site set on the original didn't come with it. Check the Job Site on the copy.");
    expect(translator("es")("qs_copyNoSite")).toBe("La copia está hecha, pero el sitio de trabajo fijado en el original no vino con ella. Revisa el Sitio de Trabajo en la copia.");
  });

  it("zero rows (a 204 is not a success): the copy is returned with the sentence, and no PDF is dropped for a write that did not happen", async () => {
    s.answer = world({ ...original, ...secondBuilding }, (c) => (isSiteWrite(c) ? { data: [], error: null } : undefined));
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new", warning: said });
    expect(bustDocPdf).not.toHaveBeenCalledWith("quote", "q-new", "org-1");
  });

  it("a database error: the same sentence, and the error goes to the sink with the two ids and nothing about the customer", async () => {
    s.answer = world({ ...original, ...secondBuilding }, (c) => (isSiteWrite(c) ? { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined));
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new", warning: said });
    expect(reportError).toHaveBeenCalledWith("quotes.duplicateQuote.site", expect.anything(), { from: "q1", to: "q-new" });
  });

  it("the site and the circuit schedule both lost: both sentences, the site's first, in one warning", async () => {
    const row = { ...original, ...secondBuilding, circuits: [{ id: "c1" }, { id: "c2" }] };
    s.answer = world(row, (c) => (isSiteWrite(c) || isCircuitWrite(c) ? { data: [], error: null } : undefined));
    const res = await duplicateQuote("q1");
    expect(res.ok).toBe(true);
    expect(res.id).toBe("q-new");
    const circuits = translator("en")("qs_copyNoCircuitsMany").replace("{n}", "2");
    expect(res.warning).toBe(`${said} ${circuits}`);
  });

  it("the circuit schedule alone lost still says its own sentence, as before", async () => {
    const row = { ...original, circuits: [{ id: "c1" }] };
    s.answer = world(row, (c) => (isCircuitWrite(c) ? { data: [], error: null } : undefined));
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new", warning: translator("en")("qs_copyNoCircuitsOne").replace("{n}", "1") });
  });

  // THE OTHER HALF: the address a plain copy leaves behind is READ first, and a read can fail too.
  const timeout = { code: "57014", message: "canceling statement due to statement timeout" };

  it("the job's address could not be read: the copy stands, the sentence is said, the error goes to the sink, and the lead is NOT guessed in its place", async () => {
    s.answer = world({ ...original, job_id: "j1", inquiry_id: "l1" }, (c) => (isJobRead(c) ? { data: null, error: timeout } : behind({ lead: { ...leadSite } })(c)));
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new", warning: said });
    expect(reportError).toHaveBeenCalledExactlyOnceWith("quotes.duplicateQuote.site", timeout, { from: "q1", to: "q-new" });
    // Nobody knows whether the job had a street, so the lead's address would be a guess: not read, not written.
    expect(siteReads().map((c) => c.table)).toEqual(["jobs"]);
    expect(siteWrites()).toEqual([]);
    expect(bustDocPdf).not.toHaveBeenCalledWith("quote", "q-new", "org-1");
  });

  it("the lead's address could not be read (the job had no street): the same sentence, once, and nothing written", async () => {
    s.answer = world({ ...original, job_id: "j1", inquiry_id: "l1" }, (c) => (isLeadRead(c) ? { data: null, error: timeout } : behind({ job: null })(c)));
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new", warning: said });
    expect(reportError).toHaveBeenCalledExactlyOnceWith("quotes.duplicateQuote.site", timeout, { from: "q1", to: "q-new" });
    expect(siteWrites()).toEqual([]);
  });

  it("the address was read and its write did not land: the same sentence, and no PDF is dropped for a write that did not happen", async () => {
    s.answer = world({ ...original, job_id: "j1" }, (c) => (isSiteWrite(c) ? { data: [], error: null } : behind({ job: { ...jobSite } })(c)));
    expect(await duplicateQuote("q1")).toEqual({ ok: true, id: "q-new", warning: said });
    expect(siteWrites().map((c) => c.payload)).toEqual([jobSite]);
    expect(bustDocPdf).not.toHaveBeenCalledWith("quote", "q-new", "org-1");
  });

  it("a failed read beside a lost circuit schedule: both sentences, the site's first, in one warning", async () => {
    const row = { ...original, job_id: "j1", circuits: [{ id: "c1" }] };
    s.answer = world(row, (c) => (isJobRead(c) ? { data: null, error: timeout } : isCircuitWrite(c) ? { data: [], error: null } : undefined));
    const res = await duplicateQuote("q1");
    expect(res).toEqual({ ok: true, id: "q-new", warning: `${said} ${translator("en")("qs_copyNoCircuitsOne").replace("{n}", "1")}` });
  });
});

describe("the door, in its own words", () => {
  it("writes what is on file through the one rule for 'has an address', and never through the screen's action", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/actions.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function duplicateQuote("), src.indexOf("async function materializeQuoteCustomer("));
    expect(fn).toContain("const ownSite = sitePartsOf(quote as SiteParts);");
    // RE-PINNED with the other half (it was `if (siteKey(ownSite) && res.id) {`): the estimate's own
    // address is still asked first through the one rule, and ONE write serves whichever address the
    // copy carries, so the read-back, the sentence and the PDF bust cannot differ between the halves.
    expect(fn).toContain("let copySite: SiteParts | null = siteKey(ownSite) ? ownSite : null;");
    expect(fn).toContain("if (copySite && res.id) {");
    expect(fn.split('.update({ address: copySite.address ?? null, unit: copySite.unit ?? null, city: copySite.city ?? null, state: copySite.state ?? null, zip: copySite.zip ?? null })').length - 1).toBe(1);
    // setQuoteSite refuses an estimate on a job; a revision on a job must still keep its paper's place.
    expect(fn).not.toContain("setQuoteSite(");
    expect(fn).toContain('warnings.push(await ws.say("qs_copyNoSite"));');
    expect(fn).toContain('return { ok: true, id: res.id, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };');
  });

  it("the address left behind is read on a plain copy only, by id, in the paper's own order, and a failed read is never 'no address'", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/actions.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function duplicateQuote("), src.indexOf("async function materializeQuoteCustomer("));
    // Only when the original has no address of its own, only for a plain copy, only once the copy exists.
    expect(fn).toContain("if (!copySite && !revision && res.id) {");
    expect(fn).toMatch(/if \("error" in left\) \{\s*reportError\("quotes\.duplicateQuote\.site", left\.error, \{ from: id, to: res\.id \}\);\s*warnings\.push\(await ws\.say\("qs_copyNoSite"\)\);\s*\} else \{\s*copySite = left\.site;\s*\}/);
    const reader = src.slice(src.indexOf("async function siteACopyLeavesBehind("), src.indexOf("export async function duplicateQuote("));
    // Not an action: a "use server" file exports only its actions, and this is a private read.
    expect(src).not.toContain("export async function siteACopyLeavesBehind(");
    // The five columns by lib/site-address's own list (SITE_COLS), never a retyped one; FIVE above is
    // what that list says today, so the fake's reads are matched on the real columns.
    expect(reader).toContain('.from("jobs").select(SITE_COLS).eq("id", from.job_id).maybeSingle();');
    expect(reader).toContain('.from("inquiries").select(SITE_COLS).eq("id", from.inquiry_id).maybeSingle();');
    expect(SITE_COLS).toBe(FIVE);
    // The lead is asked only when the job gave no street; either read failing ends it with the failure.
    expect(reader).toContain("if (!siteKey(records.job) && from.inquiry_id) {");
    expect(reader.split("if (error) return { error };").length - 1).toBe(2);
    // The order is the paper's one list (lib/quote-site), never a second one written here; and the
    // customer's address is not read at all: the copy keeps its customer.
    expect(reader).toContain("quoteSiteCandidates(records).find((c) => siteKey(c.parts))?.parts ?? null");
    expect(reader).not.toContain('.from("customers")');
  });
});
