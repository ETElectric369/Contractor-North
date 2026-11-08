import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { translator } from "@/lib/i18n";
import { titleCaseIn } from "../../../tests/title-case-words";
import {
  billState,
  dayClocked,
  foldHoursByJob,
  holdReason,
  hoursLine,
  hoursShort,
  jobBlockExtras,
  jobNote,
  jobState,
  noteOf,
  visitBlockExtras,
  visitState,
  JOB_HOURS_PAGES,
  type WorkedSpans,
} from "./block-extras";

/**
 * WHAT ELSE THE BOX SAYS (cn-v1151): the hours, the state and the note of a schedule block, one pure rule
 * per kind, every branch in a table. English by default; Spanish through the caller's translator (the ag_
 * catalog); no catalog imported by the library itself.
 */
const es = translator("es");
const TODAY = "2026-11-05";

/** Spans as the grid holds them: [start, end, open?, running?] in minutes. */
const spans = (...people: [number, number, boolean?, boolean?][][]): WorkedSpans => ({
  people: people.map((p) => ({
    spans: p.map(([startMin, endMin, open = false, running = false]) => (running ? { startMin, endMin, open, running: true as const } : { startMin, endMin, open })),
  })),
});

describe("hoursShort", () => {
  it.each([
    [7.5, "7.5"],
    [8, "8"],
    [0.25, "0.25"],
    [7.333, "7.33"],
    [22, "22"],
    [0, "0"],
    [-1, "0"],
    [Number.NaN, "0"],
  ])("%s → %s", (h, s) => {
    expect(hoursShort(h)).toBe(s);
  });
});

describe("dayClocked — the day's time from the block's own spans", () => {
  it("sums the stretches with an end, counts them, and leaves an open one out", () => {
    // Sam 9–12 and 1–5 (7 h); Dana 10 to an open end drawn to 5 (adds nothing).
    const d = dayClocked(spans([[540, 720], [780, 1020]], [[600, 1020, true]]));
    expect(d).toEqual({ hours: 7, closed: 2, running: false });
  });
  it("a punch still running is flagged and adds nothing; a quarter hour reads 0.25", () => {
    expect(dayClocked(spans([[540, 555], [600, 700, true, true]]))).toEqual({ hours: 0.25, closed: 1, running: true });
  });
  it("nothing in: nothing out", () => {
    expect(dayClocked(null)).toEqual({ hours: 0, closed: 0, running: false });
    expect(dayClocked({ people: [] })).toEqual({ hours: 0, closed: 0, running: false });
    expect(dayClocked(spans([[600, 600]]))).toEqual({ hours: 0, closed: 0, running: false });
  });

  /* THE ONE HOURS RULE (skeptic #55, cn-v1151): a person's `workedMin` — clock time less lunch, from
     plan-vs-actual mergePeople — is the figure when it is there; the bars' own length only stands in when a
     caller hands spans alone. The bars are where the person was; the number is what /timecards pays. */
  it("prefers the person's workedMin (clock time less lunch) when it is a number; the stretches' length is the fallback", () => {
    // 8–4:30 with a 30 min lunch: the bar is 510 min long, the figure 480 — 8 h, as /timecards says.
    const withLunch: WorkedSpans = { people: [{ spans: [{ startMin: 480, endMin: 990, open: false }], workedMin: 480 }] };
    expect(dayClocked(withLunch)).toEqual({ hours: 8, closed: 1, running: false });
    expect(dayClocked(spans([[480, 990]]))).toEqual({ hours: 8.5, closed: 1, running: false });
    // Two people, one with the figure and one without: each by what it has.
    expect(
      dayClocked({
        people: [{ spans: [{ startMin: 480, endMin: 990, open: false }], workedMin: 480 }, { spans: [{ startMin: 540, endMin: 600, open: false }] }],
      }),
    ).toEqual({ hours: 9, closed: 2, running: false });
    // A running punch beside a closed stretch: flagged, adds nothing, the figure stands.
    expect(
      dayClocked({ people: [{ spans: [{ startMin: 480, endMin: 540, open: false }, { startMin: 600, endMin: 700, open: true, running: true }], workedMin: 45 }] }),
    ).toEqual({ hours: 0.75, closed: 1, running: true });
    // A figure of zero on closed stretches still counts them (the line reads "0 h worked", never a silent blank).
    expect(dayClocked({ people: [{ spans: [{ startMin: 540, endMin: 550, open: false }], workedMin: 0 }] })).toEqual({ hours: 0, closed: 1, running: false });
  });
});

describe("hoursLine — the day first, the job last, dots between", () => {
  const day = (hours: number, closed = 1, running = false) => ({ hours, closed, running });
  it.each([
    ["the day alone", { day: day(7.5) }, "7.5 h worked"],
    ["the day and the job", { day: day(7.5), jobHours: 22 }, "7.5 h worked · 22 h on the job"],
    ["a punch still running", { day: day(2, 1, true), jobHours: 22 }, "2 h worked · on the clock · 22 h on the job"],
    ["running with nothing closed yet: no day figure", { day: day(0, 0, true) }, "on the clock"],
    ["a hollow block (no closed stretch), the job known", { day: day(0, 0), jobHours: 22.5 }, "22.5 h on the job"],
    ["an upcoming day, the job known", { day: null, jobHours: 0.25 }, "0.25 h on the job"],
    ["a job's figure of zero still reads", { day: null, jobHours: 0 }, "0 h on the job"],
  ])("%s", (_name, p, line) => {
    expect(hoursLine(p)).toBe(line);
  });
  it("nothing to say is null, not an empty line", () => {
    expect(hoursLine({})).toBeNull();
    expect(hoursLine({ day: null, jobHours: null })).toBeNull();
    expect(hoursLine({ day: day(0, 0) })).toBeNull();
    expect(hoursLine({ day: null, jobHours: Number.NaN })).toBeNull();
  });
  it("in Spanish through the catalog: trabajadas, en el reloj, en el trabajo", () => {
    expect(hoursLine({ day: day(7.5), jobHours: 22 }, "es", es)).toBe("7.5 h trabajadas · 22 h en el trabajo");
    expect(hoursLine({ day: day(2, 1, true) }, "es", es)).toBe("2 h trabajadas · en el reloj");
    // The translator handed in but the language English: the English, byte for byte.
    expect(hoursLine({ day: day(7.5) }, "en", es)).toBe("7.5 h worked");
  });
  it("says worked, never clocked: the figure is hours paid (lunch off), one basis with the job's figure beside it", () => {
    expect(hoursLine({ day: day(8), jobHours: 22 })).not.toMatch(/clocked|registradas/);
    expect(hoursLine({ day: day(8), jobHours: 22 }, "es", es)).not.toMatch(/clocked|registradas/);
  });
});

describe("billState — where a done job's bills stand", () => {
  const st = (...s: string[]) => s.map((status) => ({ status }));
  it.each([
    ["none", st(), null],
    ["a draft only", st("draft"), null],
    ["paid", st("paid"), "paid"],
    ["paid, and a void one (no bill)", st("paid", "void"), "paid"],
    ["two paid", st("paid", "paid"), "paid"],
    ["paid and a draft: not every one is paid, none is out", st("paid", "draft"), null],
    ["one sent", st("sent"), "open"],
    ["paid and one sent", st("paid", "sent"), "open"],
    ["partial", st("partial"), "open"],
    ["overdue", st("overdue"), "open"],
    ["void alone", st("void"), null],
  ])("%s", (_name, invoices, out) => {
    expect(billState(invoices)).toBe(out);
  });
  it("null-tolerant: no list, a null status", () => {
    expect(billState(null)).toBeNull();
    expect(billState(undefined)).toBeNull();
    expect(billState([{ status: null }, { status: "paid" }])).toBe("paid");
  });
});

describe("jobState — where the job stands, in a tone", () => {
  const office = { canEdit: true, todayStr: TODAY };
  const tech = { canEdit: false, todayStr: TODAY };

  it("on hold: amber and SHORT — On Hold and the day it comes back in the rail's own words; the reason is the note's (skeptic #55)", () => {
    expect(jobState({ status: "on_hold", hold_reason: "Waiting on the permit", hold_until: "2026-11-12" }, tech)).toEqual({
      text: "On Hold · Back Nov 12",
      tone: "warn",
    });
    // The day has come: Back Today (never "3 days ago"); no day at all: On Hold alone — the state line is one
    // `truncate` line in a week column, so a long reason never rides on it (it leads the note instead).
    expect(jobState({ status: "on_hold", hold_reason: "Waiting on the permit", hold_until: "2026-11-01" }, office)?.text).toBe("On Hold · Back Today");
    expect(jobState({ status: "on_hold", hold_reason: "Waiting on the permit and the inspector's callback", hold_until: null }, office)?.text).toBe("On Hold");
    expect(jobState({ status: "on_hold" }, office)?.text).toBe("On Hold");
    // The same for the office and the crew: a hold is nobody's money.
    expect(jobState({ status: "on_hold", hold_until: "2026-11-12" }, office)).toEqual(jobState({ status: "on_hold", hold_until: "2026-11-12" }, tech));
  });

  it("holdReason: one line, folded and trimmed, only while the job IS on hold (a reason left on a job that came off hold is history)", () => {
    expect(holdReason({ status: "on_hold", hold_reason: "  Waiting on   the permit. " })).toBe("Waiting on the permit.");
    expect(holdReason({ status: "on_hold", hold_reason: "Waiting on the permit\nand the inspector's callback" })).toBe("Waiting on the permit and the inspector's callback");
    expect(holdReason({ status: "on_hold", hold_reason: "   " })).toBeNull();
    expect(holdReason({ status: "on_hold" })).toBeNull();
    expect(holdReason({ status: "in_progress", hold_reason: "Waiting on the permit" })).toBeNull();
    expect(holdReason({ status: "complete", hold_reason: "Waiting on the permit" })).toBeNull();
  });

  it("jobNote: the hold's reason FIRST on its own line, then the job's Notes else its Description; the reason alone when both are blank", () => {
    const why = "Waiting on the permit and the inspector's callback";
    expect(jobNote({ status: "on_hold", hold_reason: why, notes: "Gate code 2580.\nDog in the yard.", description: "Service upgrade" })).toBe(`${why}\nGate code 2580.\nDog in the yard.`);
    expect(jobNote({ status: "on_hold", hold_reason: why, notes: null, description: " Service upgrade " })).toBe(`${why}\nService upgrade`);
    expect(jobNote({ status: "on_hold", hold_reason: why })).toBe(why);
    expect(jobNote({ status: "on_hold", hold_reason: why, notes: "  ", description: "" })).toBe(why);
    // Not on hold, or no reason: the job's own words alone, as before; nothing at all when they are blank.
    expect(jobNote({ status: "on_hold", notes: "Dog." })).toBe("Dog.");
    expect(jobNote({ status: "scheduled", hold_reason: why, notes: "Dog." })).toBe("Dog.");
    expect(jobNote({ status: "on_hold" })).toBeNull();
  });

  it("done: emerald; the office's says Paid or Bill Open after it, a tech's says Done alone", () => {
    const paid = { status: "complete", invoices: [{ status: "paid" }, { status: "void" }] };
    const open = { status: "complete", invoices: [{ status: "paid" }, { status: "sent" }] };
    const drafts = { status: "complete", invoices: [{ status: "draft" }] };
    expect(jobState(paid, office)).toEqual({ text: "Done · Paid", tone: "good" });
    expect(jobState(open, office)).toEqual({ text: "Done · Bill Open", tone: "good" });
    expect(jobState(drafts, office)).toEqual({ text: "Done", tone: "good" });
    expect(jobState({ status: "complete" }, office)).toEqual({ text: "Done", tone: "good" });
    for (const j of [paid, open, drafts]) expect(jobState(j, tech)).toEqual({ text: "Done", tone: "good" });
  });

  it("in progress and cancelled plain; scheduled and to be scheduled say nothing; an unknown word says nothing", () => {
    expect(jobState({ status: "in_progress" }, office)).toEqual({ text: "In Progress", tone: "plain" });
    expect(jobState({ status: "cancelled" }, tech)).toEqual({ text: "Cancelled", tone: "plain" });
    expect(jobState({ status: "scheduled" }, office)).toBeNull();
    expect(jobState({ status: "to_be_scheduled" }, office)).toBeNull();
    expect(jobState({ status: null }, office)).toBeNull();
    expect(jobState({ status: "invoiced" }, office)).toBeNull();
  });

  it("in Spanish through the catalog: the house words (En Pausa, Terminado, En Curso)", () => {
    expect(jobState({ status: "on_hold", hold_reason: "Esperando el permiso", hold_until: "2026-11-12" }, office, "es", es)?.text).toBe("En Pausa · Vuelve 12 nov");
    expect(jobState({ status: "on_hold", hold_until: "2026-11-05" }, office, "es", es)?.text).toBe("En Pausa · Vuelve Hoy");
    expect(jobState({ status: "complete", invoices: [{ status: "paid" }] }, office, "es", es)?.text).toBe("Terminado · Pagado");
    expect(jobState({ status: "complete", invoices: [{ status: "overdue" }] }, office, "es", es)?.text).toBe("Terminado · Factura Abierta");
    expect(jobState({ status: "complete", invoices: [{ status: "overdue" }] }, tech, "es", es)?.text).toBe("Terminado");
    expect(jobState({ status: "in_progress" }, tech, "es", es)?.text).toBe("En Curso");
    expect(jobState({ status: "cancelled" }, tech, "es", es)?.text).toBe("Cancelado");
  });
});

describe("visitState and visitBlockExtras", () => {
  it("done emerald (Hecha: a visit is feminine), pending pick amber, otherwise nothing", () => {
    expect(visitState({ status: "completed" })).toEqual({ text: "Done", tone: "good" });
    expect(visitState({ status: "proposed" })).toEqual({ text: "Pending Pick", tone: "warn" });
    expect(visitState({ status: "scheduled" })).toBeNull();
    expect(visitState({ status: "cancelled" })).toBeNull();
    expect(visitState({ status: "completed" }, "es", es)).toEqual({ text: "Hecha", tone: "good" });
    expect(visitState({ status: "proposed" }, "es", es)).toEqual({ text: "Esperando Elección", tone: "warn" });
  });
  it("the three lines: the day's clocked time from its spans (never a whole-job figure), its state, its notes", () => {
    expect(visitBlockExtras({ status: "completed", notes: "  Bring the ladder.\r\n" }, { actual: spans([[540, 600]]) })).toEqual({
      hours: "1 h worked",
      state: { text: "Done", tone: "good" },
      note: "Bring the ladder.",
    });
    expect(visitBlockExtras({ status: "scheduled", notes: null }, {})).toEqual({ hours: null, state: null, note: null });
  });
});

describe("jobBlockExtras — the three lines of a job block", () => {
  const office = { canEdit: true, todayStr: TODAY };

  it("a worked day on a done job for the office: the hours with the job's figure, Done · Paid, the Notes", () => {
    const out = jobBlockExtras(
      { status: "complete", invoices: [{ status: "paid" }], notes: "Gate code 2580.\nDog in the yard.", description: "Service upgrade" },
      { actual: spans([[600, 1080]]), jobHours: 22, ...office },
    );
    expect(out).toEqual({
      hours: "8 h worked · 22 h on the job",
      state: { text: "Done · Paid", tone: "good" },
      note: "Gate code 2580.\nDog in the yard.",
    });
  });

  it("the day's figure is the hours rule's (workedMin, lunch off), one basis with the job's figure: 8 to 4:30 with a 30 min lunch reads 8 h worked", () => {
    const actual: WorkedSpans = { people: [{ spans: [{ startMin: 480, endMin: 990, open: false }], workedMin: 480 }] };
    expect(jobBlockExtras({ status: "in_progress" }, { actual, jobHours: 22, ...office }).hours).toBe("8 h worked · 22 h on the job");
    // Spans alone (no workedMin): the bars' length stands in, the only figure there is.
    expect(jobBlockExtras({ status: "in_progress" }, { actual: spans([[480, 990]]), ...office }).hours).toBe("8.5 h worked");
  });

  it("the note is the job's Notes, else its Description (the scope), else nothing; blank is nothing", () => {
    const p = { todayStr: TODAY };
    expect(jobBlockExtras({ status: "scheduled", notes: null, description: "Service upgrade" }, p).note).toBe("Service upgrade");
    expect(jobBlockExtras({ status: "scheduled", notes: "   ", description: " Service upgrade " }, p).note).toBe("Service upgrade");
    expect(jobBlockExtras({ status: "scheduled", notes: "Dog.", description: "Service upgrade" }, p).note).toBe("Dog.");
    expect(jobBlockExtras({ status: "scheduled" }, p).note).toBeNull();
    expect(noteOf("a\r\nb\rc\n")).toBe("a\nb\nc");
    expect(noteOf(undefined)).toBeNull();
  });

  it("a held job: the state short (On Hold · Back Nov 12), the hold's reason the first line of the note, the job's own words under it (skeptic #55)", () => {
    const why = "Waiting on the permit and the inspector's callback";
    const held = jobBlockExtras({ status: "on_hold", hold_reason: why, hold_until: "2026-11-12", notes: "Gate code 2580." }, office);
    expect(held.state).toEqual({ text: "On Hold · Back Nov 12", tone: "warn" });
    expect(held.note).toBe(`${why}\nGate code 2580.`);
    // No notes and no description: the reason alone is the note; no reason: the state alone says On Hold.
    expect(jobBlockExtras({ status: "on_hold", hold_reason: why }, office).note).toBe(why);
    expect(jobBlockExtras({ status: "on_hold", notes: "Dog." }, office)).toEqual({ hours: null, state: { text: "On Hold", tone: "warn" }, note: "Dog." });
  });

  it("an upcoming scheduled job with nothing known says nothing on all three lines", () => {
    expect(jobBlockExtras({ status: "scheduled" }, { todayStr: TODAY })).toEqual({ hours: null, state: null, note: null });
    // A tech's block (no jobHours by construction): the day's figure alone.
    expect(jobBlockExtras({ status: "scheduled" }, { actual: spans([[540, 1020]]), todayStr: TODAY }).hours).toBe("8 h worked");
  });

  it("today, still on the clock: the closed stretch counts, the running one says so", () => {
    const out = jobBlockExtras({ status: "in_progress" }, { actual: spans([[420, 480], [510, 600, true, true]]), jobHours: 22, ...office });
    expect(out.hours).toBe("1 h worked · on the clock · 22 h on the job");
    expect(out.state).toEqual({ text: "In Progress", tone: "plain" });
  });

  it("in Spanish, through the catalog, every line", () => {
    const out = jobBlockExtras(
      { status: "on_hold", hold_reason: "Esperando el permiso", hold_until: "2026-11-12", notes: "Código 2580." },
      { actual: spans([[600, 1080]]), jobHours: 22, ...office },
      "es",
      es,
    );
    expect(out).toEqual({
      hours: "8 h trabajadas · 22 h en el trabajo",
      state: { text: "En Pausa · Vuelve 12 nov", tone: "warn" },
      // The reason is the person's own words, in whatever language they wrote it; it leads the note the same way.
      note: "Esperando el permiso\nCódigo 2580.",
    });
  });
});

describe("foldHoursByJob — every job's hours from its closed entries, the ONE hours rule", () => {
  it("sums hoursBetween per job (lunch off), two places, and skips an open or job-less entry", () => {
    const rows = [
      { job_id: "j1", clock_in: "2026-11-02T17:00:00Z", clock_out: "2026-11-03T01:30:00Z", lunch_minutes: 30 }, // 8.5 − 0.5 = 8
      { job_id: "j1", clock_in: "2026-11-03T17:00:00Z", clock_out: "2026-11-03T21:20:00Z", lunch_minutes: 0 }, // 4.33
      { job_id: "j2", clock_in: "2026-11-03T17:00:00Z", clock_out: "2026-11-03T17:15:00Z", lunch_minutes: null }, // 0.25
      { job_id: "j2", clock_in: "2026-11-04T17:00:00Z", clock_out: null, lunch_minutes: 0 }, // open: not hours yet
      { job_id: null, clock_in: "2026-11-04T17:00:00Z", clock_out: "2026-11-04T19:00:00Z", lunch_minutes: 0 }, // no job
    ];
    expect(foldHoursByJob(rows)).toEqual({ j1: 12.33, j2: 0.25 });
  });
  it("nothing in: an empty record; a bad timestamp adds nothing (hoursBetween's own rule)", () => {
    expect(foldHoursByJob(null)).toEqual({});
    expect(foldHoursByJob([])).toEqual({});
    expect(foldHoursByJob([{ job_id: "j1", clock_in: "nope", clock_out: "2026-11-04T19:00:00Z" }])).toEqual({ j1: 0 });
  });
  it("the panel's page bound is stated, not a bare limit", () => {
    expect(JOB_HOURS_PAGES).toBe(4);
  });
});

describe("the words", () => {
  it("the state words are Title Case in both languages; the hours fragments are not doors", () => {
    const en = translator("en");
    for (const key of ["ag_stateOnHold", "ag_stateDone", "ag_stateDoneVisit", "ag_statePaid", "ag_stateBillOpen", "ag_stateInProgress", "ag_stateCancelled", "ag_statePendingPick"]) {
      expect(titleCaseIn(en(key), "en"), `en:${key} ${en(key)}`).toBe(true);
      expect(titleCaseIn(es(key), "es"), `es:${key} ${es(key)}`).toBe(true);
    }
    // "Worked", not "clocked" (skeptic #55): the figure is hours paid, lunch off; the old key is gone.
    expect(en("ag_hWorked")).toBe("{h} h worked");
    expect(es("ag_hWorked")).toBe("{h} h trabajadas");
    expect(en("ag_hClocked")).toBe("ag_hClocked");
    expect(en("ag_hOnTheJob")).toBe("{h} h on the job");
    expect(es("ag_hOnTheJob")).toBe("{h} h en el trabajo");
    expect(en("ag_onTheClock")).toBe("on the clock");
    expect(es("ag_onTheClock")).toBe("en el reloj");
    // The house word for a held job (jb_statusOnHold, ag_offHold), not a second one.
    expect(es("ag_stateOnHold")).toBe(es("jb_statusOnHold"));
    expect(es("ag_stateDone")).toBe(es("jb_statusComplete"));
    expect(es("ag_stateInProgress")).toBe(es("jb_statusInProgress"));
    expect(es("ag_stateCancelled")).toBe(es("jb_statusCancelled"));
  });

  it("the library imports no catalog and names no money", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/schedule/block-extras.ts"), "utf8");
    expect(src).not.toMatch(/@\/lib\/i18n|@\/lib\/words/);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
    expect(code).not.toMatch(/\b(prices?|amounts?|totals?|costs?|rates?|bill_rate|pay_rate)\b|formatCurrency|\$\d/i);
  });
});
