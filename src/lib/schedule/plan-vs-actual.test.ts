import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tzDateTimeUtc } from "@/lib/tz";
import { pillColorForPerson } from "@/lib/employee-color";
import {
  ACTUALS_LIMIT,
  ACTUALS_PAGES,
  CREW_ROW_PAGES,
  actualsFrom,
  actualSpans,
  blockSentence,
  clockShort,
  durShort,
  ghostsFor,
  mergePeople,
  packActuals,
  peopleWords,
  planVsActual,
  readPagesCapped,
  rangeWords,
  SENTENCE_MAX,
  unpackActuals,
  type ActualEntry,
  type PlanBlock,
} from "./plan-vs-actual";
import { bookedKeys } from "./booked-days";

/**
 * WHAT HAPPENED, INSIDE THE BLOCK (Wave 2, SV-actual). The shapes are the real ET weeks that made the
 * case (as fixtures with made-up ids, never data): J-046's week (Monday no time on the job; Tuesday Erik 10 to
 * 6 and Jimmy noon to 6; Thursday 11 to 9 = 4h over), J-011 9/22 (an all-day block, two people), J-055
 * (an 8-to-5 block started at noon), J-011 9/25 (worked, nothing booked), an overnight 10 PM to 6:30 AM,
 * a duplicate pair that counts once, a day only a return visit booked, and a spring-forward day.
 */
const LA = "America/Los_Angeles";
const TODAY = "2026-09-28";
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA) as string;
const ERIK = { profileId: "p-erik", name: "Erik Taylor" };
const JIMMY = { profileId: "p-jimmy", name: "Jimmy Ruiz" };
const BRIAN = { profileId: "p-brian", name: "Brian Cole" };
const entry = (who: { profileId: string; name: string }, jobId: string | null, day: string, from: string, to: string | null, toDay = day): ActualEntry => ({
  ...who,
  jobId,
  clockIn: at(day, from),
  clockOut: to ? at(toDay, to) : null,
});
const block = (key: string, jobId: string | null, dayStr: string, startMin: number, endMin: number, kind: "job" | "visit" = "job"): PlanBlock => ({
  key,
  jobId,
  dayStr,
  startMin,
  endMin,
  kind,
});
const run = (blocks: PlanBlock[], entries: ActualEntry[]) => planVsActual({ blocks, spans: actualSpans(entries, LA, TODAY), todayStr: TODAY });

describe("the entries, as past-day spans on the company's clock", () => {
  it("an entry lands on its Pacific day and minutes; no job, today and later are dropped", () => {
    const spans = actualSpans(
      [
        entry(ERIK, "j46", "2026-09-22", "10:00", "18:00"),
        entry(ERIK, null, "2026-09-22", "07:00", "08:00"),
        entry(ERIK, "j46", TODAY, "08:00", "09:00"),
        // 8:30 PM Pacific on the 22nd is the 23rd in UTC: it lands on the Pacific day.
        entry(JIMMY, "j46", "2026-09-22", "20:30", "21:30"),
      ],
      LA,
      TODAY,
    );
    expect(spans.map((s) => [s.profileId, s.dayStr, s.startMin, s.endMin])).toEqual([
      ["p-erik", "2026-09-22", 600, 1080],
      ["p-jimmy", "2026-09-22", 1230, 1290],
    ]);
  });

  it("an overnight 10 PM to 6:30 AM splits at midnight: its tail is drawn on the next day from 0", () => {
    const spans = actualSpans([entry(ERIK, "j9", "2026-09-20", "22:00", "06:30", "2026-09-21")], LA, TODAY);
    expect(spans.map((s) => [s.dayStr, s.startMin, s.endMin])).toEqual([
      ["2026-09-20", 1320, 1440],
      ["2026-09-21", 0, 390],
    ]);
  });

  it("a runaway later closed covers its days, at most a week; a tail that reaches today is not drawn", () => {
    const spans = actualSpans([entry(ERIK, "j9", "2026-09-25", "08:00", "10:00", TODAY)], LA, TODAY);
    expect(spans.map((s) => [s.dayStr, s.startMin, s.endMin])).toEqual([
      ["2026-09-25", 480, 1440],
      ["2026-09-26", 0, 1440],
      ["2026-09-27", 0, 1440],
    ]);
  });

  it("a spring-forward day reads the wall clock: 1:30 AM to 4:00 AM is drawn 1:30 to 4", () => {
    // 2027-03-14: the clocks jump from 2:00 to 3:00 AM. 1:30 PST to 4:00 PDT is 90 minutes elapsed.
    const spans = actualSpans(
      [{ ...ERIK, jobId: "j9", clockIn: "2027-03-14T09:30:00.000Z", clockOut: "2027-03-14T11:00:00.000Z" }],
      LA,
      "2027-03-20",
    );
    expect(spans.map((s) => [s.dayStr, s.startMin, s.endMin])).toEqual([["2027-03-14", 90, 240]]);
  });

  it("packs compact for the page (each person and job once) and unpacks the same spans", () => {
    const spans = actualSpans(
      [entry(ERIK, "j46", "2026-09-22", "10:00", "18:00"), entry(JIMMY, "j46", "2026-09-22", "12:00", "18:00"), entry(ERIK, "j11", "2026-09-23", "09:00", null)],
      LA,
      TODAY,
    );
    const packed = packActuals(spans, new Map([["j46", { name: "12 Elm St", job_number: "J-046", customer: "Rita Moss" }]]));
    expect(packed.people).toHaveLength(2);
    expect(packed.jobs).toEqual([
      { id: "j46", name: "12 Elm St", job_number: "J-046", customer: "Rita Moss" },
      { id: "j11", name: "A Job", job_number: null, customer: null },
    ]);
    expect(packed.spans[2]).toEqual([1, 0, "2026-09-23", 540, null]);
    expect(unpackActuals(packed)).toEqual(spans);
    expect(unpackActuals(null)).toEqual([]);
    // Nothing about pay rides along: no rate, no amount, no pay column.
    expect(JSON.stringify(packed)).not.toMatch(/rate|amount|paid|miles/);
  });
});

describe("the read, as the calendar gets it", () => {
  const row = (who: { profileId: string; name: string }, jobId: string | null, day: string, from: string, to: string | null) => ({
    profile_id: who.profileId,
    job_id: jobId,
    clock_in: at(day, from),
    clock_out: to ? at(day, to) : null,
    profiles: { full_name: who.name },
    job: jobId ? { id: jobId, job_number: "J-046", name: "12 Elm St", customers: { name: "Rita Moss" } } : null,
  });

  it("a failed read is null (no bars, and the calendar says so), never an empty week", () => {
    expect(actualsFrom(null, LA, TODAY)).toEqual({ actuals: null, actualsCappedBefore: null });
  });

  it("names people from the entry's own person (a person who left still has one) and jobs from its job", () => {
    const { actuals, actualsCappedBefore } = actualsFrom([row(ERIK, "j46", "2026-09-22", "10:00", "18:00")], LA, TODAY);
    expect(actualsCappedBefore).toBeNull();
    expect(actuals!.people).toEqual([{ id: "p-erik", name: "Erik Taylor" }]);
    expect(actuals!.jobs).toEqual([{ id: "j46", name: "12 Elm St", job_number: "J-046", customer: "Rita Moss" }]);
  });

  it("a read that stopped at its page bound loads back to the day AFTER its oldest clock-in (that day may be partial)", () => {
    const rows = [row(ERIK, "j46", "2026-09-22", "10:00", "18:00"), row(ERIK, "j46", "2026-09-10", "09:00", "17:00")];
    expect(actualsFrom(rows, LA, TODAY, true).actualsCappedBefore).toBe("2026-09-11");
    expect(actualsFrom(rows, LA, TODAY, false).actualsCappedBefore).toBeNull();
    // Said by the PAGED read, never counted off a .limit(): PostgREST's own ceiling sits below it.
    expect(actualsFrom(rows, LA, TODAY).actualsCappedBefore).toBeNull();
    expect([ACTUALS_PAGES, ACTUALS_LIMIT, CREW_ROW_PAGES]).toEqual([4, 4000, 2]);
  });

  it("the oldest row read is found in the rows, whatever order they came back in", () => {
    const rows = [row(ERIK, "j46", "2026-09-10", "09:00", "17:00"), row(ERIK, "j46", "2026-09-22", "10:00", "18:00")];
    expect(actualsFrom(rows, LA, TODAY, true).actualsCappedBefore).toBe("2026-09-11");
  });
});

/** A CEILING CANNOT SEE A CUT BELOW IT: the paging the clocked-time read and the crew rows both use. */
describe("readPagesCapped", () => {
  const pages = (sizes: number[]) => {
    const seen: [number, number][] = [];
    let i = 0;
    return {
      seen,
      page: async (from: number, to: number) => {
        seen.push([from, to]);
        const n = sizes[i++] ?? 0;
        return { data: Array.from({ length: n }, (_, k) => ({ id: `${from + k}` })), error: null };
      },
    };
  };

  it("advances by the rows ACTUALLY returned and ends on an EMPTY page, not a short one", async () => {
    // 600 back from a 1000-row ask is this project's ceiling, not the end of the list.
    const p = pages([600, 600, 0]);
    const res = await readPagesCapped(p.page, 4);
    expect(res.rows.length).toBe(1200);
    expect(res.capped).toBe(false);
    expect(p.seen).toEqual([[0, 999], [600, 1599], [1200, 2199]]);
  });

  it("more rows than the bound holds is CAPPED, with the rows it read — never an error and never nothing", async () => {
    const res = await readPagesCapped(pages([1000, 1000]).page, 2);
    expect(res.rows.length).toBe(2000);
    expect(res.capped).toBe(true);
    expect(res.error).toBeNull();
  });

  it("an error, or a read that isn't a list, is a failure: no rows, and never 'capped'", async () => {
    const bad = await readPagesCapped(async () => ({ data: null, error: { message: "x" } }), 3);
    expect([bad.rows.length, bad.capped, !!bad.error]).toEqual([0, false, true]);
    const notList = await readPagesCapped(async () => ({ data: null, error: null }), 3);
    expect([notList.rows.length, notList.capped, !!notList.error]).toEqual([0, false, true]);
  });
});

describe("the calendar reads it and draws it (source)", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

  it("one past-only read of entries on a job, newest first, PAGED to a bound, and NO pay column", () => {
    const panel = read("src/app/(app)/schedule/calendar-panel.tsx");
    expect(panel).toContain(
      '"id, profile_id, job_id, clock_in, clock_out, source, profiles:profile_id(full_name), job:job_id(id, job_number, name, customers(name))"',
    );
    const q = panel.slice(panel.indexOf('.from("time_entries")'), panel.indexOf("}, ACTUALS_PAGES)"));
    expect(q).toContain('.not("job_id", "is", null)');
    // The WHOLE oldest day (the window's own first company day, a day earlier for an overnight tail),
    // never the instant `jobFrom`, which begins mid-afternoon on it.
    expect(q).toContain('.gte("clock_in", actualsFromIso)');
    expect(panel).toContain("const actualsFromIso = tzDayStartUtc(");
    expect(q).not.toContain('.gte("clock_in", jobFrom)');
    expect(q).toContain('.lt("clock_in", tzDayStartUtc(todayStr, tz).toISOString())');
    expect(q).toContain('.order("clock_in", { ascending: false })');
    // Paged, with a unique tiebreak, because a .limit() above PostgREST's ceiling can't see the cut.
    expect(q).toContain('.order("id", { ascending: false })');
    expect(q).toContain(".range(from, to)");
    expect(panel).toContain("readPagesCapped<ActualEntryRow>(");
    expect(panel).not.toContain(".limit(ACTUALS_LIMIT)");
    // Everyone's Day's rows are paged the same way, and never cut at 1000 in silence.
    expect(panel).toContain("readPagesCapped<CrewDayRow>(");
    const crew = panel.slice(panel.indexOf('.from("crew_day_assignments")'), panel.indexOf("CREW_ROW_PAGES,\n"));
    expect(crew).toContain(".range(from, to)");
    expect(crew).toContain('.order("profile_id")');
    expect(crew).not.toContain(".limit(");
    expect(panel).toContain("actuals, actualsCappedBefore } = actualsFrom(entriesRead.error ? null : entriesRead.rows, tz, todayStr, entriesRead.capped)");
    const cols = panel.slice(panel.indexOf("const ENTRY_COLS"), panel.indexOf("const [historyReads"));
    expect(cols).not.toMatch(/rate_override|paid_at|miles|notes|lunch|pay/);
    // Jobs with in-window days but no listed day are read by id, 200 at a time, in the same round.
    expect(panel).toContain("for (let i = 0; i < missing.length; i += 200) missingChunks.push(missing.slice(i, i + 200));");
  });

  it("the July rule is retired in words, in the panel and the view", () => {
    expect(read("src/app/(app)/schedule/calendar-panel.tsx")).toContain('the July rule "the calendar never shows clocked time" was retired');
    const view = read("src/app/(app)/calendar/calendar-view.tsx");
    expect(view).toContain('the July rule "the calendar never shows clocked time" is retired');
    expect(view).not.toContain("WHEN-DID (clocked hours) lives on");
  });

  it("hollow is decided before the person filter; only days loaded whole are judged; blank is not zero", () => {
    const view = read("src/app/(app)/calendar/calendar-view.tsx");
    expect(view).toContain('return { people, hollow: a.state === "hollow", sentence: a.sentence };');
    expect(view).toContain("(k: string) => clockInUse && k < todayK && (!actualsCappedBefore || k >= actualsCappedBefore)");
    expect(view).toContain("Clocked time loads back to {dayWords(actualsCappedBefore)}.");
    expect(view).toContain("Clocked time didn&apos;t load, so past days show only what was booked.");
    // A visit on a job draws the time it took, but is never drawn hollow (a city inspection or a
    // meeting is booked time nobody clocks); only a job's day is.
    expect(view).toContain('const actual = visitActual?.state === "worked" ? gridActualOf(visitActual, personFilter) : undefined;');
    expect(view).toContain('if (a.state === "hollow" && key.startsWith("j-")) out.add(key);');
  });

  it("ghosts: booked from the raw rows, following the person filter, dashed on the grid and the month, a row in the day drill", () => {
    const view = read("src/app/(app)/calendar/calendar-view.tsx");
    expect(view).toContain("for (const g of ghostsFor(spans, booked, todayK)) {");
    expect(view).toContain("if (!actualsWhole(g.dayStr) || g.dayStr < winFrom) continue;");
    expect(view).toContain("const mine = g.people.filter((p) => p.profileId === personFilter);");
    expect(view).toContain('const GHOST_GRID_TONE = "border-2 border-dashed border-slate-400 bg-white/60 text-slate-700";');
    expect(view).toContain('ghost: "border border-dashed border-slate-400 bg-white/60 text-slate-700"');
    expect(view).toContain("<GhostRow key={`ghost-${g.jobId}`} day={dayK} ghost={g} canEdit={canEdit} />");
    // A proposed visit keeps its type's tone with a thin dashed border, faded: never a ghost's look.
    expect(view).toContain('${a.status === "proposed" ? " border-dashed opacity-75" : ""}');
  });

  it("no money anywhere near it: no price, amount, total, cost, rate or pay column in what draws or books worked time", () => {
    const code = (f: string) =>
      read(f)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    for (const f of [
      "src/lib/schedule/plan-vs-actual.ts",
      "src/lib/schedule/booked-days.ts",
      "src/components/worked-track.tsx",
      "src/app/(app)/schedule/ghost-sheet.tsx",
    ]) {
      expect(code(f), f).not.toMatch(/\b(prices?|amounts?|totals?|costs?|rates?|rate_override|paid_at|bill_rate|pay_rate)\b|formatCurrency|\$\d/i);
    }
  });

  it("the stack builds each week's grid once per (week, data), with stable props, so mounted weeks skip", () => {
    const view = read("src/app/(app)/calendar/calendar-view.tsx");
    expect(view).toContain("const gridNow = useMemo(");
    expect(view).toMatch(/const key = \[\s*jobs, segments, appointments, tasks, external, actuals, actualsCappedBefore, dayRows, people, members, addableJobs,\s*personFilter, tz, todayK, canEdit, workDayStart, workDayEnd,\s*\];/);
    expect(view).toContain("onDayClick={drillInto}");
    expect(view).toContain("placement={armedProp}");
    expect(view).not.toContain("placement={target.prop}");
    expect(view).not.toMatch(/onDayClick=\{\(ds\) =>/);
  });
});

describe("J-046's week: booked 9 to 5", () => {
  const blocks = ["2026-09-21", "2026-09-22", "2026-09-24"].map((d) => block(`j-j46-${d}`, "j46", d, 540, 1020));
  const res = run(blocks, [
    entry(ERIK, "j46", "2026-09-22", "10:00", "18:00"),
    entry(JIMMY, "j46", "2026-09-22", "12:00", "18:00"),
    entry(ERIK, "j46", "2026-09-24", "11:00", "21:00"),
  ]);

  it("Monday: no time clocked to the job: hollow, and the sentence claims only that", () => {
    expect(res.byKey.get("j-j46-2026-09-21")).toMatchObject({ state: "hollow", people: [], lateMin: null, sentence: "Booked 9–5 · No time clocked to this job" });
  });

  it("someone who clocked in with NO job is not called absent: the hollow day never says nobody clocked in", () => {
    // The read keeps entries on a job, so a helper who skipped "Which Job Are You On?" is invisible to
    // the block — and /timecards shows their hours that same day. The block says what it can know.
    const withNoJobPunch = run(blocks, [entry(JIMMY, null, "2026-09-21", "09:00", "17:00")]);
    const mon = withNoJobPunch.byKey.get("j-j46-2026-09-21")!;
    expect(mon.state).toBe("hollow");
    expect(mon.sentence).toBe("Booked 9–5 · No time clocked to this job");
    expect(mon.sentence).not.toContain("Nobody clocked in");
    expect(mon.people).toEqual([]);
  });

  it("Tuesday: Erik 10 to 6 and Jimmy noon to 6: an hour late, an hour over, in their colors", () => {
    const tue = res.byKey.get("j-j46-2026-09-22")!;
    expect(tue.state).toBe("worked");
    expect(tue.people.map((p) => [p.first, p.initials, p.startMin, p.endMin, p.dot])).toEqual([
      ["Erik", "ET", 600, 1080, pillColorForPerson("p-erik").dot],
      ["Jimmy", "JR", 720, 1080, pillColorForPerson("p-jimmy").dot],
    ]);
    expect([tue.lateMin, tue.overMin, tue.shortMin]).toEqual([60, 60, -60]);
    expect(tue.sentence).toBe("Booked 9–5 · Erik 10–6 · Jimmy 12–6 · 1h late · 1h over");
    expect(tue.extent).toEqual({ lo: 540, hi: 1080 });
  });

  it("Thursday: 11 to 9 is 2h late and 4h over, and the extent reaches 9 PM (the grid stretches to it)", () => {
    const thu = res.byKey.get("j-j46-2026-09-24")!;
    expect(thu.sentence).toBe("Booked 9–5 · Erik 11–9 · 2h late · 4h over");
    expect(thu.overMin).toBe(240);
    expect(thu.extent.hi).toBe(21 * 60);
  });

  it("no hour total is ever printed (it can never disagree with /timecards)", () => {
    for (const a of res.byKey.values()) expect(a.sentence).not.toMatch(/\bhours?\b|\bhrs?\b|total/i);
  });
});

describe("the other real shapes", () => {
  it("J-011 9/22: an all-day block with two people", () => {
    const res = run([block("j-j11-0922", "j11", "2026-09-22", 540, 1020)], [
      entry(ERIK, "j11", "2026-09-22", "09:00", "17:00"),
      entry(BRIAN, "j11", "2026-09-22", "09:30", "15:00"),
    ]);
    const a = res.byKey.get("j-j11-0922")!;
    expect(a.people.map((p) => p.first)).toEqual(["Erik", "Brian"]);
    expect(a.sentence).toBe("Booked 9–5 · Erik 9–5 · Brian 9:30–3");
  });

  it("J-055: an 8-to-5 block started at noon is 4h late; an early finish is short", () => {
    const late = run([block("k", "j55", "2026-09-23", 480, 1020)], [entry(ERIK, "j55", "2026-09-23", "12:00", "17:00")]).byKey.get("k")!;
    expect(late.sentence).toBe("Booked 8–5 · Erik 12–5 · 4h late");
    const short = run([block("k", "j55", "2026-09-23", 480, 1020)], [entry(ERIK, "j55", "2026-09-23", "08:00", "15:30")]).byKey.get("k")!;
    expect(short.sentence).toBe("Booked 8–5 · Erik 8–3:30 · 1.5h short");
  });

  it("J-011 9/25: worked with no block that day is unplanned (part D draws it)", () => {
    const res = run([block("j-j11-0924", "j11", "2026-09-24", 540, 1020)], [entry(BRIAN, "j11", "2026-09-25", "11:04", "13:46")]);
    expect(res.unplanned).toHaveLength(1);
    expect(res.unplanned[0]).toMatchObject({ jobId: "j11", dayStr: "2026-09-25" });
    expect(res.unplanned[0].people[0]).toMatchObject({ first: "Brian", startMin: 664, endMin: 826 });
    expect(res.byKey.get("j-j11-0924")!.state).toBe("hollow");
  });

  it("a duplicate pair (and a switch-back) counts once: overlapping stretches union", () => {
    const res = run([block("k", "j9", "2026-09-23", 540, 1020)], [
      entry(ERIK, "j9", "2026-09-23", "09:00", "17:00"),
      entry(ERIK, "j9", "2026-09-23", "09:00", "17:00"),
      entry(JIMMY, "j9", "2026-09-23", "09:00", "12:00"),
      entry(JIMMY, "j9", "2026-09-23", "12:00", "17:00"),
    ]);
    const a = res.byKey.get("k")!;
    expect(a.people.map((p) => p.spans)).toEqual([
      [{ startMin: 540, endMin: 1020, open: false }],
      [{ startMin: 540, endMin: 1020, open: false }],
    ]);
    expect(a.sentence).toBe("Booked 9–5 · Erik 9–5 · Jimmy 9–5");
  });

  it("an appointment-only day: the return visit on the job takes the time; a job block that day would take it first", () => {
    const visitOnly = run([block("a-v1-0923", "j9", "2026-09-23", 600, 660, "visit")], [entry(ERIK, "j9", "2026-09-23", "10:05", "11:20")]);
    expect(visitOnly.byKey.get("a-v1-0923")!.sentence).toBe("Booked 10–11 · Erik 10:05–11:20 · 20m over");
    expect(visitOnly.unplanned).toEqual([]);
    const both = run(
      [block("a-v1-0923", "j9", "2026-09-23", 600, 660, "visit"), block("j-j9-0923", "j9", "2026-09-23", 540, 1020)],
      [entry(ERIK, "j9", "2026-09-23", "10:05", "11:20")],
    );
    expect(both.byKey.get("j-j9-0923")!.state).toBe("worked");
    expect(both.byKey.get("a-v1-0923")!.state).toBe("hollow");
  });

  it("a visit with no job (a walk-through before the sale) is never judged: time is clocked to jobs", () => {
    const res = run([block("a-walk", null, "2026-09-23", 600, 660, "visit")], []);
    expect(res.byKey.has("a-walk")).toBe(false);
  });

  it("never clocked out: the stretch runs to the block's end, open, and the sentence says so", () => {
    const res = run([block("k", "j9", "2026-09-23", 540, 1020)], [entry(ERIK, "j9", "2026-09-23", "10:00", null)]);
    const a = res.byKey.get("k")!;
    expect(a.people[0].spans).toEqual([{ startMin: 600, endMin: 1020, open: true }]);
    expect(a.people[0].endMin).toBeNull();
    expect([a.overMin, a.shortMin]).toEqual([null, null]);
    expect(a.sentence).toBe("Booked 9–5 · Erik in at 10, never clocked out · 1h late");
  });

  it("only days before today are judged", () => {
    const res = run([block("k", "j9", TODAY, 540, 1020)], []);
    expect(res.byKey.has("k")).toBe(false);
  });
});

describe("the words", () => {
  it("clocks, ranges and lengths in as few letters as they read", () => {
    expect([clockShort(540), clockShort(1170), clockShort(720), clockShort(0), clockShort(1440)]).toEqual(["9", "7:30", "12", "12", "12"]);
    expect(rangeWords(664, 826)).toBe("11:04 AM–1:46 PM");
    expect(rangeWords(750, 1050)).toBe("12:30–5:30 PM");
    expect([durShort(45), durShort(60), durShort(90), durShort(150), durShort(70)]).toEqual(["45m", "1h", "1.5h", "2.5h", "1h 10m"]);
  });

  it("a crowded day still fits in 140 characters, the rest counted", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ profileId: `p${i}`, name: `Person${i} Longname` }));
    const people = mergePeople(
      many.map((p, i) => ({ ...p, jobId: "j", dayStr: "2026-09-23", startMin: 480 + i, endMin: 1000 + i })),
      (s) => s + 60,
    );
    const s = blockSentence({ startMin: 480, endMin: 1020 }, { people, lateMin: 0, overMin: 0, shortMin: 0 });
    expect(s.length).toBeLessThanOrEqual(SENTENCE_MAX);
    expect(s).toMatch(/\+\d+ more$/);
  });

  it("who worked, for a ghost's sheet: the half said once when both ends share it", () => {
    const people = mergePeople(
      [
        { ...BRIAN, jobId: "j", dayStr: "d", startMin: 664, endMin: 826 },
        { ...ERIK, jobId: "j", dayStr: "d", startMin: 750, endMin: 1050 },
      ],
      (s) => s + 60,
    );
    expect(peopleWords(people)).toBe("Brian 11:04 AM–1:46 PM · Erik 12:30–5:30 PM");
  });
});

describe("ghosts: work nobody booked (SV-ghost)", () => {
  const booked = (p: Partial<Parameters<typeof bookedKeys>[0]>) => bookedKeys({ segments: [], jobs: [], appointments: [], tz: LA, ...p });
  const ghosts = (entries: ActualEntry[], b = booked({})) => ghostsFor(actualSpans(entries, LA, TODAY), b, TODAY);

  it("J-011 9/25: Brian 11:04 to 1:46 on a day nothing was booked is a ghost", () => {
    const g = ghosts([entry(BRIAN, "j11", "2026-09-25", "11:04", "13:46")], booked({ segments: [{ job_id: "j11", start_date: "2026-09-24", end_date: "2026-09-24" }] }));
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ jobId: "j11", dayStr: "2026-09-25", startMin: 664, endMin: 826 });
    expect(g[0].people.map((p) => [p.first, p.startMin, p.endMin])).toEqual([["Brian", 664, 826]]);
  });

  it("J-011 9/24 (a timed segment) and J-052 9/23 (the scheduled_start mirror) are booked: no ghost", () => {
    expect(ghosts([entry(ERIK, "j11", "2026-09-24", "09:00", "17:00")], booked({ segments: [{ job_id: "j11", start_date: "2026-09-24", end_date: "2026-09-24" }] }))).toEqual([]);
    expect(
      ghosts([entry(ERIK, "j52", "2026-09-23", "09:00", "17:00")], booked({ jobs: [{ id: "j52", scheduled_start: at("2026-09-23", "10:00"), scheduled_end: at("2026-09-23", "12:00") }] })),
    ).toEqual([]);
  });

  it("a visit on the job that day is a booking: no ghost", () => {
    expect(
      ghosts(
        [entry(ERIK, "j9", "2026-09-23", "10:00", "12:00")],
        booked({ appointments: [{ job_id: "j9", starts_at: at("2026-09-23", "10:00"), ends_at: at("2026-09-23", "11:00"), status: "completed", type: "service_call" }] }),
      ),
    ).toEqual([]);
  });

  it("a job whose segments are kept worked days with no listed day is booked on those days", () => {
    expect(
      ghosts([entry(ERIK, "cleared", "2026-09-22", "09:00", "15:00")], booked({ segments: [{ job_id: "cleared", start_date: "2026-09-22", end_date: "2026-09-22" }] })),
    ).toEqual([]);
  });

  it("an evening Pacific entry lands on the Pacific day (the UTC next day is not the day it was worked)", () => {
    const g = ghosts([entry(JIMMY, "j9", "2026-09-22", "19:30", "21:00")]);
    expect(g.map((x) => x.dayStr)).toEqual(["2026-09-22"]);
  });

  it("two people on one job-day make one ghost with two people; someone never clocked out leaves its end open", () => {
    const g = ghosts([entry(BRIAN, "j11", "2026-09-25", "11:04", "13:46"), entry(ERIK, "j11", "2026-09-25", "12:30", null)]);
    expect(g).toHaveLength(1);
    expect(g[0].people.map((p) => p.first)).toEqual(["Brian", "Erik"]);
    expect(g[0].endMin).toBeNull();
    expect(g[0].people[1].spans).toEqual([{ startMin: 750, endMin: 810, open: true }]);
  });

  it("today and later never get a ghost; a punch on no job is never one", () => {
    expect(ghosts([entry(ERIK, "j9", TODAY, "08:00", "09:00"), entry(ERIK, null, "2026-09-22", "08:00", "09:00")])).toEqual([]);
  });
});
