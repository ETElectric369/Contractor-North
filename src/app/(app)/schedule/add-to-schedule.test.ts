import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ADD TO SCHEDULE FROM THE SCHEDULE, FOR ANY JOB (Erik, 2026-09-28: "i want to put honysuckle on the
 * page for the rest of the day after Siskin but theres no way to add to the schedule from the schedule
 * page unless its already scripted"). An open spot on a day, or the day's "+", opens one sheet: the job
 * (searched, most recent first, by its name with its street and who), the day, the time (the same
 * controls as everywhere, two hours said when nobody chose), who's on it. The office only; every door
 * 44px; no money.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("./actions", () => ({ addJobDay: vi.fn(), startJobOnDay: vi.fn() }));

import {
  AddToScheduleSheet,
  FoundRows,
  PickedSections,
  addableLine,
  dayLineKey,
  defaultDraft,
  findAddable,
  makesNewJob,
  newJobForWords,
  newJobHereWords,
  newJobHref,
  nextDraft,
  type AddableJob,
  type Picked,
} from "./add-to-schedule-sheet";
import { translator } from "@/lib/i18n";
import { LangProvider } from "@/components/lang-provider";
import type { FoundCustomer, PastJob } from "@/lib/schedule/find-for-day";
import { TimeGrid, slotMinute } from "@/components/time-grid";

const WORK_DAY = { start: "09:00", end: "17:00" };
const team = [
  { id: "p-erik", full_name: "Erik Taylor" },
  { id: "p-brian", full_name: "Brian Cole" },
];
const jobs: AddableJob[] = [
  { id: "j011", name: "Honeysuckle", status: "in_progress", address: "22 Honeysuckle Way", city: "Truckee", planned_minutes: null, assigned_to: ["p-erik"], customers: { name: "Kim Hale" } },
  { id: "j060", name: "498 May Dell Lane", status: "on_hold", address: "498 May Dell Lane", city: "Truckee", planned_minutes: 240, assigned_to: [], customers: { name: "Marla Finch" } },
  { id: "j061", name: "12 Elm St", status: "to_be_scheduled", address: "12 Elm St", city: "Kings Beach", planned_minutes: 960, assigned_to: [], customers: null, job_number: "J-061" },
];
const doors = (html: string) => html.match(/<(button|a|input)\b[^>]*>/g) ?? [];
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("the sheet", () => {
  const html = renderToStaticMarkup(
    createElement(AddToScheduleSheet, { at: { day: "2026-09-28", minute: 720 }, jobs, team, workDay: WORK_DAY, onClose: () => {} }),
  );

  it("opens on the day and the half hour tapped: the job search, the jobs with their street and who, the day, the time", () => {
    const t = text(html);
    expect(t).toContain("Add to Schedule");
    expect(html).toMatch(/<input[^>]*aria-label="Find a job"/);
    expect(t).toContain("Honeysuckle");
    expect(t).toContain("22 Honeysuckle Way · Kim Hale");
    // A job named for its street: who, not the street twice.
    expect(t).toContain("498 May Dell Lane Marla Finch");
    expect(html).toMatch(/<input[^>]*type="date"[^>]*value="2026-09-28"/);
    expect(t).toContain("Mon, Sep 28. The job keeps every other day it has.");
    // Noon, and two hours said as nobody's choice, until a job is picked.
    expect(html).toMatch(/<input[^>]*type="time"[^>]*value="12:00"/);
    expect(html).toMatch(/<input[^>]*type="time"[^>]*value="14:00"/);
    expect(t).toContain("12:00 PM – 2:00 PM · 2 hours — change it");
    for (const chip of ["1h", "2h", "4h", "Full Day"]) expect(html).toMatch(new RegExp(`<button[^>]*>${chip}</button>`));
    // A draft: the time controls never say Saving or Saved; the sheet's own button writes.
    expect(t).not.toContain("Saved");
  });

  it("every door is 44px, and Add to Schedule waits for a job", () => {
    // The Modal's own header X is the app's shared chrome, the same on every sheet.
    const ds = doors(html).filter((d) => !d.includes('aria-label="Close"'));
    expect(ds.length).toBeGreaterThan(8);
    for (const d of ds) expect(d, d).toMatch(/\b(min-)?h-11\b/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add to Schedule<\/button>/);
  });

  it("from the day's +: the work day's start", () => {
    const plus = renderToStaticMarkup(createElement(AddToScheduleSheet, { at: { day: "2026-09-28", minute: null }, jobs, team, workDay: WORK_DAY, onClose: () => {} }));
    expect(plus).toMatch(/<input[^>]*type="time"[^>]*value="09:00"/);
  });

  it("no money anywhere in it", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/schedule/add-to-schedule-sheet.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    expect(src).not.toMatch(/\b(prices?|amounts?|totals?|costs?|rates?|bill_rate|pay_rate)\b|formatCurrency|\$\d/i);
  });
});

describe("the sheet's words and search", () => {
  it("a job's line: its street unless its name is the street, and who unless its name says who", () => {
    expect(addableLine(jobs[0])).toBe("22 Honeysuckle Way · Kim Hale");
    expect(addableLine(jobs[1])).toBe("Marla Finch");
    expect(addableLine({ name: "Marla Finch · Panel Upgrade", address: null, customers: { name: "Marla Finch" } })).toBe("");
  });

  it("search: every word, anywhere in the name, the street, who, the number or the town", () => {
    expect(findAddable(jobs, "honey").map((j) => j.id)).toEqual(["j011"]);
    expect(findAddable(jobs, "marla 498").map((j) => j.id)).toEqual(["j060"]);
    expect(findAddable(jobs, "J-061").map((j) => j.id)).toEqual(["j061"]);
    expect(findAddable(jobs, "kings").map((j) => j.id)).toEqual(["j061"]);
    expect(findAddable(jobs, "  ").map((j) => j.id)).toEqual(["j011", "j060", "j061"]);
  });

  it("the length a picked job starts with: its size, a day or more the whole work day, nobody's two hours", () => {
    expect(defaultDraft("12:00", null, WORK_DAY)).toEqual({ start: "12:00", end: "14:00", sized: false });
    expect(defaultDraft("12:00", 240, WORK_DAY)).toEqual({ start: "12:00", end: "16:00", sized: true });
    expect(defaultDraft("12:00", 960, WORK_DAY)).toEqual({ start: "12:00", end: "17:00", sized: true });
    expect(defaultDraft("18:00", 960, WORK_DAY)).toEqual({ start: "18:00", end: "19:00", sized: true });
  });

  it("a new start with no length chosen shows the end the save will store (the job's size, not the drawn hours)", () => {
    // Tapped at 10:00, a job sized a day: 10 to closing. Only the Start moves to 11:00: the save sends
    // no length and the writer runs a day's size to closing, so the sheet says 11 to 5, never 11 to 6.
    const base = defaultDraft("10:00", 480, WORK_DAY);
    expect(nextDraft({ now: base, chosen: false, sizeMinutes: 480, workDay: WORK_DAY, patch: { start: "11:00" } })).toEqual({
      hours: { start: "11:00", end: "17:00" },
      chosen: false,
    });
    // Unsized: two hours from the new start; sized under a day: its size.
    expect(nextDraft({ now: { start: "10:00", end: "12:00" }, chosen: false, sizeMinutes: null, workDay: WORK_DAY, patch: { start: "15:30" } })?.hours).toEqual({ start: "15:30", end: "17:30" });
    expect(nextDraft({ now: { start: "10:00", end: "14:00" }, chosen: false, sizeMinutes: 240, workDay: WORK_DAY, patch: { start: "13:00" } })?.hours).toEqual({ start: "13:00", end: "17:00" });
    // A length chosen is the length the save sends: a new start keeps it on the clock.
    const picked = nextDraft({ now: base, chosen: false, sizeMinutes: 480, workDay: WORK_DAY, patch: { length: 120 } });
    expect(picked).toEqual({ hours: { start: "10:00", end: "12:00" }, chosen: true });
    expect(nextDraft({ now: picked!.hours, chosen: true, sizeMinutes: 480, workDay: WORK_DAY, patch: { start: "13:00" } })).toEqual({
      hours: { start: "13:00", end: "15:00" },
      chosen: true,
    });
  });
});

describe("the open spots and the day's +, on the grid", () => {
  const grid = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(TimeGrid, {
        days: [
          { dayStr: "2026-09-28", label: "Mon 28" },
          { dayStr: "2026-09-29", label: "Tue 29" },
        ],
        events: [],
        workStartMin: 540,
        workEndMin: 1020,
        tz: "America/Los_Angeles",
        ...extra,
      }),
    );

  it("with the office's add: every column's open time is a door, and each day header carries a 44px +", () => {
    const html = grid({ onSlotTap: () => {}, onDayClick: () => {} });
    expect(html.match(/<button[^>]*aria-label="Add to Schedule, Mon 28"/g)?.length).toBe(2);
    // 44 by 44: tall AND wide, so a thumb aimed at the + never lands on the day's label beside it.
    const plus = html.match(/<button[^>]*aria-label="Add to Schedule, Tue 29"[^>]*>/)?.[0] ?? "";
    expect(plus).toMatch(/class="[^"]*\bmin-h-11\b/);
    expect(plus).toMatch(/class="[^"]*\b(min-)?w-11\b/);
  });

  it("without it (anyone else, /timecards) or while work is armed, no add door at all", () => {
    expect(grid({})).not.toContain("Add to Schedule");
    expect(grid({ onSlotTap: () => {}, placement: { label: "Place 1 here", onPlace: () => {} } })).not.toContain("Add to Schedule");
  });

  it("a tap is floored to the half hour it lands in, never outside the day", () => {
    // The grid's top is 7 AM (the work day's start less two hours); 48px an hour.
    expect(slotMinute(0, 420)).toBe(420);
    expect(slotMinute(5 * 48 + 20, 420)).toBe(720); // 12:25 → 12:00
    expect(slotMinute(5 * 48 + 30, 420)).toBe(750); // 12:37 → 12:30
    expect(slotMinute(10_000, 420)).toBe(1410);
    expect(slotMinute(-20, 420)).toBe(420);
  });

  it("the schedule wires it for the office only, never while armed, and the sheet only renders for the office", () => {
    const view = readFileSync(join(process.cwd(), "src/app/(app)/calendar/calendar-view.tsx"), "utf8");
    expect(view.match(/onSlotTap=\{canEdit && !target\.armed \? onSlotTap : undefined\}/g)?.length).toBe(2);
    expect(view).toMatch(/\{canEdit && \(\s*<AddToScheduleSheet/);
    expect(view).toMatch(/\{canEdit && !target\.armed && \(\s*<button[\s\S]*?onClick=\{\(\) => onSlotTap\(anchorK, null\)\}/);
    const panel = readFileSync(join(process.cwd(), "src/app/(app)/schedule/calendar-panel.tsx"), "utf8");
    expect(panel).toMatch(/canEdit\s*\?\s*supabase\s*\.from\("jobs"\)\s*\.select\("id, job_number, name, status, address, city, planned_minutes, assigned_to, customers\(name\)"\)\s*\.in\("status", ACTIVE_JOB_STATUSES\)/);
  });
});

/**
 * A PLACE TO GO BACK TO, AND A PERSON (cn-v1159; Erik, 2026-11-10, on the Schedule: "it wont let me add
 * to schedule unless its already a job and [a street] is a job already so why cant it find it?", "or
 * rather is an address of a previous job i need to go back to for more work", "not even an address or a
 * person as it states it can find"). The box said street, name, customer and searched the jobs in flight
 * alone. It now also finds finished jobs and customers; a finished job asks how to go back; a customer
 * starts a new job; anything not on file is the New Job form, opened on the day.
 */
describe("what the box can find, and what a pick does", () => {
  const done: PastJob = { id: "p1", name: "41 Larkspur Ln #5", status: "complete", address: "41 Larkspur Ln", unit: "5", city: "Truckee", planned_minutes: 240, assigned_to: ["p-erik"], customers: { name: "Dana Rook" } };
  const off: PastJob = { id: "p2", name: "Panel Upgrade", status: "cancelled", address: "12 Snowbell Rd", city: "Truckee", customers: null };
  const rook: FoundCustomer = { id: "c1", name: "Dana Rook", company_name: null, address: "9 Bayberry Ct", unit: null, city: "Truckee" };
  const vance: FoundCustomer = { id: "c2", name: "Theo Vance", company_name: "Catbird Builders", address: null, unit: null, city: null };
  const en = translator("en");
  const es = translator("es");
  const sheet = readFileSync(join(process.cwd(), "src/app/(app)/schedule/add-to-schedule-sheet.tsx"), "utf8");
  const html = renderToStaticMarkup(createElement(AddToScheduleSheet, { at: { day: "2026-09-28", minute: 720 }, jobs, team, workDay: WORK_DAY, onClose: () => {} }));

  it("the box says what it finds, and with nothing typed says how to find the rest", () => {
    // What is searched (jobs and customers) and by what (a street or a name): a lead is not, and the box does not say it is.
    expect(html).toMatch(/<input[^>]*placeholder="Find a job or a customer: street or name"/);
    expect(text(html)).toContain("Type a street or a name to find a finished job or a customer too.");
    // Nothing is asked of the server until something is typed: no finished job, no customer, no searching line.
    expect(text(html)).not.toMatch(/Finished Jobs|Customers|Looking through|Nothing matches/);
  });

  it("the rows it finds: finished jobs under their own heading with what they are now, customers under theirs, every row 44px", () => {
    const rows = renderToStaticMarkup(createElement("ul", null, createElement(FoundRows, { past: [done, off], people: [rook, vance], picked: { kind: "past", job: done }, onPick: () => {} })));
    const t = text(rows);
    expect(t).toMatch(/Finished Jobs\s+41 Larkspur Ln #5\s+Dana Rook\s+complete\s+Panel Upgrade\s+12 Snowbell Rd\s+cancelled/);
    expect(t).toMatch(/Customers\s+Dana Rook\s+9 Bayberry Ct · Truckee\s+Customer\s+Theo Vance\s+Catbird Builders\s+Customer/);
    const buttons = rows.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(4);
    for (const b of buttons) expect(b).toMatch(/\bmin-h-11\b/);
    // The one picked is said to a screen reader and drawn picked; the others are not.
    expect(rows.match(/aria-pressed="true"/g)).toHaveLength(1);
    // With nothing found there is no heading left standing over nothing.
    expect(renderToStaticMarkup(createElement("ul", null, createElement(FoundRows, { past: [], people: [], picked: null, onPick: () => {} })))).toBe("<ul></ul>");
  });

  it("a finished job ASKS how to go back: New Job Here first, Reopen This Job beside it, and each says what it does", () => {
    const panel = (back: "new" | "reopen", picked: Picked = { kind: "past", job: done }) =>
      renderToStaticMarkup(createElement(PickedSections, { picked, back, onBack: () => {}, work: "", onWork: () => {} }));
    const asNew = panel("new");
    expect(asNew).toMatch(/<button[^>]*aria-pressed="true"[^>]*>New Job Here<\/button>/);
    expect(asNew).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Reopen This Job<\/button>/);
    expect(asNew.indexOf("New Job Here")).toBeLessThan(asNew.indexOf("Reopen This Job"));
    // WHICH job is said in the section itself: its row may have left the list above by now.
    expect(text(asNew)).toContain("41 Larkspur Ln #5 · Dana Rook · complete");
    expect(text(panel("reopen"))).toContain("41 Larkspur Ln #5 · Dana Rook · complete");
    expect(text(asNew)).toContain("A new job for Dana Rook at 41 Larkspur Ln #5. The old job stays complete.");
    // A new job takes a few optional words; a reopened job already has its own.
    expect(asNew).toMatch(/<input[^>]*id="add-to-schedule-work"[^>]*maxLength="500"/);
    const reopened = panel("reopen");
    expect(reopened).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Reopen This Job<\/button>/);
    expect(text(reopened)).toContain("This job goes back on the schedule as Scheduled. New hours and parts land on it.");
    expect(reopened).not.toContain("add-to-schedule-work");
    // Every door 44px.
    for (const d of [...(asNew.match(/<(button|input)\b[^>]*>/g) ?? []), ...(reopened.match(/<(button|input)\b[^>]*>/g) ?? [])]) expect(d, d).toMatch(/\b(min-)?h-11\b/);
    // A job in flight, or nothing picked, draws none of it.
    expect(panel("new", { kind: "job", id: "j011" })).toBe("");
    expect(renderToStaticMarkup(createElement(PickedSections, { picked: null, back: "new", onBack: () => {}, work: "", onWork: () => {} }))).toBe("");
  });

  it("the sentence under New Job Here names who and where when it has them, and never invents either", () => {
    // "The old job", never its name: a job is named for its street, so both would carry the same one.
    expect(newJobHereWords(done, "en", en)).toBe("A new job for Dana Rook at 41 Larkspur Ln #5. The old job stays complete.");
    expect(newJobHereWords(off, "en", en)).toBe("A new job at 12 Snowbell Rd. The old job stays cancelled.");
    expect(newJobHereWords({ ...off, address: null, customers: { name: "Sam Tillery" } }, "en", en)).toBe("A new job for Sam Tillery. The old job stays cancelled.");
    // No street and nobody: nothing is claimed about its name (the namer decides it on the server).
    expect(newJobHereWords({ ...off, address: null }, "en", en)).toBe("A new job. The old job stays cancelled.");
    // Spanish says the status in lower case inside the sentence.
    expect(newJobHereWords(done, "es", es)).toBe("Un trabajo nuevo para Dana Rook en 41 Larkspur Ln #5. El trabajo anterior sigue terminado.");
  });

  it("a customer starts a new job at the address on their card, or one named for them when there is none", () => {
    const panel = (who: FoundCustomer) => text(renderToStaticMarkup(createElement(PickedSections, { picked: { kind: "customer", who }, back: "new", onBack: () => {}, work: "", onWork: () => {} })));
    expect(panel(rook)).toContain("A new job for Dana Rook at 9 Bayberry Ct.");
    expect(panel(rook)).toContain("What's the Work?");
    // No claim about what the job will be called: a business is named for its company, not the person.
    expect(newJobForWords(vance, en)).toBe("A new job for Theo Vance. No address is on their card: add it on the job.");
    // No go-back choice for a person: there is no old job to reopen.
    expect(panel(rook)).not.toMatch(/Reopen This Job|New Job Here/);
  });

  it("which picks make a new job, and what the day is to each", () => {
    expect(makesNewJob({ kind: "customer", who: rook }, "reopen")).toBe(true);
    expect(makesNewJob({ kind: "past", job: done }, "new")).toBe(true);
    expect(makesNewJob({ kind: "past", job: done }, "reopen")).toBe(false);
    expect(makesNewJob({ kind: "job", id: "j011" }, "new")).toBe(false);
    expect(makesNewJob(null, "new")).toBe(false);
    expect(dayLineKey(null, "new")).toBe("ag_rail_dayKeepsOthers");
    expect(dayLineKey({ kind: "job", id: "j011" }, "new")).toBe("ag_rail_dayKeepsOthers");
    expect(dayLineKey({ kind: "past", job: done }, "new")).toBe("ag_rail_dayNewJob");
    expect(dayLineKey({ kind: "past", job: done }, "reopen")).toBe("ag_rail_dayReopen");
    expect(dayLineKey({ kind: "customer", who: rook }, "new")).toBe("ag_rail_dayNewJob");
  });

  it("somebody or somewhere not on file yet: the New Job form, opened on the day and hour, by a link that leaves the sheet open", () => {
    expect(html).toMatch(/<a[^>]*href="\/jobs\?new=1&amp;date=2026-09-28&amp;time=12:00"[^>]*>/);
    expect(text(html)).toContain("New Job on Mon, Sep 28");
    expect(text(html)).toContain("Not here? A new customer or a new address starts with a new job.");
    expect(newJobHref("2026-09-28", "12:00")).toBe("/jobs?new=1&date=2026-09-28&time=12:00");
    expect(newJobHref("2026-09-28", "")).toBe("/jobs?new=1&date=2026-09-28");
    expect(newJobHref("", "12:00")).toBe("/jobs?new=1");
    expect(newJobHref("2026-09-28", "25:99")).toBe("/jobs?new=1&date=2026-09-28");
    // Only a day and a time ride in the address: never a name, a street or what was typed.
    expect(sheet).not.toMatch(/jobs\?new=1[^`"]*\$\{(?!day\b|startHm\b|\/)/);
    // The New Job form reads them, opens on that day, and takes them back off the address.
    const form = readFileSync(join(process.cwd(), "src/app/(app)/schedule/new-job-button.tsx"), "utf8");
    expect(form).toContain('const dayAsked = searchParams.get("date") ?? "";');
    expect(form).toContain("setForm((f) => ({ ...f, scheduled_date: dayAsked, scheduled_time: hm }));");
    expect(form).toContain('params.delete("date");');
    expect(form).toContain('params.delete("time");');
    // The carried day is the start of THAT open only: closing and saving each put the fresh form's snapshot
    // back (two), beside the first render's own (one).
    expect(form.match(/initialSnap\.current = JSON\.stringify\(emptyForm\(\)\);/g)).toHaveLength(3);
    expect(form).toMatch(/function discard\(\) \{[\s\S]{0,420}initialSnap\.current = JSON\.stringify\(emptyForm\(\)\);/);
  });

  it("the search beyond the jobs in flight is asked of the server in a POST body, a moment after the typing stops, and a failure is said", () => {
    expect(sheet).toContain('fetch("/api/schedule/find", {');
    expect(sheet).toContain('method: "POST",');
    expect(sheet).toContain("body: JSON.stringify({ q: query }),");
    expect(sheet).not.toMatch(/api\/schedule\/find\?/);
    expect(sheet).toContain("signal: asked.signal,");
    expect(sheet).toContain('if (!asked.signal.aborted) setFinding("failed");');
    expect(sheet).toContain('{finding === "failed" && <li className="px-3 py-2 text-xs text-amber-700">{t("ag_rail_searchFailed")}</li>}');
    // Nothing anywhere is only said once the server HAS answered; before that it is the in-flight list's own sentence.
    expect(sheet).toContain('t(asking && finding === "idle" && found ? "ag_rail_nothingMatches" : "ag_rail_noJobMatches")');
  });

  it("the save: a new job through startJobOnDay by ID alone, a reopen said to addJobDay, and a job made without its day is never made twice", () => {
    expect(sheet).toContain('res = await startJobOnDay(going.kind === "customer" ? { customerId: going.who.id } : { pastJobId: going.job.id }, {');
    expect(sheet).toContain("res = await addJobDay(id, payload, { reopen });");
    expect(sheet).toContain("res = await addJobDay(id, payload, { reopen, cancelProposals: true });");
    expect(sheet).toContain('const reopen = going.kind === "past";');
    // Made, but its day failed: the pick becomes that job, so the next tap adds the day and makes nothing.
    expect(sheet).toMatch(/if \(!res\.ok && res\.id\) \{[\s\S]*?setPicked\(\{ kind: "job", id: res\.id \}\);[\s\S]*?router\.refresh\(\);/);
    // The button waits for something picked that it can act on.
    expect(sheet).toContain('const ready = !!picked && (picked.kind !== "job" || !!job);');
  });

  it("Spanish: the same doors and sentences, none left in English", () => {
    const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LangProvider, { lang: "es" } as never, el));
    const t = text(
      wrap(createElement("div", null, createElement("ul", null, createElement(FoundRows, { past: [done], people: [rook], picked: null, onPick: () => {} })), createElement(PickedSections, { picked: { kind: "past", job: done }, back: "new", onBack: () => {}, work: "", onWork: () => {} }))),
    );
    for (const w of ["Trabajos Terminados", "Clientes", "Cliente", "Para Regresar", "Trabajo Nuevo Aquí", "Reabrir Este Trabajo", "¿Cuál Es el Trabajo?"]) expect(t, w).toContain(w);
    expect(t).not.toMatch(/Finished Jobs|Customers|Going Back|New Job Here|Reopen This Job|What's the Work/);
  });
});
