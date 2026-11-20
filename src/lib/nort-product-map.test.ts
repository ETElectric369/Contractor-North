import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/tts", () => ({ unlockAudio: vi.fn() }));

import { NORT_PRODUCT_MAP } from "./nort-product-map";
import { cogsWords, overheadWords } from "./analytics/profit-and-loss";
import { DOCK, visibleDock } from "./dock";
import { helpRows } from "./onboarding/help-rows";
import { ALL_ON } from "./features";
import { dict, translator } from "./i18n";
import { appointmentTypeLabel } from "./statuses";
import { RECONCILE_KINDS } from "./reconcile-kinds";
import { words as nav } from "./words/nav";
import { words as calendarWords } from "./words/agenda-calendar";
const calendarWordsEn = calendarWords.en;

/**
 * WHERE NORT SAYS THINGS LIVE, HELD TO WHERE THEY DO (W1-09 / W1-07 / W1-08). A map that lags the
 * product recreates the failure it was built to end ("I can't do that" about a shipped feature),
 * so each line this wave rewrote is checked against the code that makes it true.
 */
describe("Nort's product map after the shell wave", () => {
  it("names Search or Ask, not the graduation cap, and what is inside it", () => {
    expect(NORT_PRODUCT_MAP).not.toMatch(/graduation cap|the cap\b/i);
    expect(NORT_PRODUCT_MAP).toContain(
      "Search or Ask (top bar): search anything, or ask Nort (Talk to Nort, or type); Start Here, Finish Setting Up and Show Me How live inside it (Nort off: Search, and those rows under Help in the avatar menu).",
    );
    // True in code: the rows exist, with those names, and Talk to Nort leads the sheet.
    const labels = helpRows({ isStaff: true, onboarded: false, setup: {}, nortOn: true, features: ALL_ON }).map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(["Start Here", "Show Me How"]));
    const withOpen = helpRows({ isStaff: true, onboarded: true, setup: {}, nortOn: true, features: ALL_ON }).map((r) => r.label);
    expect(withOpen.some((l) => l.startsWith("Finish Setting Up"))).toBe(true);
    // The row's words live in the shell catalog since cn-v1138 (sh_talkToNort: "Talk to Nort" / "Hablar Con Nort").
    expect(readFileSync(join(process.cwd(), "src/components/command-bar.tsx"), "utf8")).toContain('label: t("sh_talkToNort")');
    expect(translator("en")("sh_talkToNort")).toBe("Talk to Nort");
  });

  it("puts Customers under Sales, Timecards under Money, and Office and Tools behind the initials", () => {
    // The facts, not the line shapes: lane 7 rewrites the Money lines next order.
    const lineWith = (s: string) => NORT_PRODUCT_MAP.split("\n").find((l) => l.includes(s)) ?? "";
    expect(NORT_PRODUCT_MAP).not.toMatch(/^- Contacts:/m);
    expect(lineWith("Customers (/crm)")).toContain("Sales");
    expect(lineWith("Timecards (/timecards)")).toContain("Money");
    expect(NORT_PRODUCT_MAP).toContain("- Office and Tools: behind your initials");
    expect(NORT_PRODUCT_MAP).toContain("shows only with Calculators on");
    // True in code.
    const sales = DOCK.find((s) => s.key === "sales")!;
    expect(sales.children.find((c) => c.href === "/crm")?.label).toBe("Customers");
    expect(DOCK.find((s) => s.key === "invoices")!.children.find((c) => c.href === "/timecards")?.label).toBe("Timecards");
    for (const k of ["office", "tools"]) expect(DOCK.find((s) => s.key === k)?.inMenu, k).toBe(true);
    expect(DOCK.find((s) => s.key === "tools")?.feature).toBe("calculators");
    // Staff clock in on My Day: the Clock tile is the crew's.
    expect(NORT_PRODUCT_MAP).toContain("Staff clock in on My Day's Now card instead");
    expect(visibleDock({ isStaff: true }).some((s) => s.key === "clock")).toBe(false);
    expect(visibleDock({ isStaff: false }).some((s) => s.key === "clock")).toBe(true);
  });

  it("tells a tech where their own hours and pay are, every pay period of theirs, and never sends them to the office's page (sweep 2026-11-16; cn-v1166)", () => {
    // A tech asked Nort to "show me the payroll" and was told about Timecards, an office page, with
    // no word that his own hours and pay sit under his clock; then "where are the rest of my pay
    // periods". The owner, 2026-11-16: "yes for tech sees all their own data and past pay periods".
    // The map names the cards and the page by the words the screens draw, so a renamed card breaks
    // this line and not the answer.
    const t = translator("en");
    expect(NORT_PRODUCT_MAP).toContain(`"${t("tc_myTimecard")}" (the last 7 days, with a week total)`);
    expect(NORT_PRODUCT_MAP).toContain(`"${t("tc_myPayPeriod")}" (the NEWEST pay period's hours and base pay, marked ${t("tc_paid")}, ${t("tc_partlyPaid")} or ${t("tc_unpaid")}`);
    expect(NORT_PRODUCT_MAP).toContain(`with ${t("tc_seeAllPayPeriods")} under it. That opens "${t("tc_myPayPeriods")}" (/timeclock/pay): their pay periods, newest first (every period the office has locked, and the open ones from the last 18 months)`);
    // Only what the read does: open hours older than the balance window are not read (BALANCE_MONTHS).
    expect(NORT_PRODUCT_MAP).not.toContain("EVERY one of their pay periods");
    expect(readFileSync(join(process.cwd(), "src/lib/payroll-math.ts"), "utf8")).toContain("export const BALANCE_MONTHS = 18;");
    expect(NORT_PRODUCT_MAP).toContain("never send a tech to Timecards or Payroll");
    expect(NORT_PRODUCT_MAP).not.toContain("Earlier pay periods are not on a tech's screen");
    // A card with no hours in it is not drawn, and the map says so (a tech told a card is there
    // when it is not is the answer this line exists to end).
    // The pay card is also drawn to say the pay can't be shown (a read that failed), and the map says so.
    expect(NORT_PRODUCT_MAP).toContain(`"My timecard" is drawn only once it has hours in it (a punch in the last 7 days); "My pay period" is drawn once one of those pay periods has hours in it, or to say their pay can't be shown right now when it could not be read.`);
    expect(NORT_PRODUCT_MAP).toContain("Office only: the page turns a tech back to Clock.");
    // True in code: the page draws both cards with those keys, the pay card for a tech only, from the
    // newest row of My Pay Periods, with the door to the list; the office's page turns a tech back.
    const page = readFileSync(join(process.cwd(), "src/app/(app)/timeclock/page.tsx"), "utf8");
    expect(page).toContain('t("tc_myTimecard")');
    expect(page).toContain("!isStaff && user");
    expect(page).toContain("const newest = myPay?.kind === \"ok\" ? (myPay.pay.periods[0] ?? null) : null;");
    expect(page).toContain("7 * 86400_000");
    expect(page).toContain("{myTimecard.length > 0 && (");
    expect(page).toContain("{!isStaff && <MyPayCard newest={newest} cantShow={myPayCantShow} lang={lang} />}");
    // The card itself (pay/my-pay-views MyPayCard): drawn for a period, or to say the pay can't be shown.
    const card = readFileSync(join(process.cwd(), "src/app/(app)/timeclock/pay/my-pay-views.tsx"), "utf8");
    expect(card).toContain('t("tc_myPayPeriod")');
    expect(card).toContain("if (!newest && !cantShow) return null;");
    expect(card).toContain('{t("tc_payCantShow")}');
    expect(card).toContain('href="/timeclock/pay"');
    expect(card).toContain('{t("tc_seeAllPayPeriods")}');
    // The list and one period are pages of their own under the clock.
    const list = readFileSync(join(process.cwd(), "src/app/(app)/timeclock/pay/page.tsx"), "utf8");
    expect(list).toContain("<MyPayList pay={data.pay} payments={data.payments} lang={lang} />");
    const one = readFileSync(join(process.cwd(), "src/app/(app)/timeclock/pay/[period]/page.tsx"), "utf8");
    expect(one).toContain("<MyPayPeriodView");
    expect(readFileSync(join(process.cwd(), "src/app/(app)/timecards/page.tsx"), "utf8")).toContain('redirect("/timeclock")');
  });

  it("names My Day's parts: the Now card, Tasks & Reminders, Needs You and the agenda", () => {
    const myDay = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- My Day (/planner)"))!;
    for (const part of ["Now card", "Tasks & Reminders", "Needs You", "agenda"]) expect(myDay, part).toContain(part);
    expect(NORT_PRODUCT_MAP).not.toMatch(/needs-action|Needs action/i);
  });

  it("Nort's own instructions say Needs You too, where they name the list", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/chat/route.ts"), "utf8");
    expect(route).toContain("it saves instantly to Needs You, on their My Day, for later filing.");
    expect(route).not.toMatch(/Needs-action inbox/);
    const appt = readFileSync(join(process.cwd(), "src/lib/actions/entities/appointment.ts"), "utf8");
    expect(appt).toContain("it clears the visit from Needs You without inventing an estimate");
    expect(appt).not.toMatch(/Needs action/);
  });

  it("names the job's clock by the words on it, not the TIME slot name (W1-20)", () => {
    const jobLine = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- Jobs → one job"))!;
    expect(jobLine).toContain("The job's one clock is the Clock In button at the top of the job");
    expect(jobLine).toContain("a tech's dock is Clock In, Photo, Call, Navigate");
    expect(jobLine).toContain("the Time tab lists the hours (and the office's Add Time Entry) but clocks no one in");
    expect(NORT_PRODUCT_MAP).not.toMatch(/\bTIME\b/);
    // True in code: the button's three faces, and the Time tab holds no clock of its own.
    const button = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-time-button.tsx"), "utf8");
    expect(button).toContain('{state === "in" && t("jb_clockIn")}');
    expect(button).toMatch(/\{t\("jb_switch"\)\}<span/);
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    expect(page).not.toContain("job-time-button");
    expect(readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-action-dock.tsx"), "utf8")).toContain("job-time-button");
  });

  it("a job already on hold keeps its day: Nort never reads back 'a week' for a re-hold", () => {
    // 0366's jobs_hold_day gives the week only to a job ENTERING hold; a held job's new reason
    // keeps its day (setJobHold sends no hold_until), and list_jobs doesn't show that day.
    const route = readFileSync(join(process.cwd(), "src/app/api/chat/route.ts"), "utf8");
    expect(route).toContain(
      "No day said → leave until out: a job going on hold comes back in a week (say so); a job already on hold (list_jobs shows its status) keeps the day it has, which you can't see, so say it keeps its day and name none, or pass until when they name a new one.",
    );
    expect(route).not.toContain("it comes back in a week, and say so");
  });

  it("names Analytics' money in the profit and loss's own words, from the same data the screens read (2026-09-28)", () => {
    const line = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- Analytics (/analytics"))!;
    expect(line).toBeTruthy();
    // The layout, top to bottom, in the screens' words.
    let from = 0;
    for (const w of [
      "Revenue",
      "Cost of Goods Sold (COGS): Materials & Bills, Stock Lost, Crew Pay (1099) and Crew Mileage Paid",
      "Total COGS",
      "Gross Profit and Gross Margin %",
      "Overhead: Fuel, Auto, Tools & Supplies, Phone & Office, Insurance & Licenses, Fees, Rent and Other",
      "Total Overhead",
      "Net Profit, before income tax",
    ]) {
      const i = line.indexOf(w, from);
      expect(i, w).toBeGreaterThanOrEqual(from);
      from = i + w.length;
    }
    // BOTH HALVES, OR NORT REPEATS HALF A FACT AS THE WHOLE ONE (0373). It said "The owner's hours are
    // hours, never a cost", which is now only true of the profit and loss and false of the job.
    expect(line).toContain("his hours on a job ARE a direct cost of that job, at a cost rate he sets");
    expect(line).toContain("books the same amount straight back");
    expect(line).toContain("He is never paid wages for any of it.");
    // And the equity line is named as what it is, below the bottom line.
    expect(line).toContain("below the line Owner's Draw, which is equity");
    expect(line).toContain("you cannot read the card itself, so point to it");
    // True in code: the lines come from profit-and-loss.ts (the card's layout, stock inside
    // Materials & Bills), and the halves from BUCKET_SECTION.
    expect(line).toContain(cogsWords({ stockInMaterials: true }));
    expect(line).toContain(overheadWords());
    const card = readFileSync(join(process.cwd(), "src/app/(app)/analytics/left-for-card.tsx"), "utf8");
    // The card's own options, now one per line (0373 added the owner's two): stock inside Materials &
    // Bills, the margin, the build-time pair and the draw below the line.
    for (const opt of ["stockInMaterials: true", "margin: true", "ownerBuildTime:", "ownerDraw:"]) {
      expect(card, opt).toContain(opt);
    }
    const nav = readFileSync(join(process.cwd(), "src/app/(app)/analytics/page.tsx"), "utf8");
    expect(nav).toContain("For Your Accountant");
    expect(readFileSync(join(process.cwd(), "src/app/(app)/analytics/office-switch.tsx"), "utf8")).toContain('aria-label="Office Can See This"');
    // The old money words are gone from Nort's map.
    expect(NORT_PRODUCT_MAP).not.toMatch(/Business Costs|Left For You|Net Profit \(before income tax\)/);
  });

  it("names the Schedule's doors by the words on them: Add to Schedule, This Day, Offer Dates", () => {
    const line = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- Schedule (/schedule)"))!;
    for (const part of ["Add to Schedule", "This Day", "Offer Dates", "Nobody", "two hours"]) expect(line, part).toContain(part);
    // True in code: the open spots and the day view's button say Add to Schedule, the sheet saves
    // with it, the block's sheet says This Day, the chips say Nobody, and a pick with no length
    // gets two hours (0370's job_takes_picked_day: 120 minutes).
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(src("src/components/time-grid.tsx")).toContain('addLabelProp ?? t("ag_cal_btn_addToSchedule")');
    expect(calendarWordsEn.ag_cal_btn_addToSchedule).toBe("Add to Schedule");
    expect(src("src/app/(app)/calendar/calendar-view.tsx")).toContain('<Plus className="h-4 w-4" /> {t("ag_cal_btn_addToSchedule")}');
    expect(src("src/app/(app)/schedule/add-to-schedule-sheet.tsx")).toContain('saveLabel={t("ag_rail_btn_addToSchedule")}');
    expect(src("src/app/(app)/schedule/tile-sheet.tsx")).toContain('t(dayHours ? "ag_cal_thisDayOwnHours" : "ag_cal_thisDayOnly"), { day: dw(day) }');
    expect(calendarWordsEn.ag_cal_thisDayOwnHours).toBe("This Day, {day}: its own hours. The job's other days keep theirs.");
    expect(src("src/components/crew-initials.tsx")).toContain('t("ag_cal_btn_nobody")');
    expect(calendarWordsEn.ag_cal_btn_nobody).toBe("Nobody");
    expect(src("src/app/(app)/jobs/[id]/propose-dates-button.tsx")).toContain('"Offer Dates"');
    expect(src("supabase/migrations/0370_each_day_keeps_its_own_hours.sql")).toMatch(/\+ 120\b/);
  });

  /* THE WAVE 2 RELEASE MADE THREE OF NORT'S SENTENCES FALSE, so the release rewrote them and pins
     them here. Each is checked the way this file checks every other line: the words Nort reads, and
     then the code that makes them true. Lane 6 (one lead link, Nort's words) is NOT in this release;
     when it lands and rewrites these lines, it keeps these facts or changes the code first. */
  it("Add by Hand says it CAN put stock in, because now it does (W1-FU-misc B)", () => {
    const line = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- Money → Bills (/bills)"))!;
    // The old claim was the opposite, and the typed sheet now disproves it.
    expect(line).not.toMatch(/never adds stock/);
    for (const part of ["Shop Stock, which asks What Is It, How Many and the unit", "while the Shop Stock switch is on"]) {
      expect(line, part).toContain(part);
    }
    // True in code: the typed sheet offers Shop Stock and saves it through the stock writer.
    const sheet = readFileSync(join(process.cwd(), "src/components/quick-cost-button.tsx"), "utf8");
    expect(sheet).toContain('import { addStockPurchase } from "@/app/(app)/inventory/actions"');
    expect(sheet).toMatch(/addStockPurchase\(purchase\)/);
  });

  /**
   * NORT CALLS THE SITE VISIT WHAT THE APP CALLS IT, AND BOTH HALVES OF THIS LINE HAD BEEN WRONG.
   *
   * W2-10 (cn-v1034, 2026-09-30) made this line say "Walk-Throughs" and "inspection is kept for the city's".
   * Erik reversed the word on 2026-10-03, so the first half was wrong; and the second half was
   * never right — the city's is its OWN type, final_inspection, labelled Final Inspection, so
   * nothing had to be reserved for it. This test now forbids the OLD word in Nort's vocabulary.
   */
  it("gives Nort one word for the site visit — Inspection — and names the city's as its own type", () => {
    // The old word reaches nobody through Nort: not a surface name, not a verb, not an aside.
    for (const line of NORT_PRODUCT_MAP.split("\n")) {
      expect(line, line.slice(0, 48)).not.toMatch(/walk.?through/i);
    }
    expect(NORT_PRODUCT_MAP).toContain("- Sales → Inspections (/inspections):");
    // And the city's is told apart by its own name, not by reserving the word this page uses.
    const sales = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- Sales → Inspections"))!;
    expect(sales).toContain("Final Inspection");
    expect(sales).toContain("the job's permit");
    // True in code: the one label the app reads it by, and the dock row that opens it.
    expect(appointmentTypeLabel("inspection")).toBe("Inspection");
    expect(appointmentTypeLabel("final_inspection")).toBe("Final Inspection");
    expect(DOCK.find((s) => s.key === "sales")!.children.find((c) => c.href === "/inspections")?.label).toBe("Inspections");
  });

  it("names what a past day and a dateless job now do on the Schedule (SV-actual, SV-ghost, W2-05)", () => {
    const line = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- Schedule (/schedule)"))!;
    for (const part of ["hollow", "Book This Day", "Waiting for a Day", "Undo"]) expect(line, part).toContain(part);
    // Booking a worked day touches that day ONLY — the sentence promises it, the writer must keep it.
    expect(line).toContain("not the job's status, its listed day or any hold");
    // True in code: the ghost's own door, the rail's heading, and the past-only read behind it.
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(src("src/app/(app)/schedule/ghost-sheet.tsx")).toContain("Book This Day");
    expect(src("src/app/(app)/schedule/page.tsx")).toContain('t("nv_sched_waitingForADay")');
    expect(nav.en.nv_sched_waitingForADay).toBe("Waiting for a Day");
    expect(src("src/app/(app)/schedule/actions.ts")).toMatch(/export async function bookWorkedDay/);
    // bookWorkedDay never promotes: that is the whole difference from addJobDay.
    expect(src("src/app/(app)/schedule/actions.ts")).toMatch(/promote: false/);
  });

  /**
   * RECONCILE IS ON THE MAP — AND NOTHING DOCKED CAN SHIP OFF IT IN SILENCE AGAIN.
   *
   * This file's own header calls the map part of the ship ritual: "when a deploy adds or moves a
   * user-facing surface, this file moves with it, in the same commit". Reconcile shipped in cn-v1037
   * docked under Money AND badged, with no line here. So asked where to fix a supplier spelled five
   * ways, Nort said he could not help — about a page built for exactly that — instead of "Money →
   * Reconcile". The ritual was a sentence in a comment; it is a test now.
   *
   * Every docked screen is either named by its route in the map, or written down below as OWED, with
   * what partial cover it has. The owed list is FROZEN: a new dock row is red until somebody decides
   * on purpose which of the two it is.
   */
  const OWED: Record<string, string> = {
    "/price-list": "named only inside Settings → Money's line (\"price list (CSV import)\"), not as the Money → Price List page",
    "/payroll": "no line at all — Nort cannot point at Payroll",
    "/tax-report": "no line at all — the Analytics line names For Your Accountant, which is a different door",
    "/recurring": "no line at all",
    "/compliance": "named only in the Office cluster sentence",
    "/insurance": "no line at all",
    "/safety": "no line at all",
    "/audits": "no line at all",
    "/team": "named only in the Office cluster sentence",
    "/employee-docs": "no line at all",
    "/forms": "named only in the Office cluster sentence",
    "/resources": "named only in the Office cluster sentence",
    "/handbook": "no line at all",
    "/activity": "no line at all",
    "/audit": "no line at all",
    "/settings": "named by its groups (Settings → Playbook / Website / Money / You), never by its path",
  };

  it("every docked screen is either on the map by its route, or written down as owed", () => {
    const docked = [
      ...new Set(
        [...visibleDock({ isStaff: true, features: ALL_ON }), ...visibleDock({ isStaff: false, features: ALL_ON })]
          .flatMap((s) => s.children)
          .flatMap((c) => (c.href ? [c.href.split("?")[0]] : [])),
      ),
    ].sort();
    const onMap = docked.filter((p) => NORT_PRODUCT_MAP.includes(p));
    const missing = docked.filter((p) => !NORT_PRODUCT_MAP.includes(p));
    // Nothing may be missing that is not argued for in writing, and nothing may be argued for that
    // is no longer missing: both directions, so the list cannot rot either way.
    expect(missing.sort()).toEqual(Object.keys(OWED).sort());
    expect(onMap.length).toBeGreaterThan(10);
  });

  it("Reconcile is one of them: the page for two records that should agree", () => {
    const line = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- Money → Reconcile (/reconcile"))!;
    expect(line).toBeTruthy();
    expect(Object.keys(OWED)).not.toContain("/reconcile");
    // Its five sections, in the words the page draws them in, and in its order.
    let from = 0;
    for (const kind of Object.values(RECONCILE_KINDS).sort((a, b) => a.order - b.order)) {
      const i = line.indexOf(kind.heading, from);
      expect(i, kind.heading).toBeGreaterThanOrEqual(from);
      from = i + kind.heading.length;
    }
    // The three things the page may not do, so Nort never offers it as the owner of a figure.
    expect(line).toContain("office only");
    expect(line).toContain("It owns no record and adds up no amount of its own");
    expect(line).toContain("supplier_balances");
    // The gap is answered where the record lives, which the kinds table says by name.
    expect(RECONCILE_KINDS["supplier-gap"].answeredOn).toEqual({ screen: "Suppliers", href: "/bills#suppliers" });
    expect(line).toContain("answered on the Suppliers card on Bills");
    // True in code: docked under Money, office only, and badged over the kinds answered here.
    const money = DOCK.find((s) => s.key === "invoices")!;
    expect(money.children.find((c) => c.href === "/reconcile")).toMatchObject({ label: "Reconcile", staffOnly: true });
    expect(readFileSync(join(process.cwd(), "src/app/(app)/reconcile/page.tsx"), "utf8")).toContain(
      '<PageHeader title={t("nv_page_reconcile")} description={t("nv_desc_reconcile")} />',
    );
    expect(nav.en.nv_page_reconcile).toBe("Reconcile");
    expect(nav.en.nv_desc_reconcile).toBe("Two records that should agree, and do not.");
  });

  it("Nort can set every customer type the app offers, Contractor included (W2-13 Part A)", () => {
    // The forms offer it, so the agent's writers must accept it: a type you can pick in the app and
    // not say to Nort is a door that dead-ends.
    const entity = readFileSync(join(process.cwd(), "src/lib/actions/entities/customer.ts"), "utf8");
    const enums = entity.match(/z\.enum\(\["residential"[^)]*\)/g) ?? [];
    expect(enums.length).toBe(2); // customer.create and customer.update
    for (const e of enums) expect(e).toContain('"contractor"');
    for (const p of ["src/app/(app)/crm/new-customer-button.tsx", "src/app/(app)/crm/[id]/edit-customer-button.tsx"]) {
      // The option's words live in lib/words/customers since cn-v1146: the key, whose English is Contractor.
      expect(readFileSync(join(process.cwd(), p), "utf8"), p).toContain('<option value="contractor">{t("cu_btn_typeContractor")}</option>');
    }
    expect(dict("en").cu_btn_typeContractor).toBe("Contractor");
  });
});

/**
 * THE LEADS REWORK (cn-v1170). Erik, 2026-11-19: "if a lead is still on the lead page that IS the
 * reminder and the follow up reminders dont really work, one badge one list simple". Nort says the
 * Leads list is new intake only, with Schedule, Not Sold and Edit Details; the one word is Not Sold.
 */
describe("Nort's map after the Leads rework", () => {
  const leads = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- Sales → Leads (/leads)")) ?? "";
  const needsYou = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- My Day → Needs You")) ?? "";
  const inspections = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- Sales → Inspections")) ?? "";

  it("the Leads list is new intake, it is the reminder, and its row's doors are Schedule, Not Sold, Edit Details", () => {
    expect(leads).toContain("NEW INTAKE ONLY");
    expect(leads).toContain("the list IS the reminder: there is no follow-up day");
    expect(leads).toContain("three doors: Schedule, Not Sold, Edit Details");
    expect(leads).toContain("Book It (a day and a time), Let Them Pick");
    expect(leads).toContain("Start Now");
    expect(leads).toContain("it always books an INSPECTION");
    expect(leads).toContain("/leads/<id>");
    expect(leads).toContain("the Not Sold fold at the bottom of the Leads page, where Reopen puts it back");
    expect(leads).toContain("Lead Sources");
    for (const gone of [/Follow Up/, /Mark Contacted/, /Mark Lost/, /Inspection · Schedule · Estimate/, /Uncontacted leads badge/]) expect(leads).not.toMatch(gone);
  });

  it("Needs You's lead row and a visit's ending say Not Sold, and no lead is snoozed", () => {
    expect(needsYou).toContain("honest ending (Not Sold, Not Needed, Dismiss, Cancel, Set Aside");
    expect(needsYou).toContain("its button is Schedule");
    expect(needsYou).toContain("it has no Snooze and no follow-up day");
    expect(inspections).toContain("Not Sold is a visit that happened and wasn't won");
    expect(NORT_PRODUCT_MAP).not.toMatch(/\bLost is a visit\b/);
    expect(NORT_PRODUCT_MAP).not.toMatch(/\(Lost, Not Needed/);
  });

  it("the site chat's lead source is the one the code writes", () => {
    expect(NORT_PRODUCT_MAP).toContain("source 'site_chat'");
    expect(NORT_PRODUCT_MAP).not.toContain("website_chat");
    expect(readFileSync(join(process.cwd(), "src/lib/inquiries/sources.ts"), "utf8")).toContain('"site_chat"');
  });

  it("the chat route teaches no follow-up day for a lead, and no inquiry.snooze", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/chat/route.ts"), "utf8");
    expect(route).not.toContain("inquiry.snooze");
    expect(route).toContain("a lead has NO follow-up day: it stays on the Leads list until it is scheduled (its inspection booked) or marked Not Sold");
    expect(route).toContain("inquiry.markLost (kept on file, marked Not Sold)");
  });
});
