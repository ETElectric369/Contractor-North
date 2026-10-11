import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fakeDb } from "../src/test/fake-supabase";
import { budgetQuoteIds, getJobBudgetByCategory } from "../src/lib/analytics/job-profitability";
import { readPriceBook, takeOffFromQuote } from "../src/lib/estimate/take-off-from-quote";
import { syncQuoteMaterials } from "../src/lib/estimate/sync-job-materials";
import { revisedOriginalBilled } from "../src/lib/billing/revision-billed";

/**
 * AUDIT v1085 FIX WAVE (2026-10-11): six classes, one rule each. Names are stand-ins ("Bayberry"),
 * never a customer's.
 */
const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const ORG = "org-1";

describe("class 1 — the revision family is billed once", () => {
  type Owner = Map<string, { id: string; invoice_number: string | null }>;
  const claims = (owner: Owner = new Map()) => ({ claims: async () => ({ owner }) });
  const family = (invoices: Record<string, unknown>[] = []) =>
    fakeDb({
      quotes: [
        { id: "A", org_id: ORG, quote_number: "Q-0040", status: "superseded", revises_quote_id: null, job_id: "J1" },
        { id: "B", org_id: ORG, quote_number: "Q-0041", status: "superseded", revises_quote_id: "A", job_id: "J1" },
        { id: "C", org_id: ORG, quote_number: "Q-0043", status: "accepted", revises_quote_id: "B", job_id: "J1" },
        { id: "CO", org_id: ORG, quote_number: "Q-0050", status: "accepted", revises_quote_id: null, job_id: "J1" }, // a change order
      ],
      quote_line_items: [{ id: "A-l1", quote_id: "A" }, { id: "B-l1", quote_id: "B" }, { id: "C-l1", quote_id: "C" }],
      invoices,
    });
  it("refuses billing C when A (two hops up) was billed by an invoice cut from it", async () => {
    const { sb } = family([{ id: "I1", invoice_number: "INV-0010", status: "sent", quote_id: "A", job_id: "J1" }]);
    expect(await revisedOriginalBilled(sb, { revises_quote_id: "B", job_id: "J1" }, undefined, claims())).toBe("Q-0040 is already billed on INV-0010 — add the change to that invoice instead.");
  });
  it("refuses when A was billed through From Estimate (quote_id null; the claim is on the line) — through THE claims reader, even before the revision has a job", async () => {
    const { sb } = family([{ id: "I2", invoice_number: "INV-0011", status: "partial", quote_id: null, job_id: "J1" }]);
    const owner: Owner = new Map([["A-l1", { id: "I2", invoice_number: "INV-0011" }]]);
    expect(await revisedOriginalBilled(sb, { revises_quote_id: "B", job_id: "J1" }, undefined, claims(owner))).toBe("Q-0040 is already billed on INV-0011 — add the change to that invoice instead.");
    expect(await revisedOriginalBilled(sb, { revises_quote_id: "B", job_id: null }, undefined, claims(owner))).toBe("Q-0040 is already billed on INV-0011 — add the change to that invoice instead.");
  });
  it("a void invoice does not count; the invoice being worked on is left out; a change order is still billable", async () => {
    const { sb } = family([{ id: "I3", invoice_number: "INV-0012", status: "void", quote_id: "A", job_id: "J1" }]);
    expect(await revisedOriginalBilled(sb, { revises_quote_id: "B", job_id: "J1" }, undefined, claims())).toBeNull();
    const live = family([{ id: "I4", invoice_number: "INV-0013", status: "sent", quote_id: "A", job_id: "J1" }]);
    expect(await revisedOriginalBilled(live.sb, { revises_quote_id: "B", job_id: "J1" }, "I4", claims())).toBeNull();
    const owned: Owner = new Map([["A-l1", { id: "I4", invoice_number: "INV-0013" }]]);
    expect(await revisedOriginalBilled(live.sb, { revises_quote_id: "B", job_id: "J1" }, "I4", claims(owned))).toBeNull(); // the claim is the invoice being worked on
    expect(await revisedOriginalBilled(live.sb, { revises_quote_id: null, job_id: "J1" }, undefined, claims())).toBeNull(); // Q-0050 revises nothing
  });
  it("fails CLOSED: a read that errors, or a claims reader that throws, refuses the bill", async () => {
    const { sb } = family([{ id: "I1", invoice_number: "INV-0010", status: "sent", quote_id: "A", job_id: "J1" }]);
    const broken = { from: (t: string) => (t === "invoices" ? { select: () => ({ in: () => ({ neq: () => Promise.resolve({ data: null, error: { message: "timeout" } }) }) }) } : sb.from(t)) } as never;
    expect(await revisedOriginalBilled(broken, { revises_quote_id: "B", job_id: "J1" }, undefined, claims())).toContain("could not be read");
    const clean = family();
    const throwing = { claims: async () => { throw new Error("overlaps timed out"); } };
    expect(await revisedOriginalBilled(clean.sb, { revises_quote_id: "B", job_id: "J1" }, undefined, throwing)).toContain("could not be read");
  });
  it("the doors: a SUPERSEDED estimate is refused only while its revision stands, naming it; From Estimate on the original's invoice follows to the revision", () => {
    const billing = src("src/app/(app)/billing/actions.ts");
    expect(billing).toContain("async function standingRevision(");
    expect(billing).toContain('if ("error" in standing) return { ok: false, error: standing.error };');
    expect(billing).toContain("if (standing.rev) return { ok: false, error: `${(quote as { quote_number?: string | null }).quote_number ?? \"This estimate\"} was replaced by ${standing.rev.quote_number ?? \"its revision\"} — bill from that one.` };");
    expect(billing).toContain("quoteId = standing.rev.id;"); // the import door follows, never a dead end
    expect(billing).not.toContain("— import from that one.");
  });
});

describe("class 5 — one contract rule for the budget reader", () => {
  it("the accepted estimates, else the newest sent; never a draft, declined, expired or superseded one", () => {
    expect(budgetQuoteIds([{ id: "a", status: "accepted" }, { id: "d", status: "draft" }, { id: "s", status: "superseded" }, { id: "co", status: "accepted" }])).toEqual(["a", "co"]);
    expect(budgetQuoteIds([{ id: "old", status: "sent", created_at: "2026-10-01" }, { id: "new", status: "sent", created_at: "2026-10-05" }, { id: "d", status: "draft" }])).toEqual(["new"]);
    expect(budgetQuoteIds([{ id: "d", status: "draft" }, { id: "x", status: "declined" }])).toEqual([]);
  });
  it("a draft revision does not move the budget; after acceptance only the revision counts", async () => {
    const { sb, tables } = fakeDb({
      quotes: [
        { id: "q41", job_id: "J1", status: "accepted", created_at: "2026-10-01" },
        { id: "q43", job_id: "J1", status: "draft", created_at: "2026-10-05" },
      ],
      quote_line_items: [
        { quote_id: "q41", category: "Framing", line_total: 8000, unit: "ea", description: "Framing" },
        { quote_id: "q41", category: "Labor", line_total: 4000, unit: "hr", description: "Labor" },
        { quote_id: "q43", category: "Framing", line_total: 9000, unit: "ea", description: "Framing" },
        { quote_id: "q43", category: "Labor", line_total: 4500, unit: "hr", description: "Labor" },
      ],
    });
    expect(await getJobBudgetByCategory(sb, "J1")).toEqual([{ category: "Framing", budget: 8000 }, { category: "Labor", budget: 4000 }]);
    tables.quotes[1].status = "accepted";
    tables.quotes[0].status = "superseded";
    expect(await getJobBudgetByCategory(sb, "J1")).toEqual([{ category: "Framing", budget: 9000 }, { category: "Labor", budget: 4500 }]);
  });
});

const BOOK = [{ id: "pl1", org_id: ORG, code: "R1", description: "Transfer switch, 200A", supplier: "Northline Supply", buy_price: 400, unit: "ea", archived: false, price_list_item_options: [] }];
const taskLine = (id: string, materials: unknown[]) => ({
  id, quote_id: "q-1", org_id: ORG, description: "Install", quantity: 1, unit: "ea", unit_price: 999, sort_order: 0,
  detail: { task_id: `t-${id}`, hours: 2, rate: 100, units: null, kit_id: null, materials },
});
const listWorld = (rows: Record<string, unknown>[], lines?: Record<string, unknown>[]) =>
  fakeDb({
    quotes: [{ id: "q-1", quote_number: "Q-1", job_id: "job-1", status: "accepted", org_id: ORG, accepted_at: "2026-10-10", created_at: "2026-10-09" }],
    material_lists: [{ id: "ml-1", quote_id: "q-1", job_id: "job-1", org_id: ORG, dismissed_keys: [] }],
    quote_line_items: lines ?? [taskLine("l1", [{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 500 }])],
    material_list_items: rows,
    price_list_items: BOOK,
    organizations: [{ id: ORG, settings: { default_markup_pct: 25 } }],
  });
const WHO = { quoteId: "q-1", jobId: "job-1", orgId: ORG, userId: "u1" };

describe("class 3 — a part claimed from a visit takes the book's price, vendor and unit, blanks only", () => {
  it("a visit row with no vendor or cost ends priced like a fresh take-off row; a value someone set stays", async () => {
    const { sb, tables } = listWorld([
      { id: "v", list_id: "ml-1", org_id: ORG, source_key: "task:t-l1#R1", description: "Transfer switch, 200A", part_number: "R1", quantity: 1, purchased: false, is_tool: false, vendor: null, est_cost: null, unit: "ea", sort_order: 0 },
    ]);
    const res = await syncQuoteMaterials(sb, WHO);
    expect(res).toMatchObject({ rekeyed: 1, inserted: 0 });
    const row = tables.material_list_items.find((r) => r.id === "v")!;
    expect(row).toMatchObject({ source_key: "line:l1#R1", vendor: "Northline Supply", est_cost: 400 });
    const priced = listWorld([
      { id: "v", list_id: "ml-1", org_id: ORG, source_key: "task:t-l1#R1", description: "Transfer switch, 200A", part_number: "R1", quantity: 1, purchased: false, is_tool: false, vendor: "Erik's shelf", est_cost: 12, unit: "ea", sort_order: 0 },
    ]);
    await syncQuoteMaterials(priced.sb, WHO);
    expect(priced.tables.material_list_items[0]).toMatchObject({ vendor: "Erik's shelf", est_cost: 12 });
  });
  it("the unit rides only with the cost it prices: a row priced by hand keeps its unit when only the vendor is filled", async () => {
    const byFoot = [{ id: "pl2", org_id: ORG, code: "W12", description: "12 AWG wire", supplier: "Northline Supply", buy_price: 0.5, unit: "ft", archived: false, price_list_item_options: [] }];
    const db = fakeDb({
      quotes: [{ id: "q-1", quote_number: "Q-1", job_id: "job-1", status: "accepted", org_id: ORG, accepted_at: "2026-10-10", created_at: "2026-10-09" }],
      material_lists: [{ id: "ml-1", quote_id: "q-1", job_id: "job-1", org_id: ORG, dismissed_keys: [] }],
      quote_line_items: [taskLine("l1", [{ code: "W12", name: "12 AWG wire", qty: 2, cost: null, sell: null }])],
      material_list_items: [{ id: "v", list_id: "ml-1", org_id: ORG, source_key: "task:t-l1#W12", description: "12 AWG wire", part_number: "W12", quantity: 2, purchased: false, is_tool: false, vendor: null, est_cost: 45, unit: "ea", sort_order: 0 }],
      price_list_items: byFoot,
      organizations: [{ id: ORG, settings: {} }],
    });
    await syncQuoteMaterials(db.sb, WHO);
    expect(db.tables.material_list_items[0]).toMatchObject({ vendor: "Northline Supply", est_cost: 45, unit: "ea" }); // a $45 roll stays "2 ea"
  });
});

describe("class 2 (the safe half) — the estimate's own plain-line rows are not hand rows", () => {
  it("a task part with the same code as a plain line gets its own row; the plain row is untouched", async () => {
    const { sb, tables, inserted } = listWorld(
      [{ id: "plain", list_id: "ml-1", org_id: ORG, source_key: null, description: "Transfer switch, 200A", part_number: "R1", quantity: 10, purchased: false, is_tool: false, vendor: null, est_cost: null, unit: "ea", sort_order: 0 }],
      [
        { id: "p1", quote_id: "q-1", org_id: ORG, description: "Transfer switch, 200A [R1]", quantity: 10, unit: "ea", unit_price: 500, sort_order: 0, detail: null },
        taskLine("l1", [{ code: "R1", name: "Transfer switch, 200A", qty: 3, cost: 400, sell: 500 }]),
      ],
    );
    const res = await syncQuoteMaterials(sb, WHO);
    expect(res).toMatchObject({ inserted: 1, rekeyed: 0 });
    expect(tables.material_list_items.find((r) => r.id === "plain")).toMatchObject({ source_key: null, quantity: 10 });
    expect(inserted.material_list_items.map((r) => [r.source_key, r.quantity])).toEqual([["line:l1#R1", 3]]);
  });
  it("a plain line the take-off matched through the BOOK (no bracket, or a last-token code) is recognised the same way; a labor line owns no row", async () => {
    const { sb, tables, inserted } = listWorld(
      [{ id: "plain", list_id: "ml-1", org_id: ORG, source_key: null, description: "Transfer switch, 200A", part_number: "R1", quantity: 10, purchased: false, is_tool: false, vendor: null, est_cost: null, unit: "ea", sort_order: 0 }],
      [
        { id: "p1", quote_id: "q-1", org_id: ORG, description: "Transfer switch, 200A", quantity: 10, unit: "ea", unit_price: 500, sort_order: 0, detail: null }, // no bracket: the book named R1
        { id: "lab", quote_id: "q-1", org_id: ORG, description: "Labor — rough-in", quantity: 4, unit: "hr", unit_price: 120, sort_order: 1, detail: null },
        taskLine("l1", [{ code: "R1", name: "Transfer switch, 200A", qty: 3, cost: 400, sell: 500 }]),
      ],
    );
    const res = await syncQuoteMaterials(sb, WHO);
    expect(res).toMatchObject({ inserted: 1, rekeyed: 0 });
    expect(tables.material_list_items.find((r) => r.id === "plain")).toMatchObject({ source_key: null, quantity: 10 });
    expect(inserted.material_list_items.map((r) => [r.source_key, r.quantity])).toEqual([["line:l1#R1", 3]]);
  });
});

describe("class 4 — a lost or cut price-book read is said, never priced around", () => {
  // A book read that fails whatever the chain: every builder step returns the chain, the page itself errors.
  const broken = (sb: { from: (t: string) => unknown }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = { select: () => chain, eq: () => chain, order: () => chain, range: () => Promise.resolve({ data: null, error: { message: "timeout" } }) };
    return { from: (t: string) => (t === "price_list_items" ? chain : sb.from(t)) } as never;
  };
  it("readPriceBook returns the error", async () => {
    const { sb } = listWorld([]);
    expect((await readPriceBook(broken(sb), ORG)).error).toBeTruthy();
    expect((await readPriceBook(sb, ORG)).error).toBeUndefined();
  });
  it("the take-off makes NO list on a failed book read (an empty list would read as the list for good) and says why", async () => {
    const db = fakeDb({
      quotes: [{ id: "q-1", quote_number: "Q-1", job_id: "job-1", status: "accepted", org_id: ORG }],
      material_lists: [],
      quote_line_items: [taskLine("l1", [{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: null, sell: null }])],
      price_list_items: BOOK,
      organizations: [{ id: ORG, settings: {} }],
      customers: [],
    });
    const res = await takeOffFromQuote(broken(db.sb), { quoteId: "q-1", userId: "u", orgId: ORG });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("The price book could not be read");
    expect(db.inserted.material_lists).toBeUndefined();
  });
  it("the sync returns an error instead of inserting unpriced rows", async () => {
    const { sb, inserted } = listWorld([]);
    const res = await syncQuoteMaterials(broken(sb), WHO);
    expect(res.error).toContain("The price book could not be read");
    expect(inserted.material_list_items).toBeUndefined();
  });
  it("the Inspector's book read is paged", () => {
    expect(src("src/app/(app)/appointments/[id]/page.tsx")).toContain('readAllPages<{ code: string; description: string | null; unit: string | null; buy_price: number | null }>((from, to) =>');
  });
});

describe("class 6 — the customer's own Accept on a revision takes the original's job (0392)", () => {
  const sql = src("supabase/migrations/0392_the_customers_accept_takes_the_originals_job.sql");
  it("redefines accept_public_quote with the original's job taken before a job is born, and a guarded flip; the self-check reads the catalog", () => {
    expect(sql).toContain("create or replace function public.accept_public_quote(p_token text)");
    expect(sql).toContain("if q.job_id is null and q.revises_quote_id is not null then");
    expect(sql).toContain("select o.job_id into new_job from public.quotes o where o.id = q.revises_quote_id and o.org_id = q.org_id;");
    expect(sql).toContain("update public.quotes set job_id = new_job where id = q.id and job_id is null;");
    expect(sql).toContain("select job_id into q.job_id from public.quotes where id = q.id;"); // the lost race reads the job the office made
    expect(sql.indexOf("if q.job_id is null and q.revises_quote_id is not null then")).toBeLessThan(sql.indexOf("insert into public.jobs ("));
    expect(sql).toContain("where id = q.id and status = 'sent';");
    expect(sql).toContain("pg_get_functiondef('public.accept_public_quote(text)'::regprocedure)");
  });
  it("carries the live 0369 body: the job's name, the deferred customer, the site address", () => {
    expect(sql).toContain("public.job_name_from(null, q.title, cust.name, cust.company_name, cust.type::text,");
    expect(sql).toContain("if q.customer_id is null and inq.id is not null then");
    expect(sql).toContain("if coalesce(q.address, '') <> '' then");
  });
});

describe("the carried items fixed in passing", () => {
  it("revisionOf orders nulls last and throws on a failed read (a failed read must not lift a lock); every action door turns the throw into a said refusal", () => {
    const rev = src("src/lib/estimate/revision.ts");
    expect(rev).toContain('.order("accepted_at", { ascending: false, nullsFirst: false })');
    expect(rev).toContain("if (error) throw new Error(`revisionOf: ${dbError(error)}`);");
    const quotes = src("src/app/(app)/quotes/actions.ts");
    expect(quotes.split("Couldn't check whether a revision replaced this estimate").length - 1).toBe(2); // requireEditableQuote + updateQuoteStatus
    expect(src("src/app/(app)/billing/actions.ts")).toContain("Couldn't check whether a revision replaced this estimate");
  });
});
