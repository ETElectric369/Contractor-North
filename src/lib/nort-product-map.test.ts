import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/tts", () => ({ unlockAudio: vi.fn() }));

import { NORT_PRODUCT_MAP } from "./nort-product-map";
import { cogsWords, overheadWords } from "./analytics/profit-and-loss";
import { DOCK, visibleDock } from "./dock";
import { helpRows } from "./onboarding/help-rows";
import { ALL_ON } from "./features";
import { appointmentTypeLabel } from "./statuses";

/**
 * WHERE NORT SAYS THINGS LIVE, HELD TO WHERE THEY DO (W1-09 / W1-07 / W1-08). A map that lags the
 * product recreates the failure it was built to end ("I can't do that" about a shipped feature),
 * so each line this wave rewrote is checked against the code that makes it true.
 */
describe("Nort's product map after the shell wave", () => {
  it("names Search Or Ask, not the graduation cap, and what is inside it", () => {
    expect(NORT_PRODUCT_MAP).not.toMatch(/graduation cap|the cap\b/i);
    expect(NORT_PRODUCT_MAP).toContain(
      "Search Or Ask (top bar): search anything, or ask Nort (Talk To Nort, or type); Start Here, Finish Setting Up and Show Me How live inside it (Nort off: Search, and those rows under Help in the avatar menu).",
    );
    // True in code: the rows exist, with those names, and Talk To Nort leads the sheet.
    const labels = helpRows({ isStaff: true, onboarded: false, setup: {}, nortOn: true, features: ALL_ON }).map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(["Start Here", "Show Me How"]));
    const withOpen = helpRows({ isStaff: true, onboarded: true, setup: {}, nortOn: true, features: ALL_ON }).map((r) => r.label);
    expect(withOpen.some((l) => l.startsWith("Finish Setting Up"))).toBe(true);
    expect(readFileSync(join(process.cwd(), "src/components/command-bar.tsx"), "utf8")).toContain('label: "Talk To Nort"');
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
    expect(button).toContain('{state === "in" && "Clock In"}');
    expect(button).toMatch(/Switch<span/);
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
      "Overhead: Fuel, Auto, Tools & Supplies, Phone & Office, Insurance & Licenses, Fees and Other",
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

  it("names the Schedule's doors by the words on them: Add To Schedule, This Day, Offer Dates", () => {
    const line = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- Schedule (/schedule)"))!;
    for (const part of ["Add To Schedule", "This Day", "Offer Dates", "Nobody", "two hours"]) expect(line, part).toContain(part);
    // True in code: the open spots and the day view's button say Add To Schedule, the sheet saves
    // with it, the block's sheet says This Day, the chips say Nobody, and a pick with no length
    // gets two hours (0370's job_takes_picked_day: 120 minutes).
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(src("src/components/time-grid.tsx")).toContain('addLabel = "Add To Schedule"');
    expect(src("src/app/(app)/calendar/calendar-view.tsx")).toMatch(/<Plus className="h-4 w-4" \/> Add To Schedule/);
    expect(src("src/app/(app)/schedule/add-to-schedule-sheet.tsx")).toContain('saveLabel="Add To Schedule"');
    expect(src("src/app/(app)/schedule/tile-sheet.tsx")).toContain("This Day, {dayWords(day)}");
    expect(src("src/components/crew-initials.tsx")).toContain("Nobody");
    expect(src("src/app/(app)/jobs/[id]/propose-dates-button.tsx")).toContain('"Offer Dates"');
    expect(src("supabase/migrations/0370_each_day_keeps_its_own_hours.sql")).toMatch(/\+ 120\b/);
  });

  /* THE WAVE 2 RELEASE MADE THREE OF NORT'S SENTENCES FALSE, so the release rewrote them and pins
     them here. Each is checked the way this file checks every other line: the words Nort reads, and
     then the code that makes them true. Lane 6 (one lead link, Nort's words) is NOT in this release;
     when it lands and rewrites these lines, it keeps these facts or changes the code first. */
  it("Add By Hand says it CAN put stock in, because now it does (W1-FU-misc B)", () => {
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

  it("says Walk-Through where the app says Walk-Through (W2-10), keeping 'inspection' for the city's", () => {
    // No line offers the user the old word for the site visit. Two uses are allowed and no others:
    // the route /inspections (the path never moved — a word changed, not data) and the one sentence
    // that names the word itself to say the city keeps it. Any new prose use fails here.
    for (const line of NORT_PRODUCT_MAP.split("\n")) {
      const prose = line.replace(/\/inspections/g, "").replace(/"inspection" is kept for the city's/, "");
      expect(prose, line.slice(0, 48)).not.toMatch(/\binspections?\b/i);
    }
    expect(NORT_PRODUCT_MAP).toContain("- Sales → Walk-Throughs (/inspections):");
    // True in code: the one label the app reads it by, and the dock row that opens it.
    expect(appointmentTypeLabel("inspection")).toBe("Walk-Through");
    expect(DOCK.find((s) => s.key === "sales")!.children.find((c) => c.href === "/inspections")?.label).toBe("Walk-Throughs");
  });

  it("names what a past day and a dateless job now do on the Schedule (SV-actual, SV-ghost, W2-05)", () => {
    const line = NORT_PRODUCT_MAP.split("\n").find((l) => l.startsWith("- Schedule (/schedule)"))!;
    for (const part of ["hollow", "Book This Day", "Waiting For A Day", "Undo"]) expect(line, part).toContain(part);
    // Booking a worked day touches that day ONLY — the sentence promises it, the writer must keep it.
    expect(line).toContain("not the job's status, its listed day or any hold");
    // True in code: the ghost's own door, the rail's heading, and the past-only read behind it.
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(src("src/app/(app)/schedule/ghost-sheet.tsx")).toContain("Book This Day");
    expect(src("src/app/(app)/schedule/page.tsx")).toContain("Waiting For A Day");
    expect(src("src/app/(app)/schedule/actions.ts")).toMatch(/export async function bookWorkedDay/);
    // bookWorkedDay never promotes: that is the whole difference from addJobDay.
    expect(src("src/app/(app)/schedule/actions.ts")).toMatch(/promote: false/);
  });

  it("Nort can set every customer type the app offers, Contractor included (W2-13 Part A)", () => {
    // The forms offer it, so the agent's writers must accept it: a type you can pick in the app and
    // not say to Nort is a door that dead-ends.
    const entity = readFileSync(join(process.cwd(), "src/lib/actions/entities/customer.ts"), "utf8");
    const enums = entity.match(/z\.enum\(\["residential"[^)]*\)/g) ?? [];
    expect(enums.length).toBe(2); // customer.create and customer.update
    for (const e of enums) expect(e).toContain('"contractor"');
    for (const p of ["src/app/(app)/crm/new-customer-button.tsx", "src/app/(app)/crm/[id]/edit-customer-button.tsx"]) {
      expect(readFileSync(join(process.cwd(), p), "utf8"), p).toContain('<option value="contractor">Contractor</option>');
    }
  });
});
