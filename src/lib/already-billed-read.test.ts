import { describe, it, expect } from "vitest";
import { NO_JOB_SHEET_CAP, loadNoJobHoursSheet, noJobCappedWords, readAlreadyBilledReach, readNoJobHandHours, readNoJobHoursReach } from "./already-billed-read";
import { NEEDS_UPDATE } from "./already-billed";
import { withAlreadyBilledDoors } from "@/app/(app)/bills/supplier-papers";

/**
 * ALREADY BILLED'S READS FOR THE NEW DOORS (0357, Erik 2026-09-26):
 *
 *   - readAlreadyBilledReach: where the sheet can work, for many jobs at once (the paper card's
 *     Already Billed On J-010, the bill's own row on /bills, the Costs tab). The sheet's own rule:
 *     New Invoice pulls the job's actuals (nextInvoiceImportsActuals), and a sent bill the sheet would
 *     offer has a line that could hold it (the job's own; a job that isn't Time & Material also its
 *     customer's invoices with no job). What the invoices hold, and what a person marked;
 *   - loadNoJobHoursSheet: hours on NO job (TTUSD on INV-055): invoices with no job and their lines of
 *     work, every open shift on no job, the one the door was pressed on ticked;
 *   - readNoJobHoursReach / readNoJobHandHours: the Needs You row's door, and the invoice's way back.
 *
 * Every read filters org_id; a database without 0357 answers "needs an update" or draws no door,
 * never a crash; a lost read throws or says so.
 */

type Q = { table: string; cols: string; filters: string[] };
type Reply = { data?: any; error?: any };
function fake(route: (q: Q) => Reply, seen: Q[] = []) {
  return {
    from(table: string) {
      const q: Q = { table, cols: "", filters: [] };
      const answer = () => {
        seen.push(q);
        const r = route(q);
        return { data: r.data ?? null, error: r.error ?? null };
      };
      const chain: any = {
        select(c?: string) {
          q.cols = c ?? "";
          return chain;
        },
        maybeSingle: () => Promise.resolve(answer()),
        then: (res: any, rej: any) => {
          try {
            res(answer());
          } catch (e) {
            rej?.(e);
          }
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "or", "order", "limit", "overlaps", "contains"])
        chain[m] = (...a: unknown[]) => {
          q.filters.push(`${m}:${String(a[0])}:${JSON.stringify(a[1] ?? null)}`);
          return chain;
        };
      return chain;
    },
  } as any;
}
const has = (q: Q, f: string) => q.filters.some((x) => x.startsWith(f));

const ORG = "60195593-2e18-4230-bc8e-7a32d36d038d";
const J010 = "00000000-0000-4000-8000-000000000010"; // Purple Sage: fixed price, no estimate
const J011 = "00000000-0000-4000-8000-000000000011"; // Herringbone: Time & Material
const J020 = "00000000-0000-4000-8000-000000000020"; // fixed price, its estimate is the contract

const typed = (id: string, description: string, total: number, o: Record<string, unknown> = {}) => ({
  id,
  description,
  quantity: 1,
  unit: "ea",
  unit_price: total,
  line_total: total,
  import_source: null,
  import_key: null,
  edited: false,
  line_kind: null,
  sort_order: 0,
  hand_claims: [],
  source_ids: [],
  ...o,
});

describe("readAlreadyBilledReach: one door rule for every door", () => {
  const route =
    (over: Partial<Record<string, Reply>> = {}) =>
    (q: Q): Reply => {
      if (over[q.table]) return over[q.table]!;
      if (q.table === "jobs")
        return {
          data: [
            { id: J010, billing_type: "fixed", customer_id: "c-ps" },
            { id: J011, billing_type: "tm", customer_id: "c-andrew" },
            { id: J020, billing_type: "fixed", customer_id: "c-other" },
          ],
        };
      if (q.table === "payment_milestones") return { data: [] };
      if (q.table === "quotes") return { data: [{ job_id: J020, status: "accepted" }, { job_id: J010, status: "declined" }] };
      if (q.table === "invoices" && has(q, "is:job_id"))
        // Invoices with no job: Purple Sage's customer's and Andrew's.
        return {
          data: [
            { id: "inv-ps-nojob", invoice_number: "INV-030", status: "paid", invoice_kind: "standard", job_id: null, customer_id: "c-ps", created_at: "2026-07-01", invoice_items: [typed("li-ps", "Materials", 90)] },
            { id: "inv-an-nojob", invoice_number: "INV-031", status: "paid", invoice_kind: "standard", job_id: null, customer_id: "c-andrew", created_at: "2026-07-01", invoice_items: [typed("li-an", "Materials", 90)] },
          ],
        };
      if (q.table === "invoices")
        return {
          data: [
            {
              id: "inv-078",
              invoice_number: "INV-078",
              status: "sent",
              invoice_kind: "standard",
              job_id: J011,
              customer_id: "c-andrew",
              created_at: "2026-09-01",
              invoice_items: [
                typed("li-imp", "Materials from CED", 300, { import_source: "costs", import_key: "bill:b-imported", source_ids: ["b-imported"] }),
                typed("li-hand", "Materials", 110, { source_ids: ["b-marked"], hand_claims: ["b-marked"] }),
              ],
            },
            { id: "inv-020", invoice_number: "INV-020", status: "paid", invoice_kind: "standard", job_id: J020, customer_id: "c-other", created_at: "2026-06-01", invoice_items: [typed("li-20", "Materials", 200)] },
          ],
        };
      if (q.table === "invoice_items") return { data: [{ import_key: null, source_ids: ["b-elsewhere"], invoices: { id: "inv-x", invoice_number: "INV-050", status: "sent", created_at: "2026-08-01", job_id: "j-x" } }] };
      return { data: [] };
    };

  it("New Invoice's rule decides: T&M on its own bills, fixed price with no live estimate on its customer's no-job bill too, never where the estimate is the contract", async () => {
    const seen: Q[] = [];
    const r = await readAlreadyBilledReach(fake(route(), seen), ORG, [J010, J011, J020], ["b-elsewhere", "b-free"]);
    expect(r.ready).toBe(true);
    expect(r.jobs.get(J011)).toEqual({ charge: true, ret: false });
    // J-010 has no invoice of its own, but its customer's invoice with no job has a typed Materials line.
    expect(r.jobs.get(J010)).toEqual({ charge: true, ret: false });
    // J-020's accepted estimate is the contract: New Invoice bills that, so no door.
    expect(r.jobs.get(J020)).toEqual({ charge: false, ret: false });
    // Every read is the company's own.
    for (const q of seen) if (q.table !== "invoice_items" || !has(q, "overlaps")) expect(has(q, `eq:org_id:"${ORG}"`) || q.filters.includes(`eq:org_id:"${ORG}"`)).toBe(true);
  });

  it("what the bills hold: an import's key, a mark by hand (with its line), and a candidate held on some other job's invoice", async () => {
    const r = await readAlreadyBilledReach(fake(route()), ORG, [J011], ["b-elsewhere", "b-free"]);
    expect([...r.claimed].sort()).toEqual(["b-elsewhere", "b-imported", "b-marked"]);
    expect(r.hands.get("b-marked")).toMatchObject({ lineId: "li-hand", invoiceNumber: "INV-078" });
    expect(r.hands.has("b-imported")).toBe(false);
  });

  it("a Time & Material job never takes its customer's invoice with no job (its work to date counts only its own)", async () => {
    // Neither job has an invoice of its own; each customer has one with no job and a typed Materials line.
    const base = route();
    const r = await readAlreadyBilledReach(fake((q) => (q.table === "invoices" && !has(q, "is:job_id") ? { data: [] } : base(q))), ORG, [J011, J010]);
    expect(r.jobs.get(J011)).toEqual({ charge: false, ret: false });
    expect(r.jobs.get(J010)).toEqual({ charge: true, ret: false });
  });

  it("a database without 0357 draws no door; a lost read throws (the caller logs it)", async () => {
    const missing = { error: { code: "42703", message: 'column invoice_items_1.hand_claims does not exist' } };
    const r = await readAlreadyBilledReach(fake(route({ invoices: missing })), ORG, [J011]);
    expect(r.ready).toBe(false);
    expect(r.jobs.size).toBe(0);
    await expect(readAlreadyBilledReach(fake(route({ quotes: { error: { message: "boom" } } })), ORG, [J011])).rejects.toBeTruthy();
  });

  it("no jobs, no reads", async () => {
    const seen: Q[] = [];
    const r = await readAlreadyBilledReach(fake(route(), seen), ORG, []);
    expect(r).toMatchObject({ ready: true });
    expect(seen).toEqual([]);
  });
});

describe("loadNoJobHoursSheet: TTUSD's days on INV-055", () => {
  const INV055 = {
    id: "inv-55",
    invoice_number: "INV-055",
    status: "paid",
    invoice_kind: "standard",
    job_id: null,
    customer_id: null,
    created_at: "2026-08-08T18:00:00Z",
    invoice_items: [typed("li-jp", "Labor - JP Prince", 2185, { quantity: 23, unit: "hr", unit_price: 95 }), typed("li-fee", "Card fee", 12, { line_kind: "other" })],
  };
  const DRAFT = { ...INV055, id: "inv-90", invoice_number: "INV-090", status: "draft", invoice_items: [typed("li-d", "Labor", 100)] };
  const shift = (id: string, day: string, o: Record<string, unknown> = {}) => ({
    id,
    clock_in: `${day}T15:00:00Z`,
    clock_out: `${day}T23:00:00Z`,
    lunch_minutes: 0,
    job_code: null,
    split_from: null,
    profiles: { id: "p-jp", full_name: "JP Prince" },
    ...o,
  });
  const route =
    (over: Partial<Record<string, Reply>> = {}) =>
    (q: Q): Reply => {
      if (over[q.table]) return over[q.table]!;
      if (q.table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } } };
      if (q.table === "invoices") return { data: [INV055, DRAFT] };
      if (q.table === "job_codes") return { data: [{ code: "SHOP" }] };
      if (q.table === "time_entries")
        return {
          data: [
            shift("t-806", "2026-08-06"),
            shift("t-807", "2026-08-07"),
            shift("t-shop", "2026-08-09", { job_code: "SHOP" }),
            shift("t-billed", "2026-08-10"),
            shift("t-empty", "2026-08-11", { clock_out: "2026-08-11T15:00:00Z" }),
          ],
        };
      if (q.table === "invoice_items")
        return { data: [{ import_key: null, source_ids: ["t-billed"], invoices: { id: "inv-58", invoice_number: "INV-058", status: "sent", created_at: "2026-08-12", job_id: null } }] };
      return { data: [] };
    };

  it("offers INV-055's labor line (never the fee, never the draft), lists the open shifts on no job, and ticks the one pressed", async () => {
    const res = await loadNoJobHoursSheet(fake(route()), ORG, ["t-806"]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = res.data;
    expect(d.noJob).toBe(true);
    expect(d.target.kind).toBe("time");
    expect(d.invoices.map((x) => x.invoice.invoice_number)).toEqual(["INV-055"]);
    expect(d.invoices[0].invoice.lines.map((l) => l.id)).toEqual(["li-jp"]);
    // No line is picked for him: an invoice with no job's only line is no clue it charged these hours.
    expect(d.invoices[0].preselect).toBeNull();
    // Not the company's own time (SHOP), not one an invoice holds, not an empty one.
    expect(d.entries.map((e) => e.id)).toEqual(["t-806", "t-807"]);
    expect(d.preticked).toEqual(["t-806"]);
    expect(d.drafts).toEqual(["INV-090 is still a draft: open it to add these there."]);
    expect(d.note).toBeNull();
  });

  it("never picks a line to start, even on an invoice with only one (INV-073's $1.11 'Test 5' sorts first for a shift this week at ET)", async () => {
    const TEST5 = { ...INV055, id: "inv-73", invoice_number: "INV-073", created_at: "2026-09-22T18:00:00Z", invoice_items: [typed("li-t5", "Test 5", 1.11)] };
    const res = await loadNoJobHoursSheet(fake(route({ invoices: { data: [TEST5] } })), ORG, ["t-807"]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.invoices.map((x) => [x.invoice.invoice_number, x.invoice.lines.map((l) => l.id), x.preselect])).toEqual([["INV-073", ["li-t5"], null]]);
  });

  it("the company's own codes are left out IN the read (they never crowd out the newest 150), and a list cut at 150 says so", async () => {
    const seen: Q[] = [];
    const res = await loadNoJobHoursSheet(fake(route(), seen), ORG, ["t-806"]);
    const reads = seen.filter((q) => q.table === "time_entries" && q.cols.includes("job_code"));
    expect(reads.length).toBe(2);
    for (const q of reads) expect(q.filters).toContain('or:job_code.is.null,job_code.not.in.("SHOP"):null');
    expect(res.ok && res.data.note).toBeNull();

    const many = Array.from({ length: NO_JOB_SHEET_CAP }, (_, i) => shift(`t-${i}`, `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")}`));
    const full = await loadNoJobHoursSheet(fake(route({ time_entries: { data: many } })), ORG, []);
    expect(full.ok && full.data.note).toBe(noJobCappedWords());
    expect(noJobCappedWords()).toBe("Showing the newest 150 shifts on no job. Older ones aren't listed here or counted in the hours above.");
  });

  it("the shift he pressed is listed first, the rest newest first", async () => {
    const res = await loadNoJobHoursSheet(fake(route()), ORG, ["t-806"]);
    expect(res.ok && res.data.entries.map((e) => e.id)).toEqual(["t-806", "t-807"]);
    const later = await loadNoJobHoursSheet(fake(route()), ORG, ["t-807"]);
    expect(later.ok && later.data.entries.map((e) => e.id)).toEqual(["t-807", "t-806"]);
    expect(later.ok && later.data.preticked).toEqual(["t-807"]);
  });

  it("a shift the door named that is no longer open says so; the rest can still be marked", async () => {
    const res = await loadNoJobHoursSheet(fake(route()), ORG, ["t-billed"]);
    expect(res.ok && res.data.note).toMatch(/isn't open to mark any more/);
    expect(res.ok && res.data.preticked).toEqual([]);
  });

  it("a database without 0357 says it needs an update; a lost read says so, never an empty sheet", async () => {
    const missing = await loadNoJobHoursSheet(fake(route({ invoices: { error: { code: "42703", message: "column hand_claims does not exist" } } })), ORG, []);
    expect(missing).toEqual({ ok: false, error: NEEDS_UPDATE, needsUpdate: true });
    const lost = await loadNoJobHoursSheet(fake(route({ time_entries: { error: { message: "timeout" } } })), ORG, []);
    expect(lost.ok).toBe(false);
    expect(!lost.ok && lost.error).toMatch(/Couldn't read the hours on no job/);
  });
});

describe("the Needs You row and the invoice's way back", () => {
  it("readNoJobHoursReach: an invoice with no job that could hold hours, and which shifts are held already", async () => {
    const r = await readNoJobHoursReach(
      fake((q) =>
        q.table === "invoices"
          ? { data: [{ id: "inv-55", invoice_number: "INV-055", status: "paid", invoice_kind: "standard", job_id: null, created_at: "2026-08-08", invoice_items: [typed("li", "Labor", 500, { unit: "hr", quantity: 5 })] }] }
          : { data: [{ source_ids: ["t-1"], invoices: { id: "inv-55", status: "paid" } }] },
      ),
      ORG,
      ["t-1", "t-2"],
    );
    expect(r.canHold).toBe(true);
    expect([...r.claimed]).toEqual(["t-1"]);
  });

  it("readNoJobHandHours: per line, the shifts on no job it holds by hand, in words", async () => {
    const r = await readNoJobHandHours(
      fake((q) =>
        q.table === "invoice_items"
          ? { data: [{ id: "li-jp", description: "Labor - JP Prince", hand_claims: ["t-806", "t-807"] }] }
          : {
              data: [
                { id: "t-806", clock_in: "2026-08-06T15:00:00Z", clock_out: "2026-08-06T23:00:00Z", lunch_minutes: 30, profiles: { full_name: "JP Prince" } },
                { id: "t-807", clock_in: "2026-08-07T15:00:00Z", clock_out: "2026-08-07T19:00:00Z", lunch_minutes: 0, profiles: { full_name: "JP Prince" } },
              ],
            },
      ),
      ORG,
      "inv-55",
    );
    expect(r).toEqual({ ready: true, lines: [{ lineId: "li-jp", description: "Labor - JP Prince", ids: ["t-806", "t-807"], hours: 11.5, what: "11.5 h of JP Prince's time" }] });
  });
});

describe("withAlreadyBilledDoors: the paper cards on My Day and /bills", () => {
  const J = { id: J011, label: "J-011", name: "13897 Herringbone", status: "in progress" };
  const card = (o: Record<string, unknown> = {}) =>
    ({ invoiceId: "si-1", invoiceNumber: "8802-1106969", supplier: "CED", date: null, total: 301.81, closed: false, said: null, state: "needs_job", verdict: "one", suggestion: J, candidates: [], onJob: null, because: "", samePurchase: [], ...o }) as any;
  const route = (q: Q): Reply => {
    if (q.table === "jobs") return { data: [{ id: J011, billing_type: "tm", customer_id: "c-andrew" }] };
    if (q.table === "invoices" && !has(q, "is:job_id"))
      return { data: [{ id: "inv-078", invoice_number: "INV-078", status: "sent", invoice_kind: "standard", job_id: J011, customer_id: "c-andrew", created_at: "2026-09-01", invoice_items: [typed("li", "Materials", 110)] }] };
    return { data: [] };
  };

  it("a card whose one job could hold it gets Already Billed On J-011; the reads are the jobs the cards name", async () => {
    const seen: Q[] = [];
    const feed = await withAlreadyBilledDoors(fake(route, seen), ORG, { cards: [card()], jobs: [] });
    expect(feed.cards[0].alreadyBilledOn).toEqual(J);
    expect(seen.find((q) => q.table === "jobs")?.filters).toContain(`in:id:${JSON.stringify([J011])}`);
  });

  it("a lost read leaves every card exactly as it was (no door, nothing else touched)", async () => {
    const feed = { cards: [card()], jobs: [] };
    const out = await withAlreadyBilledDoors(fake(() => ({ error: { message: "timeout" } })), ORG, feed);
    expect(out).toBe(feed);
  });

  it("no card with one job: no read at all", async () => {
    const seen: Q[] = [];
    const feed = { cards: [card({ suggestion: null, verdict: "blank" })], jobs: [] };
    expect(await withAlreadyBilledDoors(fake(route, seen), ORG, feed)).toBe(feed);
    expect(seen).toEqual([]);
  });
});
