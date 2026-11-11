import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE ESTIMATE'S OWN JOB SITE, WRITTEN (cn-v1158). The owner, 2026-11-10, pricing a unit for a
 * customer that owns two complexes: "we need to have sites available to pick from on the estimate
 * sheet". Every reader already ranked the estimate's own five address columns first; no door wrote
 * them. setQuoteSite is that door, driven here without a database: a fake that holds ONE estimate
 * row and honours the filters the action sends (`.eq("id")`, `.eq("org_id")`, `.is("job_id", null)`),
 * so a write that should land on nothing lands on nothing. Every name and street here is invented.
 */
type Row = Record<string, unknown> & { id: string; job_id: string | null };
type Filter = [op: "eq" | "is", col: string, value: unknown];
const s = vi.hoisted(() => ({
  staff: true,
  language: "en",
  quote: null as null | Row,
  readError: null as null | { message: string },
  writeError: null as null | { message: string },
  /** What another door does between the action's first read and its write. */
  afterFirstRead: null as null | (() => void),
  reads: [] as string[],
  writes: [] as { patch: Record<string, unknown>; filters: Filter[]; readBack: string | null }[],
  profileReads: 0,
  client: null as unknown,
}));

function fake() {
  return {
    from(table: string) {
      let patch: Record<string, unknown> | null = null;
      let cols = "";
      let readBack: string | null = null;
      const filters: Filter[] = [];
      const hits = (row: Row) => filters.every(([op, col, v]) => (op === "eq" ? row[col] === v : (row[col] ?? null) === v));
      const run = (single: boolean) => {
        if (table === "profiles") {
          s.profileReads += 1;
          return { data: { language: s.language }, error: null };
        }
        if (table !== "quotes") return { data: single ? null : [], error: null };
        if (patch) {
          s.writes.push({ patch, filters: [...filters], readBack });
          if (s.writeError) return { data: null, error: s.writeError };
          if (!s.quote || !hits(s.quote)) return { data: [], error: null };
          Object.assign(s.quote, patch);
          return { data: readBack ? [{ id: s.quote.id }] : null, error: null };
        }
        s.reads.push(cols);
        if (s.readError) return { data: null, error: s.readError };
        const row = s.quote && hits(s.quote) ? { ...s.quote } : null;
        const then = s.afterFirstRead;
        s.afterFirstRead = null;
        then?.();
        return { data: single ? row : row ? [row] : [], error: null };
      };
      const b: Record<string, unknown> = {
        select: (c: string) => {
          if (patch) readBack = c;
          else cols = c;
          return b;
        },
        update: (p: Record<string, unknown>) => {
          patch = p;
          return b;
        },
        eq: (col: string, v: unknown) => (filters.push(["eq", col, v]), b),
        is: (col: string, v: unknown) => (filters.push(["is", col, v]), b),
        limit: () => b, // the caller's language is read with .limit(1) (lib/lang-of)
        maybeSingle: async () => run(true),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run(false)).then(ok, bad),
      };
      return b;
    },
    auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => s.client), createServiceClient: vi.fn(() => s.client) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => (s.staff ? { supabase: s.client, userId: "office-1", orgId: "org-1" } : { error: "This action is staff-only." })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Map<string, string>() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));

import { setQuoteSite } from "./actions";
import { bustDocPdf } from "@/lib/pdf-cache";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";

const SITE = { address: "40 Snowbell Court", unit: "14", city: "Testville", state: "CA", zip: "96161" };
const FIVE = ["address", "city", "state", "unit", "zip"];
const JOB_OWNS = "This estimate is already on a job, and the job owns its site. Change the address on the job.";
const UNAVAILABLE = "That estimate isn't available.";
const blankQuote = (over: Partial<Row> = {}): Row => ({ id: "q1", org_id: "org-1", job_id: null, address: null, unit: null, city: null, state: null, zip: null, ...over });
/** The id, and the caller's own company: every read and write of the estimate carries both. */
const MINE: Filter[] = [["eq", "id", "q1"], ["eq", "org_id", "org-1"]];

beforeEach(() => {
  vi.clearAllMocks();
  s.staff = true;
  s.language = "en";
  s.quote = blankQuote();
  s.readError = null;
  s.writeError = null;
  s.afterFirstRead = null;
  s.reads = [];
  s.writes = [];
  s.profileReads = 0;
  s.client = fake();
});

/** Nothing reached the row, the stored PDF or the page. */
const untouched = () => {
  expect(s.writes).toEqual([]);
  expect(bustDocPdf).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
};

describe("setQuoteSite: who may, and what it takes", () => {
  it("staff only: anyone else is refused before a thing is read", async () => {
    s.staff = false;
    expect(await setQuoteSite("q1", SITE)).toEqual({ ok: false, error: "This action is staff-only." });
    expect(await setQuoteSite("q1", null)).toEqual({ ok: false, error: "This action is staff-only." });
    expect(s.reads).toEqual([]);
    untouched();
    expect(requireStaff).toHaveBeenCalledTimes(2);
  });

  it("an address lands trimmed, an empty part as null, on the five columns and the stamp and nothing else", async () => {
    expect(await setQuoteSite("q1", { address: "  40 Snowbell Court ", unit: " 14 ", city: "Testville", state: "", zip: " 96161" })).toEqual({ ok: true });
    expect(s.writes).toHaveLength(1);
    const { patch } = s.writes[0];
    expect(Object.keys(patch).sort()).toEqual([...FIVE, "updated_at"].sort());
    expect(patch).toMatchObject({ address: "40 Snowbell Court", unit: "14", city: "Testville", state: null, zip: "96161" });
    expect(typeof patch.updated_at).toBe("string");
    expect(s.quote).toMatchObject({ address: "40 Snowbell Court", unit: "14", city: "Testville", state: null, zip: "96161" });
    // A save that says nothing reads no language.
    expect(s.profileReads).toBe(0);
  });

  it("a street alone is a site: the rest are written null, never left as they were", async () => {
    s.quote = blankQuote({ ...SITE });
    expect(await setQuoteSite("q1", { address: "9 Bayberry Lane" })).toEqual({ ok: true });
    expect(s.quote).toMatchObject({ address: "9 Bayberry Lane", unit: null, city: null, state: null, zip: null });
  });

  it("NULL CLEARS ALL FIVE: the estimate goes back to its lead's or its customer's address", async () => {
    s.quote = blankQuote({ ...SITE });
    expect(await setQuoteSite("q1", null)).toEqual({ ok: true });
    const { patch } = s.writes[0];
    expect(Object.keys(patch).sort()).toEqual([...FIVE, "updated_at"].sort());
    for (const col of FIVE) expect(patch[col], col).toBeNull();
    expect(s.quote).toMatchObject({ address: null, unit: null, city: null, state: null, zip: null });
  });

  it("no street is refused in words, and ONLY an explicit null clears: a malformed call never wipes an address", async () => {
    s.quote = blankQuote({ ...SITE });
    const need = "Type the street address of the job site first.";
    expect(await setQuoteSite("q1", { address: "   ", unit: "14", city: "Testville" })).toEqual({ ok: false, error: need });
    expect(await setQuoteSite("q1", {})).toEqual({ ok: false, error: need });
    expect(await setQuoteSite("q1", undefined as never)).toEqual({ ok: false, error: need });
    expect(await setQuoteSite("q1", "40 Snowbell Court" as never)).toEqual({ ok: false, error: need });
    expect(s.reads).toEqual([]); // refused on what was sent, before the estimate is even read
    untouched();
    expect(s.quote).toMatchObject(SITE);
  });

  it("a part too long to be an address is refused whole, never cut to fit", async () => {
    expect(await setQuoteSite("q1", { ...SITE, address: "x".repeat(301) })).toEqual({ ok: false, error: "That address is too long to save. Shorten it and try again." });
    expect(await setQuoteSite("q1", { ...SITE, unit: "x".repeat(61) })).toEqual({ ok: false, error: "That address is too long to save. Shorten it and try again." });
    untouched();
  });
});

describe("setQuoteSite: an estimate on a job", () => {
  it("takes no address of its own: refused in words that say where to change it, and nothing is written", async () => {
    s.quote = blankQuote({ job_id: "j1" });
    expect(await setQuoteSite("q1", SITE)).toEqual({ ok: false, error: JOB_OWNS });
    expect(s.reads).toEqual(["id, job_id"]);
    untouched();
  });

  it("A CLEAR IS ALLOWED on a job: it is how an estimate that carried its own address goes back to the job's", async () => {
    s.quote = blankQuote({ job_id: "j1", ...SITE });
    expect(await setQuoteSite("q1", null)).toEqual({ ok: true });
    expect(s.quote).toMatchObject({ job_id: "j1", address: null, unit: null, city: null, state: null, zip: null });
    // The clear carries no "only while there is no job" condition.
    expect(s.writes[0].filters).toEqual(MINE);
    expect(bustDocPdf).toHaveBeenCalledWith("quote", "q1", "org-1");
  });

  it("COMPARE-AND-SET: an address is written only while the estimate still has no job", async () => {
    expect(await setQuoteSite("q1", SITE)).toEqual({ ok: true });
    expect(s.writes[0].filters).toEqual([...MINE, ["is", "job_id", null]]);
  });

  it("a job made by another door between the read and the write: nothing lands, and the sentence is the job's", async () => {
    // The customer taps Accept on their link in the same second: the job is born from the estimate as
    // it stood. An address landing after that would leave the paper and the job disagreeing.
    s.afterFirstRead = () => {
      s.quote!.job_id = "j-accepted";
    };
    expect(await setQuoteSite("q1", SITE)).toEqual({ ok: false, error: JOB_OWNS });
    expect(s.writes).toHaveLength(1); // it was tried, under the condition…
    expect(s.quote).toMatchObject({ job_id: "j-accepted", address: null }); // …and it did not land
    expect(bustDocPdf).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setQuoteSite: a write that lands on nothing is not a success", () => {
  it("the write is read back with .select(\"id\")", async () => {
    await setQuoteSite("q1", SITE);
    expect(s.writes[0].readBack).toBe("id");
  });

  it("an estimate that is not there (or not this company's) is said, at the read", async () => {
    s.quote = null;
    expect(await setQuoteSite("q1", SITE)).toEqual({ ok: false, error: UNAVAILABLE });
    expect(await setQuoteSite("q1", null)).toEqual({ ok: false, error: UNAVAILABLE });
    untouched();
  });

  it("ANOTHER COMPANY'S ESTIMATE IS NOT THERE TO WRITE: the id is scoped to the caller's company at the read and at the write", async () => {
    // Row security is the boundary; this is the second rule beside it. The fake has no row security
    // at all, so it is the action's own filter that keeps this row out.
    s.quote = blankQuote({ org_id: "org-2", ...SITE });
    expect(await setQuoteSite("q1", { address: "9 Bayberry Lane" })).toEqual({ ok: false, error: UNAVAILABLE });
    expect(await setQuoteSite("q1", null)).toEqual({ ok: false, error: UNAVAILABLE });
    untouched();
    expect(s.quote).toMatchObject({ org_id: "org-2", ...SITE });
    // …and the write is scoped as well as the read, so it never rests on the read having been asked first.
    s.quote = blankQuote();
    await setQuoteSite("q1", SITE);
    await setQuoteSite("q1", null);
    for (const w of s.writes) expect(w.filters.slice(0, 2)).toEqual(MINE);
    expect(s.writes).toHaveLength(2);
  });

  it("an estimate deleted between the read and the write: zero rows is a refusal, never Saved", async () => {
    s.afterFirstRead = () => {
      s.quote = null;
    };
    expect(await setQuoteSite("q1", SITE)).toEqual({ ok: false, error: UNAVAILABLE });
    expect(s.writes).toHaveLength(1);
    expect(bustDocPdf).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    // …and the same for a clear.
    s.quote = blankQuote({ ...SITE });
    s.afterFirstRead = () => {
      s.quote = null;
    };
    expect(await setQuoteSite("q1", null)).toEqual({ ok: false, error: UNAVAILABLE });
    expect(bustDocPdf).not.toHaveBeenCalled();
  });

  it("a read or a write the database refuses is said in the database's own words", async () => {
    s.readError = { message: "the reader tripped" };
    expect(await setQuoteSite("q1", SITE)).toEqual({ ok: false, error: "the reader tripped" });
    untouched();
    s.readError = null;
    s.writeError = { message: "the writer tripped" };
    expect(await setQuoteSite("q1", SITE)).toEqual({ ok: false, error: "the writer tripped" });
    expect(bustDocPdf).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setQuoteSite: what follows a save", () => {
  it("the stored PDF of THIS estimate is dropped, in this company only", async () => {
    await setQuoteSite("q1", SITE);
    expect(bustDocPdf).toHaveBeenCalledTimes(1);
    expect(bustDocPdf).toHaveBeenCalledWith("quote", "q1", "org-1");
  });

  it("the estimate's page and the list are drawn again", async () => {
    await setQuoteSite("q1", null);
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual(["/quotes/q1", "/quotes"]);
  });
});

describe("setQuoteSite: a Spanish-reading office hears its refusals in Spanish", () => {
  it("no street, too long, on a job, not there", async () => {
    s.language = "es";
    expect(await setQuoteSite("q1", { address: "" })).toEqual({ ok: false, error: "Primero escribe la dirección del sitio de trabajo." });
    expect(await setQuoteSite("q1", { address: "x".repeat(400) })).toEqual({ ok: false, error: "Esa dirección es demasiado larga para guardarla. Acórtala e inténtalo de nuevo." });
    s.quote = blankQuote({ job_id: "j1" });
    expect(await setQuoteSite("q1", SITE)).toEqual({
      ok: false,
      error: "Este presupuesto ya está en un trabajo, y el sitio es del trabajo. Cambia la dirección en el trabajo.",
    });
    s.quote = null;
    expect(await setQuoteSite("q1", SITE)).toEqual({ ok: false, error: "Ese presupuesto no está disponible." });
    untouched();
  });
});

describe("the source: what the door promises the rest of the app", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/actions.ts"), "utf8");
  const door = src.slice(src.indexOf("export async function setQuoteSite("), src.indexOf("export async function setQuoteJob("));

  it("the door is there, staff-gated on its first line, and says its refusals from the server catalog", () => {
    expect(door.length).toBeGreaterThan(200);
    expect(door).toMatch(/\): Promise<\{ ok: boolean; error\?: string \}> \{\s*const ctx = await requireStaff\(\);\s*if \("error" in ctx\) return \{ ok: false, error: ctx\.error \};/);
    for (const key of ["qs_siteNeedsAddress", "qs_siteTooLong", "qs_siteJobOwns", "qs_estimateUnavailable"]) expect(door, key).toContain(`"${key}"`);
    // No English sentence of its own: every refusal is a key, said in the caller's language.
    expect(door).not.toMatch(/error: "[A-Z]/);
  });

  it("every read and write of the estimate names the caller's company beside the id", () => {
    const touches = [...door.matchAll(/supabase\.from\("quotes"\)[^;]*;/g)].map((m) => m[0]);
    expect(touches).toHaveLength(3); // the read, the write, and the read that says why nothing landed
    for (const touch of touches) expect(touch).toContain('.eq("id", quoteId).eq("org_id", ctx.orgId)');
  });

  it("the site is cleaned by the one rule, and the stored PDF is dropped with the company's id", () => {
    expect(door).toContain("const clean = cleanQuoteSite(site);");
    expect(door).toContain('await bustDocPdf("quote", quoteId, ctx.orgId);');
    expect(door).toContain("revalidatePath(`/quotes/${quoteId}`);");
    expect(door).toContain('revalidatePath("/quotes");');
  });

  it("THE JOB BORN FROM AN ESTIMATE STILL TAKES THE ESTIMATE'S OWN ADDRESS FIRST: before the lead's, before the customer's", () => {
    const born = src.slice(src.indexOf("export async function createJobFromQuote("), src.indexOf("async function pushQuoteAccepted("));
    // A column you do not select is a column you cannot inherit.
    expect(born).toContain('.select("id, job_id, status, customer_id, title, quote_number, inquiry_id, address, unit, city, state, zip, revises_quote_id")');
    const inherited = born.slice(born.indexOf("const inheritedAddress = await (async () => {"), born.indexOf("})();", born.indexOf("const inheritedAddress = await (async () => {")));
    const ownFirst = "if (q.address) return { address: q.address, unit: (q as { unit?: string | null }).unit ?? null, city: q.city, state: q.state, zip: q.zip };";
    expect(inherited).toContain(ownFirst);
    expect(inherited.indexOf(ownFirst)).toBeGreaterThan(-1);
    expect(inherited.indexOf(ownFirst)).toBeLessThan(inherited.indexOf('.from("inquiries")'));
    expect(inherited.indexOf('.from("inquiries")')).toBeLessThan(inherited.indexOf('.from("customers")'));
    // …and the job is inserted with all five.
    expect(born).toMatch(/address: inheritedAddress\.address,\s*unit: inheritedAddress\.unit \?\? null,\s*city: inheritedAddress\.city,\s*state: inheritedAddress\.state,\s*zip: inheritedAddress\.zip,/);
  });
});
