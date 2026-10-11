import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fakeDb, type Row } from "../src/test/fake-supabase";
import { takeOffFromQuote } from "../src/lib/estimate/take-off-from-quote";
import { workOrderFromQuote } from "../src/lib/estimate/work-order-from-quote";
import { revisionOf } from "../src/lib/estimate/revision";
import { closingsFor } from "../src/lib/appointments/behind-quote";
import { materialsWords, planPartSync, syncQuoteMaterials, type KeyedPart } from "../src/lib/estimate/sync-job-materials";
import { discountRowLabel } from "../src/lib/invoice-math";

/**
 * THE SECOND VERIFY ROUND over audit v1085's carried findings (2026-10-11, 5 sonnet verifiers against
 * cn-v1086): the ones fixed in cn-v1087. Behavioural on the fake DB where the rule takes the client it is
 * given; a source pin where the door is a server action. Names are stand-ins ("Bayberry").
 */
const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const ORG = "org-1";
const BOOK = [{ org_id: ORG, code: "STP", description: "Staples", supplier: "Northline Supply", buy_price: 4, unit: "box", archived: false, price_list_item_options: [] }];
const line = (quote_id: string, id: string, description: string, quantity: number): Row => ({ id, quote_id, org_id: ORG, description, quantity, unit: "ea", unit_price: 10, sort_order: 0, detail: null });
const quote = (id: string, status: string, extra: Record<string, unknown> = {}): Row => ({ id, quote_number: id.toUpperCase(), job_id: "job-1", status, org_id: ORG, revises_quote_id: null, title: "Deck", customer_id: null, ...extra });
const world = (t: Record<string, Row[]>) =>
  fakeDb({ material_lists: [], material_list_items: [], work_orders: [], quote_line_items: [], price_list_items: BOOK, organizations: [{ id: ORG, settings: { default_markup_pct: 25 } }], customers: [], kits: [], ...t });

describe("the take-off (carried [22], [29], [23], [36], [35])", () => {
  it("[22] an estimate's existing job-less list is linked to the job the estimate got (compare-and-set on null), and a second run is a no-op", async () => {
    const db = world({ quotes: [quote("q1", "accepted")], material_lists: [{ id: "ml", quote_id: "q1", job_id: null, org_id: ORG, created_at: "2026-10-01" }], quote_line_items: [line("q1", "l1", "Staples [STP]", 3)] });
    const res = await takeOffFromQuote(db.sb, { quoteId: "q1", userId: "u", orgId: null });
    expect(res).toMatchObject({ ok: true, id: "ml", jobId: "job-1" });
    expect(db.tables.material_lists[0].job_id).toBe("job-1");
    expect(db.inserted.material_lists).toBeUndefined();
    expect((await takeOffFromQuote(db.sb, { quoteId: "q1", userId: "u", orgId: null })).id).toBe("ml");
  });
  it("[29] a revision of a still-sent revision adopts the crew's list held by the FIRST estimate (the chain is walked)", async () => {
    const db = world({
      quotes: [quote("q41", "superseded"), quote("q43", "superseded", { revises_quote_id: "q41" }), quote("q44", "accepted", { revises_quote_id: "q43" })],
      material_lists: [{ id: "ml41", quote_id: "q41", job_id: "job-1", org_id: ORG, created_at: "2026-10-01" }],
      material_list_items: [{ id: "b", list_id: "ml41", org_id: ORG, source_key: "line:old#STP", description: "Staples", part_number: "STP", quantity: 3, purchased: true, is_tool: false, sort_order: 0 }],
      quote_line_items: [line("q41", "o1", "Staples [STP]", 3), line("q44", "r1", "Staples [STP]", 3)],
    });
    const res = await takeOffFromQuote(db.sb, { quoteId: "q44", userId: "u", orgId: null });
    expect(res).toMatchObject({ ok: true, id: "ml41", adopted: true });
    expect(db.tables.material_lists[0].quote_id).toBe("q44");
    expect(db.inserted.material_lists).toBeUndefined(); // no second list: the bought marks stay where the crew made them
    // the FIRST estimate's own plain row follows the revision at the end of the chain (its lines name the row)
    const chain = world({
      quotes: [quote("q41", "superseded"), quote("q43", "superseded", { revises_quote_id: "q41" }), quote("q44", "accepted", { revises_quote_id: "q43" })],
      material_lists: [{ id: "ml41", quote_id: "q41", job_id: "job-1", org_id: ORG, created_at: "2026-10-01" }],
      material_list_items: [{ id: "s", list_id: "ml41", org_id: ORG, source_key: null, description: "Staples", part_number: "STP", quantity: 3, purchased: false, is_tool: false, sort_order: 0 }],
      quote_line_items: [line("q41", "o1", "Staples [STP]", 3), line("q44", "r1", "Staples [STP]", 9)],
    });
    expect((await takeOffFromQuote(chain.sb, { quoteId: "q44", userId: "u", orgId: null })).follow).toMatchObject({ recounted: ["Staples 3 → 9"] });
    expect(chain.tables.material_list_items[0].quantity).toBe(9);
  });
  it("[29] a SIBLING revision (the skeptic's case): R1 accepted and holding the crew's list, then R2 accepted — R2 adopts R1's list, bought marks and all", async () => {
    const db = world({
      quotes: [quote("o", "superseded"), quote("r1", "superseded", { revises_quote_id: "o" }), quote("r2", "accepted", { revises_quote_id: "o" })],
      material_lists: [{ id: "ml-r1", quote_id: "r1", job_id: "job-1", org_id: ORG, created_at: "2026-10-02" }],
      material_list_items: [{ id: "b", list_id: "ml-r1", org_id: ORG, source_key: null, description: "Staples", part_number: "STP", quantity: 3, purchased: true, is_tool: false, sort_order: 0 }],
      quote_line_items: [line("r1", "a", "Staples [STP]", 3), line("r2", "b", "Staples [STP]", 3)],
    });
    const res = await takeOffFromQuote(db.sb, { quoteId: "r2", userId: "u", orgId: null });
    expect(res).toMatchObject({ ok: true, id: "ml-r1", adopted: true, follow: { carried: 1 } });
    expect(db.tables.material_lists[0].quote_id).toBe("r2");
    expect(db.inserted.material_lists).toBeUndefined();
  });
  it("[29] a failed read up the chain takes nothing off and adopts nothing (said, the way the original's lines read is)", async () => {
    const db = world({
      quotes: [quote("q41", "superseded"), quote("q43", "superseded", { revises_quote_id: "q41" }), quote("q44", "accepted", { revises_quote_id: "q43" })],
      material_lists: [{ id: "ml41", quote_id: "q41", job_id: "job-1", org_id: ORG, created_at: "2026-10-01" }],
      quote_line_items: [line("q44", "r1", "Staples [STP]", 9)],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken: any = {
      from: (t: string) => {
        if (t !== "quotes") return db.sb.from(t);
        const real = db.sb.from(t);
        return { select: (cols: string) => (cols === "revises_quote_id" ? { eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "timeout" } }) }) } : real.select(cols)) };
      },
    };
    const res = await takeOffFromQuote(broken, { quoteId: "q44", userId: "u", orgId: null });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("could not be read") });
    expect(db.tables.material_lists[0].quote_id).toBe("q41");
    expect(db.inserted.material_lists).toBeUndefined();
  });
  it("[23] a catalog company's kit groups ARE seeded when an accepted estimate adopts the job's own (visit) list, after the crew's rows; [36] a task kit (hours per unit) never lands on the buy list", async () => {
    const kits = [
      { id: "k1", org_id: ORG, name: "Framing", labor_minutes: null, kit_items: [{ description: "Joist hanger", quantity: 10, unit: "ea", unit_price: 2, sort_order: 0 }] },
      { id: "k2", org_id: ORG, name: "Footing", labor_minutes: 60, kit_items: [{ description: "Concrete", quantity: 1, unit: "bag", unit_price: 8, sort_order: 0 }] },
    ];
    const db = world({
      quotes: [quote("q1", "accepted")],
      organizations: [{ id: ORG, settings: { default_markup_pct: 25, estimating_mode: "catalog" } }],
      kits,
      material_lists: [{ id: "ml-visit", quote_id: null, job_id: "job-1", org_id: ORG, created_at: "2026-10-01" }],
      material_list_items: [{ id: "h", list_id: "ml-visit", org_id: ORG, source_key: null, description: "Gloves", part_number: null, quantity: 1, purchased: false, is_tool: false, sort_order: 0 }],
      quote_line_items: [line("q1", "l1", "Staples [STP]", 3)],
    });
    const res = await takeOffFromQuote(db.sb, { quoteId: "q1", userId: "u", orgId: null });
    expect(res).toMatchObject({ ok: true, adopted: true });
    const got = db.inserted.material_list_items.map((r) => r.description);
    expect(got).toContain("Framing — Joist hanger");
    expect(got).not.toContain("Footing — Concrete");
    expect(Math.min(...db.inserted.material_list_items.map((r) => r.sort_order))).toBe(1); // after the crew's row
    // a list adopted from the ORIGINAL estimate keeps the groups it has
    const rev = world({
      quotes: [quote("q-orig", "superseded"), quote("q-rev", "accepted", { revises_quote_id: "q-orig" })],
      organizations: [{ id: ORG, settings: { default_markup_pct: 25, estimating_mode: "catalog" } }],
      kits,
      material_lists: [{ id: "ml-orig", quote_id: "q-orig", job_id: "job-1", org_id: ORG, created_at: "2026-10-01" }],
      quote_line_items: [line("q-rev", "r1", "Staples [STP]", 3)],
    });
    await takeOffFromQuote(rev.sb, { quoteId: "q-rev", userId: "u", orgId: null });
    expect((rev.inserted.material_list_items ?? []).map((r) => r.description)).toEqual(["Staples"]);
  });
  it("[35] a replaced estimate, or a revision not yet accepted, makes no list and no work order — said with the one door; the pages hide the Create doors", async () => {
    const db = world({ quotes: [quote("q-old", "superseded"), quote("q-draft", "draft", { revises_quote_id: "q-old" })], quote_line_items: [line("q-old", "a", "Staples [STP]", 1), line("q-draft", "b", "Staples [STP]", 1)] });
    expect(await takeOffFromQuote(db.sb, { quoteId: "q-old", userId: "u", orgId: null })).toMatchObject({ ok: false, error: expect.stringContaining("replaced by a revision") });
    expect(await takeOffFromQuote(db.sb, { quoteId: "q-draft", userId: "u", orgId: null })).toMatchObject({ ok: false, error: expect.stringContaining("isn't accepted yet") });
    expect(await workOrderFromQuote(db.sb, { quoteId: "q-old", userId: "u", orgId: null })).toMatchObject({ ok: false, error: expect.stringContaining("replaced by a revision") });
    expect(await workOrderFromQuote(db.sb, { quoteId: "q-draft", userId: "u", orgId: null })).toMatchObject({ ok: false, error: expect.stringContaining("isn't accepted yet") });
    expect(db.inserted.material_lists).toBeUndefined();
    expect(db.inserted.work_orders).toBeUndefined();
    const page = src("src/app/(app)/quotes/[id]/page.tsx");
    expect(page).toContain('const replaced = q.status === "superseded";');
    expect(page).toContain("const noPaperYet = replaced ||");
    const quotes = src("src/app/(app)/quotes/actions.ts");
    expect(quotes).toContain('if ((q as { status?: string }).status === "superseded") {'); // createJobFromQuote refuses too
  });
});

describe("the revision that replaced an estimate is the TIP of the chain (carried [26]/[30])", () => {
  const q = (id: string, status: string, revises: string | null, accepted_at: string | null) => ({ id, quote_number: id.toUpperCase(), status, revises_quote_id: revises, accepted_at, org_id: ORG });
  it("A revised by B, B revised by C (accepted): A's standing revision is C, not the superseded B", async () => {
    const { sb } = fakeDb({ quotes: [q("a", "superseded", null, "2026-10-01"), q("b", "superseded", "a", "2026-10-02"), q("c", "accepted", "b", "2026-10-03")] });
    expect(await revisionOf(sb, { quoteId: "a", orgId: ORG })).toMatchObject({ id: "c", quote_number: "C" });
    expect(await revisionOf(sb, { quoteId: "b", orgId: ORG })).toMatchObject({ id: "c" });
    expect(await revisionOf(sb, { quoteId: "c", orgId: ORG })).toBeNull();
  });
  it("a chain that ends on a superseded estimate with nothing above it names that one (the next door); a cycle stops", async () => {
    const { sb } = fakeDb({ quotes: [q("a", "superseded", null, "2026-10-01"), q("b", "superseded", "a", "2026-10-02")] });
    expect(await revisionOf(sb, { quoteId: "a", orgId: ORG })).toMatchObject({ id: "b" });
    const loop = fakeDb({ quotes: [q("a", "superseded", "b", "2026-10-01"), q("b", "superseded", "a", "2026-10-02")] });
    expect(await revisionOf(loop.sb, { quoteId: "a", orgId: ORG })).toMatchObject({ id: "b" });
  });
});

describe("a revision's decline decides no visit, and a job day is never Lost (carried [28])", () => {
  it("closingsFor stamps the outcome only on a visit that can be won or lost", () => {
    const rows = [
      { id: "insp", job_id: null, outcome: null, type: "inspection" },
      { id: "untyped", job_id: null, outcome: null },
      { id: "day", job_id: "job-1", outcome: null, type: "job" },
      { id: "call", job_id: "job-1", outcome: null, type: "service_call" },
      { id: "done", job_id: null, outcome: "won", type: "inspection" },
    ];
    expect(closingsFor(rows, { outcome: "lost" }).stamp).toEqual(["insp", "untyped"]);
    expect(closingsFor(rows, { jobId: "job-2" }).attach).toEqual(["insp", "untyped", "done"]);
  });
  it("updateQuoteStatus passes no outcome for a revision that is not accepted, and reads the type to stamp", () => {
    const quotes = src("src/app/(app)/quotes/actions.ts");
    expect(quotes).toContain('const outcome = revisesId && status !== "accepted" ? null : outcomeForQuoteStatus(status);');
    expect(src("src/lib/appointments/behind-quote.ts")).toContain('.select("id, job_id, outcome, type")');
  });
});

describe("a 'how many?' row takes the count the estimate later gives it (carried [21])", () => {
  const part = (key: string, qty: number | null): KeyedPart => ({ key, code: null, name: "Bayberry clips", qty, cost: null });
  it("the plan fills only the untouched placeholder (count 1, not his); a typed count or a bought row is said instead", () => {
    const ph = { id: "p", source_key: "line:l#bayberry-clips", description: "Bayberry clips · how many?", part_number: null, quantity: 1, purchased: false, is_tool: false };
    expect(planPartSync([part("line:l#bayberry-clips", 12)], [ph]).fill).toEqual([{ id: "p", description: "Bayberry clips", qty: 12 }]);
    expect(planPartSync([part("line:l#bayberry-clips", 12)], [{ ...ph, quantity: 8 }])).toMatchObject({ fill: [], countsDiffer: [{ description: "Bayberry clips · how many?", shows: 8, estimate: 12 }] });
    expect(planPartSync([part("line:l#bayberry-clips", 12)], [{ ...ph, purchased: true }])).toMatchObject({ fill: [], countsDiffer: [{ shows: 1, estimate: 12 }] });
    expect(planPartSync([part("line:l#bayberry-clips", null)], [ph])).toMatchObject({ fill: [], countsDiffer: [] }); // still asking: nothing to fill
    expect(planPartSync([part("line:l#bayberry-clips", 1)], [ph])).toMatchObject({ fill: [], countsDiffer: [] });
  });
  it("the sync writes the count and the words, conditional on the row still being the placeholder, and says it", async () => {
    const taskLine = { id: "l", quote_id: "q1", org_id: ORG, description: "Install clips", quantity: 1, unit: "ea", unit_price: 100, sort_order: 0, detail: { task_id: "t", hours: 1, rate: 100, units: null, kit_id: null, materials: [{ code: null, name: "Bayberry clips", qty: 12, cost: null, sell: null }] } };
    const db = world({
      quotes: [quote("q1", "accepted")],
      material_lists: [{ id: "ml", quote_id: "q1", job_id: "job-1", org_id: ORG, dismissed_keys: [] }],
      material_list_items: [{ id: "p", list_id: "ml", org_id: ORG, source_key: "line:l#bayberry-clips", description: "Bayberry clips · how many?", part_number: null, quantity: 1, purchased: false, is_tool: false, vendor: null, est_cost: null, unit: "ea", sort_order: 0 }],
      quote_line_items: [taskLine],
    });
    const res = await syncQuoteMaterials(db.sb, { quoteId: "q1", jobId: "job-1", orgId: null, userId: "u" });
    expect(res).toMatchObject({ filled: ["Bayberry clips"], countsDiffer: [], inserted: 0 });
    expect(db.tables.material_list_items[0]).toMatchObject({ quantity: 12, description: "Bayberry clips" });
    expect(materialsWords(res)).toBe("The estimate's materials list follows too: 1 count filled in (Bayberry clips).");
  });
});

describe("the words and the doors (carried [16], [15], [38], [9], [43], [1], [19], [20], [7], [41], [3])", () => {
  it("[16] the job's length is said only when the box and the estimate differ", () => {
    expect(src("src/lib/estimate/sync-job-tasks.ts")).toContain("return boxNow === est.minutes ? done : { ...done, sizeStays: { box: boxNow, estimate: est.minutes } };");
  });
  it("[15] deleteTask never writes a dismissal list it could not read", () => {
    const tasks = src("src/app/(app)/tasks/actions.ts");
    expect(tasks).toContain("const { data: job, error: jobErr } = await supabase.from(\"jobs\").select(\"dismissed_task_keys\")");
    expect(tasks).toContain("if (jobErr || !job) {");
  });
  it("[38] the service client scopes the job's task keys, the rekey and the orphan delete to the company", () => {
    expect(src("src/lib/estimate/born-with-tasks.ts")).toContain("async function keysOnJob(sb: SupabaseClient, jobId: string, orgId: string | null = null)");
    const sync = src("src/lib/estimate/sync-job-tasks.ts");
    expect(sync).toContain('if (who.orgId) rq = rq.eq("org_id", who.orgId);');
    expect(sync).toContain('if (who.orgId) dq = dq.eq("org_id", who.orgId);');
  });
  it("[9] a copy and a revision keep the scope description; [43] a failed cleanup of a half-made revision is said", () => {
    const quotes = src("src/app/(app)/quotes/actions.ts");
    expect(quotes).toContain('.select("customer_id, title, description, notes, tax_rate, valid_until, doc_type, circuits, job_id, inquiry_id, status")');
    expect(quotes).toContain("description: (quote as { description?: string | null }).description ?? null,");
    expect(quotes).toContain('const { data: gone, error: dErr } = await supabase.from("quotes").delete().eq("id", res.id).eq("status", "draft").select("id");');
  });
  it("[1] walking an accepted revision back names the estimate it leaves superseded; [19] a revision pinned at acceptance has the figure before read first; [20] both Accept branches keep the paperwork's results", () => {
    const quotes = src("src/app/(app)/quotes/actions.ts");
    expect(quotes).toContain("was replaced by this estimate and now stands replaced by nothing — set it back to Accepted");
    expect(quotes).toContain("const est = await estimateLines(supabase, { jobId: origJob, orgId: ctx.orgId });");
    expect(quotes.match(/paperworkNote\(wo, list\)/g)).toHaveLength(2);
    expect(quotes).not.toContain("Open Work Orders to add it.` : null"); // a rule's own refusal passes through: one action, not two
    expect(src("src/app/q/[token]/actions.ts")).toContain("await notifyQuoteAccepted(token, listSaid);"); // the customer's Accept: the office hears what the list did
    expect(src("src/components/section-actions-menu.tsx")).toContain("(res as { note?: string }).note, res.error]) if (w) toast(w, \"info\");");
  });
  it("[7] the portal ledger hands lineGroup the line total, so a discount files as a discount", () => {
    expect(src("src/lib/portal/stretch-ledger.ts")).toContain("line_kind: ln.line_kind ?? null, line_total: ln.line_total }");
  });
  it("[41] one wording for a discount row on the office card and the customer's paper", () => {
    expect(discountRowLabel("Discount for a repeat customer")).toBe("Discount for a repeat customer");
    expect(discountRowLabel("traded for the deck boards")).toBe("Discount — traded for the deck boards");
    expect(discountRowLabel("")).toBe("Discount");
    expect(discountRowLabel(null)).toBe("Discount");
    expect(src("src/components/doc-templates.tsx")).toContain("{discountRowLabel(d.label)}");
    expect(src("src/app/(app)/billing/[id]/invoice-detail.tsx")).toContain("{discountRowLabel(d.label)}");
  });
  it("[3] From Estimate on an invoice with no estimate takes the job's contract, never a declined, expired, superseded or draft-revision paper", () => {
    const billing = src("src/app/(app)/billing/actions.ts");
    expect(billing).toContain('const live = ((qs ?? []) as Array<{ id: string; status: string | null }>).filter((x) => isLiveQuote(x.status) && x.status !== "draft");');
    expect(billing).toContain("if (qsErr) return { ok: false, error: dbError(qsErr) };");
    expect(billing).toContain('quoteId = (live.find((x) => x.status === "accepted") ?? live[0])?.id ?? null;');
  });
});
