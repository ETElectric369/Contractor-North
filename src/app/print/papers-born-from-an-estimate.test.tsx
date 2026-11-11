import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { textOf } from "@/test/rendered-page";
import { SITE_COLS } from "@/lib/site-address";

/**
 * A WORK ORDER AND A MATERIALS LIST BORN FROM AN ESTIMATE KNOW THEIR PLACE (cn-v1160). Neither owns
 * an address. Each printed its own job's site and nothing else, so a paper made from an estimate
 * that had no job yet printed no place at all, while the estimate it came from printed the building
 * the work is in. Both pages are rendered here, the server pages themselves against a recording
 * client: what each asks of the database, and what the sheet says.
 *
 *   · the order is the one every paper born from an estimate follows (lib/quote-site
 *     bornFromEstimateCandidates): the job's site, the estimate's own, that estimate's lead's, its
 *     customer's;
 *   · the estimate is asked only when the job gave no address, by the paper's quote_id, for address
 *     columns and nothing else (the materials list is the crew's sheet too: no price);
 *   · a paper made from no estimate, and a paper on a job that has an address, ask what they always
 *     asked and print what they always printed.
 * Every name and street here is invented.
 */

type Call = { table: string; select: string; filters: [string, string, unknown][] };
type Answer = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({
  calls: [] as { table: string; select: string; filters: [string, string, unknown][] }[],
  answer: ((_c: unknown) => ({ data: null, error: null })) as (c: { table: string; select: string; filters: [string, string, unknown][] }) => { data: unknown; error: { message: string } | null },
  reported: [] as { where: string; extra: unknown }[],
}));

/** A PostgREST-shaped chain that records what it was asked and answers per table. */
function chain(table: string) {
  const c: Call = { table, select: "", filters: [] };
  const run = () => (db.calls.push(c), db.answer(c));
  const b: Record<string, unknown> = {
    select: (cols: string) => ((c.select = cols), b),
    eq: (col: string, val: unknown) => (c.filters.push(["eq", col, val]), b),
    order: () => b,
    maybeSingle: async () => run(),
    then: (ok: (v: Answer) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (t: string) => chain(t), auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));
vi.mock("@/lib/observe", () => ({ reportError: (where: string, _e: unknown, extra?: unknown) => void db.reported.push({ where, extra }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ back: () => {}, push: () => {} }),
  usePathname: () => "/print",
}));

const PAPER = "a0000000-0000-4000-8000-0000000000aa";
const EST = "a0000000-0000-4000-8000-0000000000e1";

const PLACES = {
  job: { address: "9 Bayberry Lane", unit: null, city: "Testville", state: "CA", zip: "96161" },
  quote: { address: "40 Snowbell Court", unit: "14", city: "Testville", state: "CA", zip: "96161" },
  lead: { address: "16 Larkspur Circle", unit: null, city: "Testville", state: "CA", zip: "96161" },
  customer: { address: "12 Thistlewood Way", unit: null, city: "Testville", state: "CA", zip: "96161" },
} as const;
const NOWHERE = { address: null, unit: null, city: null, state: null, zip: null };
/** What each address prints as, one line each (lib/site-address siteLines). */
const LINES = {
  job: ["9 Bayberry Lane", "Testville, CA 96161"],
  quote: ["40 Snowbell Court", "Unit 14", "Testville, CA 96161"],
  lead: ["16 Larkspur Circle", "Testville, CA 96161"],
  customer: ["12 Thistlewood Way", "Testville, CA 96161"],
} as const;
type From = "quote" | "lead" | "customer";

/** The only columns either page may ask an estimate for: its place, its lead's and its customer's. */
const ESTIMATE_SITE = "address, unit, city, state, zip, inquiries(address, unit, city, state, zip), customers(address, unit, city, state, zip)";

/** The estimate as PostgREST hands it back for that select, each of the three with an address or without. */
const estimate = (has: Record<From, boolean>) => ({
  ...(has.quote ? PLACES.quote : NOWHERE),
  inquiries: has.lead ? PLACES.lead : NOWHERE,
  customers: has.customer ? PLACES.customer : NOWHERE,
});
/** The eight estimates: its own site, its lead's, its customer's, each there or not. */
const ESTIMATES = Array.from({ length: 8 }, (_, bits): [string, From | "none", Record<From, boolean>] => {
  const has = { quote: !!(bits & 4), lead: !!(bits & 2), customer: !!(bits & 1) };
  const there = (["quote", "lead", "customer"] as const).filter((k) => has[k]);
  return [there.length ? there.join(" + ") : "no address anywhere", there[0] ?? "none", has];
});

const ORG = { id: "org-1", name: "Testville Electric", settings: {} };
const quotesAsked = () => db.calls.filter((c) => c.table === "quotes");
const site = (lines: readonly string[]) => lines.map((l) => `<div class="text-slate-500">${l}</div>`).join("");

beforeEach(() => {
  db.calls = [];
  db.reported = [];
  db.answer = () => ({ data: null, error: null });
});

describe("/print/work-order/<id>", () => {
  /** A work order as its page reads it: every column, with its job, its customer and who it is assigned to. */
  const workOrder = (over: Record<string, unknown> = {}) => ({
    id: PAPER,
    wo_number: "WO-012",
    title: "Unit 14 panel",
    description: "Scope from E-040:\n• 1 ea — Panel swap",
    created_at: "2026-11-10T18:00:00Z",
    scheduled_for: null,
    job_id: null,
    quote_id: null,
    jobs: null,
    customers: { name: "Dana Rook", company_name: null, address: "12 Thistlewood Way", city: "Testville", state: "CA", zip: "96161", phone: "(530) 555-0100" },
    assignee: null,
    ...over,
  });
  const world = (wo: Record<string, unknown>, est: Answer = { data: null, error: null }) => (c: Call): Answer => {
    if (c.table === "work_orders") return { data: wo, error: null };
    if (c.table === "organizations") return { data: ORG, error: null };
    if (c.table === "quotes") return est;
    return { data: null, error: null };
  };
  async function render(): Promise<string> {
    const { default: Page } = await import("./work-order/[id]/page");
    return renderToStaticMarkup((await Page({ params: Promise.resolve({ id: PAPER }) })) as ReactElement);
  }
  /** The Job site block: everything between its heading and the next one. */
  const jobSite = (html: string) => html.slice(html.indexOf(">Job site</div>") + ">Job site</div>".length, html.indexOf('<div class="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Assigned to'));

  it("ON A JOB THAT HAS AN ADDRESS it prints what it always printed, and never asks the estimate", async () => {
    db.answer = world(workOrder({ job_id: "j1", quote_id: EST, jobs: { job_number: "J-031", name: "Bayberry rewire", ...PLACES.job } }), { data: estimate({ quote: true, lead: true, customer: true }), error: null });
    const html = await render();
    expect(jobSite(html)).toBe(`<div class="mt-1 text-slate-700">Bayberry rewire${site(LINES.job)}</div>`);
    expect(quotesAsked()).toEqual([]);
    expect(db.reported).toEqual([]);
  });

  it("MADE FROM NO ESTIMATE it prints what it always printed: its job's site, or a dash, and nobody else is asked", async () => {
    db.answer = world(workOrder());
    expect(jobSite(await render())).toBe('<div class="mt-1 text-slate-700">—</div>');
    // A job with no address on file: its name, and no place.
    db.answer = world(workOrder({ job_id: "j1", jobs: { job_number: "J-031", name: "Bayberry rewire", ...NOWHERE } }));
    expect(jobSite(await render())).toBe('<div class="mt-1 text-slate-700">Bayberry rewire</div>');
    expect(quotesAsked()).toEqual([]);
    // The reads are the two it always made.
    expect(db.calls.map((c) => c.table)).toEqual(["work_orders", "organizations", "work_orders", "organizations"]);
  });

  it("the work order's own read did not move: the same columns and embeds, and no estimate embedded in it", async () => {
    db.answer = world(workOrder());
    await render();
    const [first] = db.calls;
    expect(first).toEqual({
      table: "work_orders",
      select: "*, jobs(job_number, name, address, unit, city, state, zip), customers(name, company_name, address, city, state, zip, phone), assignee:assigned_to(full_name)",
      filters: [["eq", "id", PAPER]],
    });
  });

  it.each(ESTIMATES)("MADE FROM AN ESTIMATE WITH NO JOB (%s) it prints the place the estimate prints → %s", async (_name, winner, has) => {
    db.answer = world(workOrder({ quote_id: EST }), { data: estimate(has), error: null });
    const html = await render();
    // One read of the estimate, by the work order's quote_id, for address columns and nothing else.
    expect(quotesAsked()).toEqual([{ table: "quotes", select: ESTIMATE_SITE, filters: [["eq", "id", EST]] }]);
    // The address is the answer; with none anywhere, the dash it always printed.
    expect(jobSite(html)).toBe(`<div class="mt-1 text-slate-700">${winner === "none" ? "—" : site(LINES[winner])}</div>`);
    expect(db.reported).toEqual([]);
  });

  it("on a job with NO address the job is still named, and the estimate's place stands under it", async () => {
    db.answer = world(workOrder({ job_id: "j1", quote_id: EST, jobs: { job_number: "J-031", name: "Snowbell 14", ...NOWHERE } }), { data: estimate({ quote: true, lead: true, customer: true }), error: null });
    expect(jobSite(await render())).toBe(`<div class="mt-1 text-slate-700">Snowbell 14${site(LINES.quote)}</div>`);
    expect(quotesAsked()).toHaveLength(1);
  });

  it("an estimate this reader cannot see (the crew: 0056 keeps estimates in the office) prints as before, and nothing is called a failure", async () => {
    db.answer = world(workOrder({ quote_id: EST }), { data: null, error: null });
    expect(jobSite(await render())).toBe('<div class="mt-1 text-slate-700">—</div>');
    expect(db.reported).toEqual([]);
  });

  it("A READ THAT FAILS is filed, and prints no place: a blank a person can see, never another record's address", async () => {
    db.answer = world(workOrder({ quote_id: EST }), { data: null, error: { message: "quotes read failed" } });
    const html = await render();
    expect(jobSite(html)).toBe('<div class="mt-1 text-slate-700">—</div>');
    // Filed with the two ids and nothing about the customer.
    expect(db.reported).toEqual([{ where: "print.workOrder.estimateSite", extra: { workOrderId: PAPER, quoteId: EST } }]);
    // The Customer block beside it is the work order's own, as it always was.
    expect(textOf(html)).toContain("Customer Dana Rook 12 Thistlewood Way Testville, CA 96161 (530) 555-0100");
  });
});

describe("/print/material-list/<id>", () => {
  const list = (over: Record<string, unknown> = {}) => ({ name: "Unit 14 take-off", created_at: "2026-11-10T18:00:00Z", quote_id: null, jobs: null, ...over });
  const ITEMS = [{ description: "20 A breaker", part_number: "Q120", quantity: 12, unit: "ea", vendor: "Testville Supply" }];
  const world = (l: Record<string, unknown>, est: Answer = { data: null, error: null }, role = "owner") => (c: Call): Answer => {
    if (c.table === "material_lists") return { data: l, error: null };
    if (c.table === "profiles") return { data: { role }, error: null };
    if (c.table === "organizations") return { data: ORG, error: null };
    if (c.table === "quotes") return est;
    // PostgREST returns the columns named: a sheet that did not ask for the vendor is not handed one.
    if (c.table === "material_list_items") return { data: ITEMS.map((it) => (c.select.includes("vendor") ? it : { ...it, vendor: undefined })), error: null };
    return { data: null, error: null };
  };
  async function render(): Promise<string> {
    const { default: Page } = await import("./material-list/[id]/page");
    return renderToStaticMarkup((await Page({ params: Promise.resolve({ id: PAPER }) })) as ReactElement);
  }
  /** The place block (it sits between the header and the table), or "" when the sheet has none. */
  const place = (html: string) => {
    const at = html.indexOf('<div class="mt-6 text-sm">');
    return at < 0 ? "" : html.slice(at, html.indexOf('<table class="mt-6 w-full text-sm">'));
  };
  const HEAD = (word: string) => `<div class="text-xs font-semibold uppercase tracking-wide text-slate-400">${word}</div>`;

  it("ON A JOB THAT HAS AN ADDRESS it prints what it always printed, and never asks the estimate", async () => {
    db.answer = world(list({ quote_id: EST, jobs: { job_number: "J-031", name: "Bayberry rewire", ...PLACES.job } }), { data: estimate({ quote: true, lead: true, customer: true }), error: null });
    expect(place(await render())).toBe(`<div class="mt-6 text-sm">${HEAD("Job")}<div class="mt-1 text-slate-700">Bayberry rewire${site(LINES.job)}</div></div>`);
    expect(quotesAsked()).toEqual([]);
    expect(db.reported).toEqual([]);
  });

  it("MADE FROM NO ESTIMATE it prints what it always printed: its job, or no place block at all", async () => {
    db.answer = world(list());
    expect(place(await render())).toBe("");
    db.answer = world(list({ jobs: { job_number: "J-031", name: "Bayberry rewire", ...NOWHERE } }));
    expect(place(await render())).toBe(`<div class="mt-6 text-sm">${HEAD("Job")}<div class="mt-1 text-slate-700">Bayberry rewire</div></div>`);
    expect(quotesAsked()).toEqual([]);
  });

  it("the list's own read names quote_id (a column not selected is a column that cannot be followed), and no price", async () => {
    db.answer = world(list());
    await render();
    expect(db.calls.find((c) => c.table === "material_lists")).toEqual({
      table: "material_lists",
      select: "name, created_at, quote_id, jobs(job_number, name, address, unit, city, state, zip)",
      filters: [["eq", "id", PAPER]],
    });
  });

  it.each(ESTIMATES)("TAKEN OFF AN ESTIMATE WITH NO JOB (%s) it prints the place the estimate prints → %s", async (_name, winner, has) => {
    db.answer = world(list({ quote_id: EST }), { data: estimate(has), error: null });
    const html = await render();
    expect(quotesAsked()).toEqual([{ table: "quotes", select: ESTIMATE_SITE, filters: [["eq", "id", EST]] }]);
    // No job to name, so the block says what it is: the Job site. With no address anywhere, no block.
    expect(place(html)).toBe(winner === "none" ? "" : `<div class="mt-6 text-sm">${HEAD("Job site")}<div class="mt-1 text-slate-700">${site(LINES[winner])}</div></div>`);
    expect(db.reported).toEqual([]);
  });

  it("on a job with NO address the job is still named, and the estimate's place stands under it", async () => {
    db.answer = world(list({ quote_id: EST, jobs: { job_number: "J-031", name: "Snowbell 14", ...NOWHERE } }), { data: estimate({ quote: false, lead: true, customer: true }), error: null });
    expect(place(await render())).toBe(`<div class="mt-6 text-sm">${HEAD("Job")}<div class="mt-1 text-slate-700">Snowbell 14${site(LINES.lead)}</div></div>`);
  });

  it("THE CREW'S SHEET: no price is asked of anybody, the vendor column stays the office's, and an estimate the crew cannot read changes nothing", async () => {
    // A tech's read of quotes comes back empty (0056): the sheet is as it was, and nothing is filed.
    db.answer = world(list({ quote_id: EST }), { data: null, error: null }, "tech");
    const crew = await render();
    expect(place(crew)).toBe("");
    expect(db.reported).toEqual([]);
    const asked = (table: string) => db.calls.filter((c) => c.table === table).map((c) => c.select);
    // The role-dependent select is as it was: the crew's never names the vendor.
    expect(asked("material_list_items")).toEqual(["description, part_number, quantity, unit"]);
    expect(crew).not.toContain("Testville Supply");
    // Whoever is reading, the estimate is asked for addresses only: every word in its select is one of these.
    const words = new Set(asked("quotes").join(" ").match(/\w+/g));
    expect([...words].sort()).toEqual(["address", "city", "customers", "inquiries", "state", "unit", "zip"]);
    for (const select of db.calls.map((c) => c.select)) expect(select).not.toMatch(/price|cost|total|rate|markup|amount/);
    // The office's sheet keeps its vendor column.
    db.calls = [];
    db.answer = world(list({ quote_id: EST }), { data: estimate({ quote: true, lead: false, customer: false }), error: null }, "owner");
    const office = await render();
    expect(asked("material_list_items")).toEqual(["description, part_number, quantity, unit, vendor"]);
    expect(office).toContain("Testville Supply");
    expect(place(office)).toContain(site(LINES.quote));
  });

  it("A READ THAT FAILS is filed, and prints no place: never another record's address", async () => {
    db.answer = world(list({ quote_id: EST }), { data: null, error: { message: "quotes read failed" } });
    const html = await render();
    expect(place(html)).toBe("");
    expect(db.reported).toEqual([{ where: "print.materialList.estimateSite", extra: { listId: PAPER, quoteId: EST } }]);
    // The list itself is whole.
    expect(textOf(html)).toContain("20 A breaker");
  });
});

describe("both pages: the one order, and address columns only", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it.each(["src/app/print/work-order/[id]/page.tsx", "src/app/print/material-list/[id]/page.tsx"])("%s", (file) => {
    const src = read(file);
    // The candidates come from the one rule; the page keeps no list of its own.
    expect(src).toContain('import { bornFromEstimateCandidates } from "@/lib/quote-site";');
    expect(src).not.toMatch(/pickSite\(\s*\[/);
    // The estimate is read through SITE_COLS three times over and through nothing else.
    expect(src).toContain('.select(`${SITE_COLS}, inquiries(${SITE_COLS}), customers(${SITE_COLS})`)');
    expect(src.match(/from\("quotes"\)/g)).toHaveLength(1);
    // A page file exports the page, its metadata and its segment config, and nothing else.
    expect([...src.matchAll(/^export (?:default )?(?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]).sort()).toEqual(
      [file.includes("work-order") ? "WorkOrderPrintPage" : "MaterialListPrintPage", "dynamic", "generateMetadata"].sort(),
    );
  });

  it("written out, that select is fifteen address columns: the estimate's five, its lead's, its customer's", () => {
    expect(`${SITE_COLS}, inquiries(${SITE_COLS}), customers(${SITE_COLS})`).toBe(ESTIMATE_SITE);
  });
});
