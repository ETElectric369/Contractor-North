import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

/**
 * ADD TIME ENTRY, THE ONE ADD-HOURS FORM (Wave 2, W2-03): eleven fields down to six (Who, Job, Day,
 * Start, End, Lunch; Job Code only while the switch is on), on Timecards and on the job's Time tab.
 * The Job is always a choice somebody made: the schedule's job for that day, a pick, Company Time,
 * or (with no such code) No Job, never a silent default.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../timeclock/actions", () => ({
  createManualEntry: vi.fn(async () => ({ ok: true, id: "new" })),
  shiftsOnDay: vi.fn(async () => ({ ok: true, name: "Brian Taylor", tz: "America/Los_Angeles", shifts: [], forJob: null, scheduledJob: null, offThatDay: false })),
  putShiftOnJob: vi.fn(async () => ({ ok: true })),
  takeShiftOffJob: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../schedule/actions", () => ({ createJob: vi.fn(async () => ({ ok: true, id: "j-new" })) }));

import {
  AddTimeEntry,
  ClockOutClashDoor,
  COMPANY_TIME,
  NO_JOB,
  addedWords,
  dayWords,
  endsBeforeStart,
  hoursWords,
  nextDay,
  preselectFrom,
  resolveJobChoice,
  type AddJob,
} from "./add-time-entry";
import { LUNCH_LABEL } from "@/lib/lunch-rule";
import type { OverlapClash } from "@/lib/overlap-refusal";
import { todayStrInTz } from "@/lib/tz";
import type { JobCode } from "@/lib/types";

const TZ = "America/Los_Angeles";
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const members = [
  { id: "erik-1", full_name: "Erik Taylor" },
  { id: "brian-1", full_name: "Brian Taylor" },
];
const jobs: AddJob[] = [
  { id: "j28", job_number: "J-028", name: "41 Larkspur", address: "41 Larkspur Ave", status: "in_progress", customers: { name: "Nora Avocet" } },
  { id: "j11", job_number: "J-011", name: "13897 Honeysuckle", address: "13897 Honeysuckle Dr", status: "complete", customers: [{ name: "Andrew Crake" }] },
];
const codes = [
  { id: "c1", code: "ROUGH", description: "Rough-in", billable: true, active: true, created_at: "" },
  { id: "c2", code: "SHOP", description: "Shop time", billable: false, active: true, created_at: "" },
  { id: "c3", code: "OLD", description: "Retired", billable: true, active: false, created_at: "" },
] as JobCode[];

const form = (over: Partial<Parameters<typeof AddTimeEntry>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(AddTimeEntry, {
      isStaff: true,
      members,
      jobs,
      jobCodes: codes,
      jobCodesEnabled: false,
      tz: TZ,
      viewerId: "erik-1",
      companyTimeCode: "SHOP",
      initialOpen: true,
      ...over,
    }),
  );
/** The options of the select with this id, as [value, label] pairs, in order. */
const optionsOf = (html: string, id: string) => {
  const at = html.indexOf(`id="${id}"`);
  const body = html.slice(at, html.indexOf("</select>", at));
  return [...body.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
};

describe("six fields, top to bottom, and nothing the shift's editor already carries", () => {
  it("Who, Job, Day, Start, End and the lunch box; no end date, miles, rate or notes", () => {
    const html = form();
    const order = [">Who<", ">Job<", ">Day<", ">Start<", ">End<", LUNCH_LABEL].map((w) => html.indexOf(w));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const gone of ["Miles", "Rate", "Notes", "End date", "End Date", "bill rate", "Auto"]) expect(html).not.toContain(gone);
    expect(html).toContain("<h2 class=\"text-base font-semibold text-slate-900\">Add Time Entry</h2>");
    expect(html).toMatch(/<button[^>]*>Save Entry<\/button>/);
  });

  it("Job Code is a seventh field only while the Job Codes switch is on (a switch only hides a door)", () => {
    expect(form({ jobCodesEnabled: false })).not.toContain("Job Code");
    const on = form({ jobCodesEnabled: true });
    expect(on).toContain(">Job Code<");
    // Active codes only, after "No Code".
    expect(optionsOf(on, "ate-code")).toEqual([
      ["", "No Code"],
      ["ROUGH", "ROUGH — Rough-in"],
      ["SHOP", "SHOP — Shop time"],
    ]);
  });

  it("a tech gets nothing: techs clock live, only the office adds hours", () => {
    expect(form({ isStaff: false })).toBe("");
  });

  it("the button and every tap target in it are 44px", () => {
    const closed = form({ initialOpen: false });
    expect(closed).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*"[^>]*>(?:(?!<\/button>).)*Add Time Entry<\/button>/);
    const open = form({ jobCodesEnabled: true });
    for (const id of ["ate-who", "ate-job", "ate-day", "ate-start", "ate-end", "ate-code"]) {
      expect(open, id).toMatch(new RegExp(`<(select|input) class="[^"]*\\bh-11\\b[^"]*" id="${id}"`));
    }
    const s = src("./add-time-entry.tsx");
    expect(s).toContain('<NewJobInline onCreated={addNewJob} className="min-h-11" />');
    expect(s).toMatch(/<label htmlFor="ate-next-day" className="flex min-h-11/);
  });
});

describe("Who opens on the viewer by name", () => {
  it("no 'Me': the viewer is picked, by name, in the one list", () => {
    const html = form();
    expect(optionsOf(html, "ate-who")).toEqual([
      ["erik-1", "Erik Taylor"],
      ["brian-1", "Brian Taylor"],
    ]);
    expect(html).toMatch(/<option value="erik-1" selected="">Erik Taylor<\/option>/);
    expect(html).not.toMatch(/>Me</);
  });

  it("'Myself' only when the viewer has no member row", () => {
    const html = form({ viewerId: "office-9" });
    expect(optionsOf(html, "ate-who")[0]).toEqual(["", "Myself"]);
  });
});

describe("the Job on Timecards: always somebody's choice", () => {
  it("starts on Pick The Job, lists the open jobs by name (codes on) and ends on Company Time", () => {
    expect(optionsOf(form({ jobCodesEnabled: true }), "ate-job")).toEqual([
      ["", "Pick The Job"],
      ["j28", "41 Larkspur"],
      ["j11", "13897 Honeysuckle"],
      [COMPANY_TIME, "Company Time (Not Billed)"],
    ]);
  });

  it("codes off: the customer and the street lead, the number never does", () => {
    const opts = optionsOf(form({ jobCodesEnabled: false }), "ate-job");
    expect(opts[1]).toEqual(["j28", "Nora Avocet · 41 Larkspur Ave"]);
    expect(opts[2]).toEqual(["j11", "Andrew Crake · 13897 Honeysuckle Dr"]);
    for (const [, label] of opts) expect(label).not.toMatch(/^J-\d/);
  });

  it("no not-billed code: the last choice is No Job, and picking it says where the hours wait", () => {
    const opts = optionsOf(form({ companyTimeCode: null }), "ate-job");
    expect(opts.at(-1)).toEqual([NO_JOB, "No Job"]);
    const s = src("./add-time-entry.tsx");
    expect(s).toMatch(/\{!companyTimeCode && jobValue === NO_JOB && \(\s*<p[^>]*>It waits under Hours On No Job until someone picks one\.<\/p>/);
  });

  it("says where older jobs went, and keeps + New Job under the list", () => {
    const html = form();
    expect(html).toContain("Older job? Add it from the job&#x27;s Time tab.");
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>).)*New Job<\/button>/);
  });

  it("Save refuses a Job nobody picked, in words that name the ways out", () => {
    const base = { fixedJob: null, jobCode: "", jobCodesEnabled: false, labelOf: (id: string) => (id === "j28" ? "41 Larkspur" : "That job") };
    expect(resolveJobChoice({ ...base, value: "", companyTimeCode: "SHOP" })).toEqual({ ok: false, error: "Pick the job, or Company Time." });
    expect(resolveJobChoice({ ...base, value: "", companyTimeCode: null })).toEqual({ ok: false, error: "Pick the job, or No Job." });
    // Company Time files the company's own code on no job; No Job is only a choice without one.
    expect(resolveJobChoice({ ...base, value: COMPANY_TIME, companyTimeCode: "SHOP" })).toEqual({ ok: true, job_id: null, job_code: "SHOP", where: "Company Time" });
    expect(resolveJobChoice({ ...base, value: NO_JOB, companyTimeCode: null })).toEqual({ ok: true, job_id: null, job_code: null, where: "No Job" });
    expect(resolveJobChoice({ ...base, value: NO_JOB, companyTimeCode: "SHOP" }).ok).toBe(false);
    expect(resolveJobChoice({ ...base, value: "j28", companyTimeCode: "SHOP" })).toEqual({ ok: true, job_id: "j28", job_code: null, where: "41 Larkspur" });
    // The Job Code rides only while the switch is on.
    expect(resolveJobChoice({ ...base, value: "j28", companyTimeCode: "SHOP", jobCode: "ROUGH", jobCodesEnabled: true })).toMatchObject({ job_code: "ROUGH" });
    expect(resolveJobChoice({ ...base, value: "j28", companyTimeCode: "SHOP", jobCode: "ROUGH", jobCodesEnabled: false })).toMatchObject({ job_code: null });
  });
});

describe("the schedule starts the Job field, and never overrules a pick", () => {
  const answer = (over: Record<string, unknown> = {}) =>
    ({ ok: true, name: "Brian Taylor", tz: TZ, shifts: [], forJob: null, scheduledJob: { id: "j28", label: "41 Larkspur" }, offThatDay: false, ...over }) as any;

  it("untouched: the scheduled job; nothing scheduled, marked off, or unreadable: Pick The Job", () => {
    expect(preselectFrom(answer(), false)).toBe("j28");
    expect(preselectFrom(answer({ scheduledJob: null }), false)).toBe("");
    expect(preselectFrom(answer({ offThatDay: true, scheduledJob: null }), false)).toBe("");
    expect(preselectFrom({ ok: false, error: "Couldn't check this person's day just now." }, false)).toBe("");
    expect(preselectFrom(null, false)).toBe("");
  });

  it("touched: left alone, whatever the schedule says", () => {
    expect(preselectFrom(answer(), true)).toBeNull();
    expect(preselectFrom(answer({ offThatDay: true }), true)).toBeNull();
  });

  it("wired that way: every answer for the person and day on screen goes through it, a pick marks the field touched, and a new person or day re-asks", () => {
    const s = src("./add-time-entry.tsx");
    expect(s).toContain("const next = preselectFrom(answer, jobTouched.current);");
    expect(s).toMatch(/function pickJob\(v: string\) \{\s*jobTouched\.current = true;/);
    expect(s).toMatch(/function whoOrDayChanged\(\) \{\s*if \(fixedJob\) return;\s*setScheduled\(null\);\s*if \(!jobTouched\.current\) setJobValue\(""\);/);
    // The day's list sits between the Job and the Day, reading the person, the day and the picked job.
    expect(s).toMatch(/<SameDayShifts\s+profileId=\{who \|\| viewerId \|\| ""\}\s+date=\{day\}\s+jobId=\{fixedJob \? fixedJob\.id : jobIsReal \? jobValue : null\}/);
    expect(s.indexOf("<SameDayShifts")).toBeGreaterThan(s.indexOf('htmlFor="ate-job"'));
    expect(s.indexOf("<SameDayShifts")).toBeLessThan(s.indexOf('htmlFor="ate-day"'));
  });

  it("a new person or day takes the last answer's 'On The Schedule That Day' heading away at once, and a pick of that job keeps its name", () => {
    const s = src("./add-time-entry.tsx");
    // Both the Who and the Day go through whoOrDayChanged, which clears the heading before the re-ask.
    expect((s.match(/whoOrDayChanged\(\);/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const body = s.slice(s.indexOf("function whoOrDayChanged()"), s.indexOf("function addNewJob"));
    expect(body).toContain("setScheduled(null);");
    expect(body).not.toMatch(/jobTouched\.current[^\n]*setScheduled/);
    // setScheduled is only ever handed a fresh answer or null.
    expect((s.match(/setScheduled\(/g) ?? []).length).toBe(2);
    expect(s).toContain("if (sched) scheduledLabels.current.set(sched.id, sched.label);");
    expect(s).toContain('return scheduledLabels.current.get(id) ?? "That job";');
  });

  it("the scheduled job leads the list under its own heading", () => {
    const s = src("./add-time-entry.tsx");
    expect(s).toContain('<optgroup label="On The Schedule That Day">');
  });
});

describe("the job's own page: the job is said, not picked", () => {
  it("Job · <the job>, no job list, no older-job line", () => {
    const html = form({ fixedJob: { id: "j28", label: "41 Larkspur" }, jobs: [] });
    expect(html).toContain("Job · 41 Larkspur");
    expect(html).not.toContain('id="ate-job"');
    expect(html).not.toContain("Older job?");
    expect(html).not.toContain("Pick The Job");
  });

  it("Save names the job it was on", () => {
    expect(
      resolveJobChoice({ value: "", fixedJob: { id: "j28", label: "41 Larkspur" }, companyTimeCode: null, jobCode: "", jobCodesEnabled: false, labelOf: () => "x" }),
    ).toEqual({ ok: true, job_id: "j28", job_code: null, where: "41 Larkspur" });
  });
});

describe("Day, Start, End", () => {
  it("the Day starts on the COMPANY's today on both pages, not the browser's; 8 to 4 by default", () => {
    for (const html of [form(), form({ fixedJob: { id: "j28", label: "41 Larkspur" } })]) {
      expect(html).toMatch(new RegExp(`id="ate-day" type="date" value="${todayStrInTz(TZ)}"`));
      expect(html).toMatch(/id="ate-start" type="time" value="08:00"/);
      expect(html).toMatch(/id="ate-end" type="time" value="16:00"/);
    }
  });

  it("Ends The Next Day is asked only when End is at or before Start", () => {
    expect(endsBeforeStart("08:00", "16:00")).toBe(false);
    expect(endsBeforeStart("22:00", "06:00")).toBe(true);
    expect(endsBeforeStart("08:00", "08:00")).toBe(true);
    expect(form()).not.toContain("Ends The Next Day");
    const s = src("./add-time-entry.tsx");
    expect(s).toMatch(/\{crossing && \(\s*<div className="space-y-1">\s*<p className="text-xs text-slate-600">Ends before it starts\.<\/p>/);
    expect(s).toContain("<span>Ends The Next Day</span>");
    // Ticked, the end is the next day; unticked, the end date IS the Day, so a flipped time is refused.
    expect(s).toContain("const span = buildShiftSpan(day, startT, endT, endsNextDay ? nextDay(day) : day);");
    expect(s).toContain('if (clockOut <= clockIn) return setError("End must be after start.");');
    expect(nextDay("2026-09-30")).toBe("2026-10-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("after Save, nothing silent", () => {
  it("the toast names the hours, the person, the day and where they went", () => {
    expect(addedWords({ hours: 7.5, who: "Brian", day: "2026-09-23", where: "41 Larkspur" })).toBe("Added 7.5 h for Brian · Wed, Sep 23 · 41 Larkspur");
    expect(addedWords({ hours: 8, who: "Brian", day: "2026-09-22", where: "Company Time" })).toBe("Added 8 h for Brian · Tue, Sep 22 · Company Time");
    expect(hoursWords(8.333333)).toBe("8.33 h");
    expect(dayWords("2026-09-23")).toBe("Wed, Sep 23");
  });

  it("and carries Open That Shift to the new shift, the door to its miles, rate and notes", () => {
    const s = src("./add-time-entry.tsx");
    expect(s).toContain('id ? { label: "Open That Shift", onClick: () => router.push(`/timecards?entry=${id}`) } : undefined');
    // A dropped connection is a sentence (the 60mph law).
    expect(s).toMatch(/\} catch \{\s*\/\/ THE 60MPH LAW[^\n]*\n\s*setError\("No connection/);
  });
});

describe("a refusal over a RUNNING punch hands back the clock-out door (Erik, 2026-09-29, Brian on 700 North Juniper Boulevard)", () => {
  const running: OverlapClash = {
    id: "punch-1",
    clockIn: "2026-09-29T16:10:00Z",
    clockOut: null,
    jobId: "j11",
    jobCode: null,
    jobLabel: "13897 Honeysuckle",
    noJob: false,
    exact: false,
    lunchMinutes: 30,
    notes: "panel swap",
  };
  const door = (clash: OverlapClash | null, over: Partial<Parameters<typeof ClockOutClashDoor>[0]> = {}) =>
    renderToStaticMarkup(createElement(ClockOutClashDoor, { clash, name: "Brian Taylor", onTap: () => undefined, ...over }));

  it("an open clash renders Clock Out Brian, a 44px outline button; a closed clash renders nothing", () => {
    const html = door(running);
    expect(html).toMatch(/<button[^>]*class="[^"]*border-slate-300[^"]*min-h-11[^"]*"[^>]*>Clock Out Brian<\/button>/);
    expect(door({ ...running, clockOut: "2026-09-29T20:00:00Z" })).toBe("");
    expect(door(null)).toBe("");
    // The viewer's own running clock reads "Clock Out", never his own name.
    expect(door(running, { self: true })).toMatch(/>Clock Out<\/button>/);
    // No name on file: still a door, never a blank label.
    expect(door(running, { name: null })).toMatch(/>Clock Them Out<\/button>/);
  });

  it("wired: the door sits under the red refusal, and it mounts the clock-out sheet in place, seeded with the punch's own lunch and notes", () => {
    const s = src("./add-time-entry.tsx");
    expect(s).toMatch(/\{error && \(\s*<div className="space-y-2">\s*<div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">\{error\}<\/div>[\s\S]*?<ClockOutClashDoor clash=\{clash\}/);
    expect(s).toContain("setClash(res.clash ?? null)");
    expect(s).toMatch(/<StopClockSheet\s+entry=\{\{\s*id: clash\.id,/);
    expect(s).toContain("lunch_minutes: clash.lunchMinutes,");
    expect(s).toContain("notes: clash.notes,");
    expect(s).toContain("onStopped={stoppedAt}");
    // No Delete on this door: it is here to clock somebody out.
    const sheet = s.slice(s.indexOf("<StopClockSheet"), s.indexOf("onStopped={stoppedAt}"));
    expect(sheet).not.toContain("onDelete");
    // Closing the sheet re-reads the day; a stop drops the refusal and starts these hours where those stopped.
    expect(s).toMatch(/onClose=\{\(\) => \{\s*setClockingOut\(false\);\s*setDayKey\(\(k\) => k \+ 1\);\s*\}\}/);
    expect(s).toMatch(/function stoppedAt\(clockOutIso: string\) \{\s*setClash\(null\);\s*setError\(null\);[\s\S]*?setStartT\(hm\);/);
    expect(s).toContain("Start set to ${clockWords(clockOutIso, tz)}, when ${whoWords} clocked out.");
    // The sheet's Delete is optional now, and it says the stop time before it closes.
    const stop = src("./stop-clock-sheet.tsx");
    expect(stop).toContain("onDelete?: () => void;");
    expect(stop).toMatch(/onStopped\?\.\(stopIso\);\s*onClose\(\);/);
    expect(stop).toMatch(/\{onDelete && \(\s*<Button variant="ghost" onClick=\{onDelete\}/);
  });

  it("Cancel on the sheet keeps the refusal and Clock Out Brian (nothing changed; the punch is still running); only a stop clears them", () => {
    const s = src("./add-time-entry.tsx");
    const mount = s.slice(s.indexOf("<StopClockSheet"), s.indexOf("onStopped={stoppedAt}"));
    const close = mount.slice(mount.indexOf("onClose="), mount.indexOf("}}", mount.indexOf("onClose=")));
    expect(close).toContain("setClockingOut(false)");
    expect(close).not.toContain("setClash(null)");
    expect(close).not.toContain("setError(null)");
    // The sheet routes Cancel, the backdrop and Save Without Stopping through that same onClose; the stop
    // path calls onStopped first, and THAT is where the refusal goes.
    const stop = src("./stop-clock-sheet.tsx");
    expect(stop).toMatch(/onClick=\{onClose\}[^>]*>\s*Cancel/);
    const stopped = s.slice(s.indexOf("function stoppedAt("), s.indexOf("setStartT(hm)"));
    expect(stopped).toContain("setClash(null)");
    expect(stopped).toContain("setError(null)");
  });

  it("the in-place sheet offers End Of Work Day on a forgotten punch, the same as Timecards: the work day's end reaches it", () => {
    const s = src("./add-time-entry.tsx");
    expect(s).toContain("workDayEnd?: string;");
    const mount = s.slice(s.indexOf("<StopClockSheet"), s.indexOf("onStopped={stoppedAt}"));
    expect(mount).toContain("workDayEnd={workDayEnd}");
    // The chip is gated on that prop in the sheet; without it only Now is offered.
    const stop = src("./stop-clock-sheet.tsx");
    expect(stop).toContain("const workEndIso = workDayEnd ? tzDateTimeUtc(clockInDay, workDayEnd, tz) : null;");
    // Timecards hands it the company's day end (the job page's mount is Lane 3's; the prop is optional there).
    const page = src("./page.tsx");
    const add = page.slice(page.indexOf("<AddTimeEntry"), page.indexOf("/>", page.indexOf("<AddTimeEntry")));
    expect(add).toContain("workDayEnd={workWin.end}");
  });
});
