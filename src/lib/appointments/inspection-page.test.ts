import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  inspectionHeaderStep,
  startAsked,
  startAskedHref,
  startCardShown,
  startRowShown,
  visitHeading,
  type HeaderStep,
} from "@/lib/appointments/inspection-page";
import { APPOINTMENT_TYPES, isInspectionType } from "@/lib/statuses";
import { bucketInspections } from "@/lib/inspections";
import { translator } from "@/lib/i18n";

/**
 * AN INSPECTION'S VISIT PAGE LEADS WITH ONE NEXT STEP (cn-v1173). The owner, 2026-11-19: the big start
 * box on an inspection "makes no sense because there is another button above it to mark inspection
 * done", and the heading "says INSPECTION OR ESTIMATE which seems out of place because this is an
 * inspection not an estimate". Bounded by "fragment first so we dont piss anyone off forcing them to do
 * something in order to do something else": the box is moved behind the dots, never removed.
 */
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const STATUSES = ["scheduled", "proposed", "completed", "cancelled"] as const;
const INSPECTIONS = APPOINTMENT_TYPES.filter((t) => isInspectionType(t));
const OTHERS = APPOINTMENT_TYPES.filter((t) => !isInspectionType(t));

describe("1. the box: drawn as ever, except the office's inspection with no job, until start=1", () => {
  it("the families are what the page tells apart", () => {
    expect(INSPECTIONS).toEqual(["inspection", "final_inspection"]);
    expect(OTHERS.length).toBeGreaterThan(0);
  });

  it("every case, office and tech, each type family, cancelled, with and without a job, with and without start=1", () => {
    for (const type of [...INSPECTIONS, ...OTHERS]) {
      const isInspection = isInspectionType(type);
      for (const isStaff of [true, false]) {
        for (const status of STATUSES) {
          for (const hasJob of [true, false]) {
            for (const asked of [true, false]) {
              const f = { isStaff, isInspection, status, hasJob, startAsked: asked };
              const label = JSON.stringify({ type, ...f });
              const movedAway = isStaff && isInspection && !hasJob;
              const card = startCardShown(f);
              const row = startRowShown(f);
              if (status === "cancelled") {
                expect(card, label).toBe(false); // as before: a cancelled visit draws no card
                expect(row, label).toBe(false);
              } else if (movedAway) {
                expect(card, label).toBe(asked);
                expect(row, label).toBe(!asked);
              } else {
                expect(card, label).toBe(true); // any other visit, a job's clock door, a tech's Ask the Office
                expect(row, label).toBe(false);
              }
              // Never both, and on a live visit never neither where the box was taken: one door to the start.
              expect(card && row, label).toBe(false);
              if (status !== "cancelled") expect(card || row, label).toBe(true);
            }
          }
        }
      }
    }
  });

  it("start=1 asks, and nothing else does; the href keeps every other param and sets start once", () => {
    expect(startAsked({ start: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", ["1"], ["1", "1"]]) expect(startAsked({ start: v as never }), String(v)).toBe(false);
    expect(startAskedHref("/appointments/a1", {})).toBe("/appointments/a1?start=1");
    expect(startAskedHref("/appointments/a1", { task: "t-9" })).toBe("/appointments/a1?task=t-9&start=1");
    expect(startAskedHref("/appointments/a1", { start: "0", task: "t-9", tag: ["x", "y"], gone: undefined })).toBe(
      "/appointments/a1?task=t-9&tag=x&tag=y&start=1",
    );
  });
});

describe("2. the header's one boxed step, the office's, on an inspection", () => {
  type Facts = Parameters<typeof inspectionHeaderStep>[0];
  const base: Facts = { isStaff: true, isInspection: true, status: "completed", outcome: null, estimatesOn: true, estimate: null, hasJob: false, leadHasEstimate: false };
  const rows: [string, Partial<Facts>, HeaderStep][] = [
    ["scheduled", { status: "scheduled" }, "mark_done"],
    ["proposed", { status: "proposed" }, "mark_done"],
    ["booked, with a job", { status: "scheduled", hasJob: true }, "mark_done"],
    ["booked, Estimates off", { status: "scheduled", estimatesOn: false }, "mark_done"],
    ["completed, nothing written", {}, "start_estimate"],
    ["completed, a live estimate", { estimate: { live: true } }, "open_estimate"],
    ["completed, a live estimate, with a job", { estimate: { live: true }, hasJob: true }, "open_estimate"],
    ["completed, a dead estimate: Start handed back, as the Inspector's door", { estimate: { live: false } }, "start_estimate"],
    ["completed, sold to a job, no estimate: the list files it", { hasJob: true }, null],
    ["completed, its lead already has an estimate: the list files it, no second price invited", { leadHasEstimate: true }, null],
    ["completed, its lead has an estimate and this visit a live one", { leadHasEstimate: true, estimate: { live: true } }, "open_estimate"],
    ["booked, its lead already has an estimate", { status: "scheduled", leadHasEstimate: true }, "mark_done"],
    ["completed, won", { outcome: "won" }, null],
    ["completed, lost", { outcome: "lost" }, null],
    ["completed, no_bid", { outcome: "no_bid", estimate: { live: true } }, null],
    ["completed, Estimates off", { estimatesOn: false }, null],
    ["completed, Estimates off, a live estimate", { estimatesOn: false, estimate: { live: true } }, null],
    ["cancelled", { status: "cancelled" }, null],
    ["cancelled, a live estimate", { status: "cancelled", estimate: { live: true } }, null],
    ["a tech, booked", { isStaff: false, status: "scheduled" }, null],
    ["a tech, completed", { isStaff: false }, null],
    ["a tech, a live estimate", { isStaff: false, estimate: { live: true } }, null],
  ];
  for (const [name, over, want] of rows) {
    it(name, () => {
      expect(inspectionHeaderStep({ ...base, ...over })).toBe(want);
    });
  }

  it("no other visit type gets a step here, office or tech, in any status", () => {
    for (const type of OTHERS) {
      for (const status of STATUSES) {
        for (const isStaff of [true, false]) {
          expect(inspectionHeaderStep({ ...base, isInspection: isInspectionType(type), status, isStaff }), `${type} ${status}`).toBeNull();
        }
      }
    }
  });

  it("Start the Estimate is offered exactly on the visits the Inspections list says wait on a write-up, but for the one named difference", () => {
    // The list's own rule (lib/inspections bucketInspections, read by Needs You, the Inspections page
    // and the Estimates page): the same completed visits, with and without a job, an outcome, an
    // estimate in the capture, a lead that already has an estimate.
    const now = new Date("2026-11-19T20:00:00Z");
    type Case = { id: string; job_id: string | null; outcome: string | null; quote: string | null; live?: boolean; lead?: string; leadQuoted?: boolean };
    const cases: Case[] = [
      { id: "plain", job_id: null, outcome: null, quote: null },
      { id: "job", job_id: "j-900", outcome: null, quote: null },
      { id: "won", job_id: null, outcome: "won", quote: null },
      { id: "lost", job_id: null, outcome: "lost", quote: null },
      { id: "estimate", job_id: null, outcome: null, quote: "e-900", live: true },
      { id: "estimate-and-job", job_id: "j-901", outcome: null, quote: "e-901", live: true },
      // A second inspection on a lead whose first was already priced: the list files it, and so does the page.
      { id: "lead-estimated", job_id: null, outcome: null, quote: null, lead: "lead-900", leadQuoted: true },
      // A lead with nothing written: both say it waits.
      { id: "lead-unpriced", job_id: null, outcome: null, quote: null, lead: "lead-901", leadQuoted: false },
      // THE DIFFERENCE: a declined estimate in the capture, no outcome. The list files it (an estimate
      // exists); the page hands Start the Estimate back, as the Inspector's door does (cn-v1069).
      { id: "declined", job_id: null, outcome: null, quote: "e-902", live: false },
    ];
    const rowsIn = cases.map((c) => ({
      id: c.id,
      status: "completed",
      starts_at: "2026-11-18T17:00:00Z",
      inquiry_id: c.lead ?? null,
      job_id: c.job_id,
      outcome: c.outcome,
      capture: c.quote ? { quote_id: c.quote } : { notes: "Larkspur deck, 12 boards" },
    }));
    const quotedLeads = new Set(cases.flatMap((c) => (c.lead && c.leadQuoted ? [c.lead] : [])));
    const b = bucketInspections(rowsIn, quotedLeads, new Set(), now, new Set(cases.flatMap((c) => (c.quote ? [c.quote] : []))));
    const writeUp = new Set(b.toWriteUp.map((r) => r.id));
    const differs = new Set(["declined"]);
    for (const c of cases) {
      const step = inspectionHeaderStep({
        isStaff: true,
        isInspection: true,
        status: "completed",
        outcome: c.outcome,
        estimatesOn: true,
        estimate: c.quote ? { live: !!c.live } : null,
        hasJob: !!c.job_id,
        leadHasEstimate: !!c.leadQuoted,
      });
      // cn-v1175 (R8): a win with NO job picked is open on the list, asking for its JOB; the page's header
      // offers no estimate for it (the ending card hands the office the job picker at once).
      if (c.id === "won") {
        expect(writeUp.has(c.id), c.id).toBe(true);
        expect(step, c.id).toBeNull();
        continue;
      }
      if (differs.has(c.id)) {
        expect(writeUp.has(c.id), c.id).toBe(false);
        expect(step, c.id).toBe("start_estimate");
      } else {
        expect(step === "start_estimate", c.id).toBe(writeUp.has(c.id));
      }
    }
    expect(writeUp.has("lead-unpriced")).toBe(true);
    expect(writeUp.has("lead-estimated")).toBe(false);
    // A booked visit still coming up is the list's upcoming, and the page's Mark Inspection Done.
    const ahead = bucketInspections([{ id: "ahead", status: "scheduled", starts_at: "2026-11-25T17:00:00Z", inquiry_id: null, job_id: null }], new Set(), new Set(), now);
    expect(ahead.upcoming.map((r) => r.id)).toEqual(["ahead"]);
    // THE OTHER NAMED DIFFERENCE: a booked visit whose day passed with its sheet filled. The list says
    // it waits on an estimate (done by capture); the page still asks Mark Inspection Done, one tap behind.
    const inspected = bucketInspections(
      [{ id: "inspected", status: "scheduled", starts_at: "2026-11-18T17:00:00Z", inquiry_id: null, job_id: null, capture: { notes: "Snowbell porch, 3 posts" } }],
      new Set(),
      new Set(),
      now,
    );
    expect(inspected.toWriteUp.map((r) => r.id)).toEqual(["inspected"]);
    expect(inspectionHeaderStep({ ...base, status: "scheduled" })).toBe("mark_done");
    expect(inspectionHeaderStep({ ...base, status: "scheduled" })).toBe("mark_done");
  });
});

describe("3. the heading above the sheet", () => {
  it("an inspection says Inspection whatever the switch says; every other visit keeps today's words", () => {
    for (const isStaff of [true, false]) {
      for (const estimatesOn of [true, false]) {
        expect(visitHeading({ isInspection: true, isStaff, estimatesOn })).toBe("inspection");
        expect(visitHeading({ isInspection: false, isStaff, estimatesOn })).toBe(isStaff && estimatesOn ? "inspection_or_estimate" : "inspection");
      }
    }
  });
});

describe("the page reads the one file for all three, and hands ONE href to both estimate doors", () => {
  const page = src("src/app/(app)/appointments/[id]/page.tsx");
  const rows = src("src/app/(app)/appointments/[id]/visit-header-actions.tsx");

  it("the lib is pure: no catalog, no i18n, no JSX", () => {
    const lib = src("src/lib/appointments/inspection-page.ts");
    expect(lib).not.toMatch(/from\s+["'](@\/lib\/i18n|@\/lib\/words|react)/);
    expect(lib).not.toMatch(/<[A-Z][A-Za-z]*[\s/>]/);
  });

  it("1. the card is drawn on startCardShown, the row on startRowShown, and the row asks with startAskedHref", () => {
    expect(page).toContain("const showStartCard = startCardShown(startFacts);");
    expect(page).toContain("const showStartRow = startRowShown(startFacts);");
    expect(page).toContain("startAsked: startAsked(sp),");
    expect(page).toMatch(/\{showStartCard && \(\s*<div className="my-4">\s*<VisitStartCard/);
    expect(page).not.toContain('{a.status !== "cancelled" && (\n          <div className="my-4">');
    const menu = page.slice(page.indexOf("<SectionActionsMenu tree={VISIT_ACTIONS_MENU}>"), page.indexOf("</SectionActionsMenu>"));
    expect(menu).toContain("{showStartRow && <StartAJobRow href={startAskedHref(`/appointments/${a.id}`, sp)} />}");
    expect(menu.indexOf("<StartAJobRow")).toBeLessThan(menu.indexOf("<AppointmentButton"));
    // The row: the existing word, closes the panel first, a replace that keeps the scroll, no modal.
    const row = rows.slice(rows.indexOf("export function StartAJobRow("), rows.indexOf("/** 'Put It Back on the Schedule'"));
    expect(row).toContain('{t("vp_btn_startAJobFromThisVisit")}');
    expect(row).toContain("className={ACTIONS_ROW_CLS}");
    expect(row).toMatch(/closeMenu\(\);\s*router\.replace\(href, \{ scroll: false \}\);/);
    expect(row).not.toContain("Modal");
    expect(translator("en")("vp_btn_startAJobFromThisVisit")).toBe("Start a Job from This Visit");
    expect(translator("es")("vp_btn_startAJobFromThisVisit")).toBe("Empezar un Trabajo desde Esta Visita");
  });

  it("2. the header draws inspectionHeaderStep's answer, with the Inspector's own two words", () => {
    expect(page).toMatch(/const headerStep = inspectionHeaderStep\(\{/);
    expect(page).toContain('{viewerIsStaff && headerStep === "mark_done" && (');
    expect(page).toContain('{viewerIsStaff && headerStep === "start_estimate" && estimateHref && (\n            <Link href={estimateHref}>');
    expect(page).toContain('<Button type="button">{t("vi_btn_startTheEstimate")}</Button>');
    expect(page).toContain('{viewerIsStaff && headerStep === "open_estimate" && estimate && (\n            <Link href={`/quotes/${estimate.id}`}>');
    expect(page).toContain('<Button type="button">{t("vi_btn_openTheEstimate")}</Button>');
    const inspector = src("src/app/(app)/appointments/[id]/inspector.tsx");
    // Re-pinned on purpose (cn-v1176): the Inspector's Start the Estimate waits for a real save
    // (goEstimate awaits flushNow) before it goes to the same href.
    expect(inspector).toMatch(/<Link\n\s+href=\{estimateHref\}\n\s+onClick=\{\(e\) => \{[\s\S]*?void goEstimate\(estimateHref\);[\s\S]*?<Button type="button">\{t\("vi_btn_startTheEstimate"\)\}<\/Button>/);
    expect(inspector).toContain('<Link href={`/quotes/${estimate.id}`}>\n                  <Button type="button">{t("vi_btn_openTheEstimate")}</Button>');
    expect(translator("en")("vi_btn_startTheEstimate")).toBe("Start the Estimate");
    expect(translator("en")("vi_btn_openTheEstimate")).toBe("Open the Estimate");
  });

  it("2. the lead's estimates are one head count on the page's session, asked only when they could matter, and a failed read offers the button", () => {
    expect(page).toContain(
      'if (a.inquiry_id && inspectionHeaderStep({ ...stepFacts, leadHasEstimate: false }) === "start_estimate") {',
    );
    expect(page).toContain('supabase.from("quotes").select("id", { count: "exact", head: true }).eq("inquiry_id", a.inquiry_id)');
    expect(page).toContain('if (leadQuotes.error) reportError("appointment:lead-estimates", leadQuotes.error, { appointmentId: id });');
    expect(page).toContain("else leadHasEstimate = (leadQuotes.count ?? 0) > 0;");
    expect(page).toContain("const headerStep = inspectionHeaderStep({ ...stepFacts, leadHasEstimate });");
    // The same estimates the list reads (lib/inspections-read: every quote, any status, by inquiry_id).
    const reader = src("src/lib/inspections-read.ts");
    expect(reader).toMatch(/from\("quotes"\)\.select\(ESTIMATE_LINK_COLUMNS\)\.order\("id"\)/);
    expect(reader).toContain('ids(quotesRes.rows, "inquiry_id")');
    // The lib names where it and the list differ.
    const lib = src("src/lib/appointments/inspection-page.ts");
    expect(lib).toContain("WHERE THE PAGE AND THE LIST DIFFER");
  });

  it("the estimator's href is built once and handed to both doors", () => {
    // Built once in code (the file's header comment names the route as prose; inspection-opens-not-estimates strips comments too).
    expect(page.match(/`\/quotes\/new\?capture=/g)?.length).toBe(1);
    expect(page).toContain("const estimateHref = viewerIsStaff && estimatesOn ? `/quotes/new?capture=");
    expect(page).toContain("estimateHref={estimateHref}");
    expect(page).toContain("<Link href={estimateHref}>");
  });

  it("3. the heading reads visitHeading", () => {
    expect(page).toContain(
      '{visitHeading({ isInspection, isStaff: viewerIsStaff, estimatesOn }) === "inspection_or_estimate" ? t("vp_inspectionOrEstimate") : t("vp_inspection")}',
    );
    expect(page).not.toContain('{viewerIsStaff && estimatesOn ? t("vp_inspectionOrEstimate")');
  });

  it("the comments the change made untrue are gone", () => {
    expect(page).not.toContain("START THE WORK, FIRST");
    expect(page).not.toContain("A completed inspection has none");
  });
});

// ── cn-v1176: Won · Start the Job's door and address, and the pick's price ───────────────────────
import { addressWithoutWon, bookSellPrice, wonAsked, wonDoorShown } from "@/lib/appointments/inspection-page";
import { buildTaskDetail, type TaskBookRow } from "@/lib/estimate/task-lines";

describe("4. Won · Start the Job: the door, office only, and the address", () => {
  const base = { isStaff: true, type: "inspection", status: "completed", outcome: null as string | null, hasJob: false };
  it("drawn for the office on an inspection with no job: booked or done, undecided or marked Won", () => {
    for (const status of ["scheduled", "proposed", "completed"]) expect(wonDoorShown({ ...base, status }), status).toBe(true);
    expect(wonDoorShown({ ...base, outcome: "won" })).toBe(true);
  });
  it("never for a tech or a crew lead, a job, a cancelled visit, Not Sold, or any other type", () => {
    expect(wonDoorShown({ ...base, isStaff: false })).toBe(false);
    expect(wonDoorShown({ ...base, hasJob: true })).toBe(false);
    expect(wonDoorShown({ ...base, status: "cancelled" })).toBe(false);
    expect(wonDoorShown({ ...base, outcome: "lost" })).toBe(false);
    expect(wonDoorShown({ ...base, outcome: "no_bid" })).toBe(false);
    // cn-v1176 fix F2: re-pinned. The estimate visit ("quote") is a sale the sheet takes too (won-sheet isWonVisitType).
    expect(wonDoorShown({ ...base, type: "quote" })).toBe(true);
    for (const type of APPOINTMENT_TYPES.filter((t) => t !== "inspection" && t !== "quote")) expect(wonDoorShown({ ...base, type }), type).toBe(false);
    expect(wonDoorShown({ ...base, type: null })).toBe(false);
  });
  it("won=1 and nothing else asks for the sheet; closing takes only `won` off the address", () => {
    expect(wonAsked({ won: "1" })).toBe(true);
    for (const v of [undefined, "0", "true", ["1"]]) expect(wonAsked({ won: v as never })).toBe(false);
    expect(addressWithoutWon("/appointments/a-1", "?won=1")).toBe("/appointments/a-1");
    expect(addressWithoutWon("/appointments/a-1", "?task=t1&won=1&start=1", "#tasks")).toBe("/appointments/a-1?task=t1&start=1#tasks");
    expect(addressWithoutWon("/appointments/a-1", "")).toBe("/appointments/a-1");
  });
  it("the page decides the door once and hands the Inspector the door and the address", () => {
    const page = src("src/app/(app)/appointments/[id]/page.tsx");
    expect(page).toContain("const openWon = wonAsked(sp);");
    expect(page).toMatch(/const wonDoor = wonDoorShown\(\{\n\s+isStaff: viewerIsStaff,/);
    expect(page).toContain("wonDoor={wonDoor}");
    expect(page).toContain("wonAsked={openWon}");
  });
});

describe("5. the pick's price: the same sell price a task's part gets, through the one priceBookLine", () => {
  const item = (over: Partial<TaskBookRow> = {}): TaskBookRow => ({
    code: "R1",
    description: "Transfer switch",
    unit: "EA",
    buy_price: 100,
    markup_pct: null,
    price_list_item_options: [],
    ...over,
  });
  const taskSell = (row: TaskBookRow, pricing: { levelPct: number | null; orgDefaultPct: number | null }) =>
    buildTaskDetail(
      { id: "t1", name: "Switch", hours: 1, units: null, kit_id: null, materials: [{ code: row.code, words: null, qty: 2 }] },
      { book: new Map([[row.code, row]]), rate: 100, pricing },
    ).materials[0].sell;

  const cases: [string, TaskBookRow, { levelPct: number | null; orgDefaultPct: number | null }][] = [
    ["a customer with a level", item(), { levelPct: 30, orgDefaultPct: 15 }],
    ["a customer with no level (the company's default)", item(), { levelPct: null, orgDefaultPct: 15 }],
    ["the item's own markup", item({ markup_pct: 22 }), { levelPct: null, orgDefaultPct: 15 }],
    ["a default vendor", item({ price_list_item_options: [{ id: "o1", vendor: "Northline Supply", buy_price: 80, is_default: true, sort_order: 0 }] }), { levelPct: 30, orgDefaultPct: 15 }],
    ["an odd cent", item({ buy_price: 33.337 }), { levelPct: 12.5, orgDefaultPct: 0 }],
  ];
  for (const [name, row, pricing] of cases) {
    it(`${name}: the pick starts where the task's part is priced`, () => {
      const sell = bookSellPrice(row, pricing);
      expect(sell).toBe(taskSell(row, pricing));
      expect(sell).toBeGreaterThan(Number(row.buy_price) * 0.99); // never below cost on these rows
    });
  }
  it("a level marks up, and no level falls to the company's default: not the cost", () => {
    expect(bookSellPrice(item(), { levelPct: 30, orgDefaultPct: 15 })).not.toBe(bookSellPrice(item(), { levelPct: null, orgDefaultPct: 15 }));
    expect(bookSellPrice(item(), { levelPct: null, orgDefaultPct: 15 })).not.toBe(100);
  });
  it("a book part with no price starts at 0 (the estimate asks), where the task's part asks too", () => {
    expect(bookSellPrice(item({ buy_price: null }), { levelPct: 30, orgDefaultPct: 15 })).toBe(0);
    expect(taskSell(item({ buy_price: null }), { levelPct: 30, orgDefaultPct: 15 })).toBeNull();
  });
  it("the page seeds the pick through it, for the visit's customer else its lead's, the office only; a stored price is not re-read", () => {
    const page = src("src/app/(app)/appointments/[id]/page.tsx");
    expect(page).toContain("price: bookSellPrice({ ...p, description: String(p.description ?? \"\").trim() }, bookPricing),");
    expect(page).toContain("const pricingCustomerId = viewerIsStaff ? (a.customer_id ?? a.inquiries?.customer_id ?? null) : null;");
    expect(page).toContain("orgDefaultPct: orgSettings.default_markup_pct,");
    expect(page).toContain(".select(`code, description, unit, buy_price, markup_pct, ${ITEM_OPTIONS_EMBED}`)");
    expect(page).toContain('.eq("price_list_item_options.archived", false)');
    expect(page).toContain("priceBook={(viewerIsStaff ? (priceBook ?? []) : []).map((p) => ({");
    // No second markup formula on this path.
    expect(page).not.toMatch(/buy_price[^\n]*\*\s*\(1\s*\+/);
    // The Inspector seeds a NEW pick from the book row; a stored pick keeps its own price.
    const inspector = src("src/app/(app)/appointments/[id]/inspector.tsx");
    expect(inspector).toContain("setPicks([...picked, { code: row.code, qty: 1, price: row.price }]);");
    expect(inspector).toContain("value={p.price}");
  });
});
