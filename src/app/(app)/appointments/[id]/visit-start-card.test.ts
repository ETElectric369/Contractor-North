import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

/**
 * THE TOP OF THE VISIT, RENDERED: each face of the card, counted on the real component (the
 * dead-door lesson: run the selector, count the buttons). At 375px every door is a full-width,
 * 44px-tall row (w-full h-11), widening only from sm up; nothing on the card carries a fixed width
 * a phone could scroll sideways for.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../start-job-actions", () => ({
  startJobFromVisit: vi.fn(),
  linkVisitInstead: vi.fn(),
  askOfficeToStartJob: vi.fn(),
}));
vi.mock("../../timeclock/actions", () => ({ clockIn: vi.fn(), switchJob: vi.fn(), deleteTimeEntry: vi.fn() }));

import { VisitStartCard, visitStartState, visitTimeOffered } from "./visit-start-card";

const TZ = "America/Los_Angeles";
const preview = {
  // The name Start The Job gives (lib/job-name): the street, never the visit's "Walk-Through:" tag.
  name: "3245 W. Garnet Blvd",
  customer: "Tom Goodman",
  address: "3245 W. Garnet Blvd, Homewood, CA 96141",
  scheduledStart: "2026-09-25T17:00:00.000Z",
};
const j55 = { id: "job-55", job_number: "J-055", name: "3245 West Garnet Boulevard" };
const onJ50 = { id: "entry-50", job_id: "job-50", label: "J-050", clock_in: "2026-09-25T15:00:00.000Z" };
const onJ55 = { id: "entry-55", job_id: "job-55", label: "J-055", clock_in: "2026-09-25T19:00:00.000Z" };

type Props = Parameters<typeof VisitStartCard>[0];
const render = (p: Partial<Props>) =>
  renderToStaticMarkup(
    createElement(VisitStartCard, {
      appointmentId: "appt-tom",
      tz: TZ,
      isStaff: true,
      job: null,
      openEntry: null,
      linkInstead: null,
      preview,
      officePhone: "(530) 555-0133",
      ...p,
    }),
  );

/** A client effect cannot run in this suite (no DOM), so the ticker and the one derivation are read. */
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const count = (html: string, s: string) => html.split(s).length - 1;
/** Every <button> and <a> on the card, as its opening tag. */
const doors = (html: string) => html.match(/<(button|a)\b[^>]*>/g) ?? [];

/** The 375px law, on the markup: every door is 44px tall and full-width on a phone. */
function phoneSafe(html: string) {
  const ds = doors(html);
  expect(ds.length).toBeGreaterThan(0);
  for (const d of ds) {
    expect(d, d).toContain("h-11");
    expect(d, d).toContain("w-full");
  }
  // No fixed pixel/rem widths anywhere on the card (a w-[…] or min-w wider than a phone).
  expect(html).not.toMatch(/\b(min-)?w-\[\d/);
}

describe("which face the card shows", () => {
  it("office with no job starts it; crew with no job asks; a linked job clocks in, switches, or says you're on it", () => {
    expect(visitStartState({ isStaff: true, job: null, openEntry: null })).toBe("start");
    expect(visitStartState({ isStaff: true, job: null, openEntry: onJ50 })).toBe("start");
    expect(visitStartState({ isStaff: false, job: null, openEntry: null })).toBe("ask");
    expect(visitStartState({ isStaff: false, job: j55, openEntry: null })).toBe("linked");
    expect(visitStartState({ isStaff: true, job: j55, openEntry: onJ50 })).toBe("switch");
    expect(visitStartState({ isStaff: false, job: j55, openEntry: onJ55 })).toBe("here");
  });

  it("a visit that is over, on a finished job, is closed: no clock, whoever looks and wherever they are", () => {
    const done = { ...j55, status: "complete" };
    expect(visitStartState({ isStaff: true, job: done, openEntry: null, visitOver: true })).toBe("closed");
    expect(visitStartState({ isStaff: false, job: done, openEntry: onJ50, visitOver: true })).toBe("closed");
    // Already on it is still said as it is.
    expect(visitStartState({ isStaff: true, job: done, openEntry: onJ55, visitOver: true })).toBe("here");
    // A finished job on a visit still to come, or an open job on a finished visit, keeps its clock.
    expect(visitStartState({ isStaff: true, job: done, openEntry: null, visitOver: false })).toBe("linked");
    expect(visitStartState({ isStaff: true, job: { ...j55, status: "in_progress" }, openEntry: null, visitOver: true })).toBe("linked");
  });
});

describe("office, no job yet", () => {
  const html = render({});
  it("leads with Start The Job And Clock In, then Start The Job", () => {
    expect(html).toContain('data-visit-start="start"');
    expect(count(html, "Start The Job And Clock In")).toBe(1); // the sheet is closed until tapped
    expect(html).toContain("Start The Job</button>");
    expect(html.indexOf("Start The Job And Clock In")).toBeLessThan(html.indexOf("Start The Job</button>"));
    expect(html).toContain("It brings Tom Goodman, the address and the visit time along.");
    expect(html).not.toContain("Link To");
  });
  it("is phone-safe at 375px", () => phoneSafe(html));

  it("offers Link To J-055 Instead when the customer has the one same-day job", () => {
    const h = render({ linkInstead: { ...j55, customer: "Tom Goodman" } });
    expect(h).toContain("Link To J-055 Instead");
    expect(h).toContain("Tom Goodman already has");
    expect(h).toContain("3245 West Garnet Boulevard");
    phoneSafe(h);
  });

  it("with a same-day job on offer, Link Instead LEADS and a new job is the second door", () => {
    const h = render({ linkInstead: { ...j55, customer: "Tom Goodman" } });
    const btns = h.match(/<button\b[^>]*>.*?<\/button>/g) ?? [];
    expect(btns[0]).toContain("Link To J-055 Instead");
    expect(btns[0]).toContain("bg-[rgb(var(--glass-ink))] text-white"); // the primary style
    expect(btns[1]).not.toContain("bg-[rgb(var(--glass-ink))] text-white");
    expect(btns[1]).toContain("Make A New Job Anyway");
    expect(h).not.toContain("Start The Job And Clock In");
  });

  it("Tom Goodman as it stood: on the clock on J-055 itself, the card links and never offers the switch", () => {
    const h = render({ linkInstead: { ...j55, customer: "Tom Goodman" }, openEntry: onJ55 });
    expect(h).toContain("on the clock on <span class=\"font-semibold\">J-055</span> since 12:00 PM");
    expect(h).toContain("Link this visit to it.");
    expect(h).toContain("Link To J-055</button>");
    expect(h).not.toContain("Link To J-055 Instead");
    expect(h).not.toContain("Switch To This Job");
    expect(h).not.toContain("switches your clock here");
    expect(h).not.toContain("Start The Job And Clock In");
    expect(h).toContain("Make A New Job Anyway");
    phoneSafe(h);
  });

  it("a clock on no job says the whole punch moves, not that a part ends", () => {
    const jobless = { id: "e-0", job_id: null, job_code: null, label: "no job", clock_in: onJ55.clock_in };
    const h = render({ openEntry: jobless });
    expect(h).toContain("Starting this job moves this whole punch onto it — none of it stays behind.");
    const linked = render({ job: j55, openEntry: jobless });
    expect(linked).toContain("Switching moves this whole punch onto J-055 — none of it stays behind.");
    expect(linked).not.toContain("ends that part now");
  });

  it("Visit Time is not offered inside the tapper's last finished shift", () => {
    const now = Date.parse("2026-09-25T22:32:00Z");
    // Visit at 10:00 AM; the J-050 shift ran to 11:30 AM.
    expect(visitTimeOffered(preview.scheduledStart, "2026-09-25T18:30:00.000Z", now, TZ)).toBe(false);
    expect(visitTimeOffered(preview.scheduledStart, "2026-09-25T16:30:00.000Z", now, TZ)).toBe(true);
    expect(visitTimeOffered(preview.scheduledStart, null, now, TZ)).toBe(true);
    expect(visitTimeOffered(null, null, now, TZ)).toBe(false);
  });

  it("names the running clock when the tapper is on another job", () => {
    const h = render({ openEntry: onJ50 });
    expect(h).toContain("on the clock on J-050 since 8:00 AM");
    expect(h).toContain("Starting this job switches your clock here.");
  });
});

describe("a visit that is over (Tom Goodman as it stands: visit completed, J-055 finished, INV-079 sent)", () => {
  const tomDone = { ...j55, status: "complete", customer: "Tom Goodman" };
  const buttons = (h: string) => h.match(/<button\b[^>]*>.*?<\/button>/g) ?? [];

  it("leads with Link To J-055, never with Start The Job And Clock In", () => {
    const h = render({ visitOver: true, linkInstead: tomDone });
    expect(h).toContain('data-visit-start="start"');
    expect(h).toContain("This visit is done");
    expect(h).toContain("made that day and finished.");
    expect(h).toContain("Link this visit to it?");
    const btns = buttons(h);
    expect(btns).toHaveLength(2);
    expect(btns[0]).toContain("Link To J-055</button>");
    expect(btns[0]).not.toContain("Instead");
    expect(btns[0]).toContain("bg-[rgb(var(--glass-ink))] text-white"); // the lead door
    expect(btns[1]).toContain("Make A New Job Anyway");
    expect(h).not.toContain("Start The Job And Clock In");
    expect(h).not.toContain("Clock In");
    phoneSafe(h);
  });

  it("the same on the clock somewhere else: no switch talk, since nothing here moves the clock", () => {
    const h = render({ visitOver: true, linkInstead: tomDone, openEntry: onJ50 });
    expect(h).toContain("Link To J-055</button>");
    expect(h).not.toContain("switches your clock");
    expect(h).not.toContain("Start The Job And Clock In");
  });

  it("with no job to link, it offers one quiet Start A Job From This Visit, and no clock", () => {
    const h = render({ visitOver: true });
    expect(h).toContain("This visit is done");
    expect(h).toContain("doesn’t start your clock");
    const btns = buttons(h);
    expect(btns).toHaveLength(1);
    expect(btns[0]).toContain("Start A Job From This Visit");
    expect(btns[0]).not.toContain("bg-[rgb(var(--glass-ink))] text-white"); // quiet: the outline door
    expect(h).not.toContain("Start The Job And Clock In");
    expect(h).not.toContain("Link To");
    phoneSafe(h);
  });

  it("linked to a finished J-055, it shows Open J-055 and no Clock In or Switch", () => {
    for (const openEntry of [null, onJ50]) {
      for (const isStaff of [true, false]) {
        const h = render({ isStaff, visitOver: true, job: { ...j55, status: "complete" }, openEntry });
        expect(h).toContain('data-visit-start="closed"');
        expect(h).toContain("The visit is done and J-055 is finished");
        expect(h).toContain('href="/jobs/job-55"');
        expect(h).toContain("Open J-055");
        expect(h).not.toContain("Clock In");
        expect(h).not.toContain("Switch To");
        expect(buttons(h)).toHaveLength(0);
        phoneSafe(h);
      }
    }
  });

  it("a finished job on a visit still to come keeps its Clock In (only the pair closes the door)", () => {
    const h = render({ visitOver: false, job: { ...j55, status: "complete" } });
    expect(h).toContain("Clock In On J-055");
  });

  it("before the visit is over, a finished same-day job is still offered, as Link Instead", () => {
    const h = render({ visitOver: false, linkInstead: tomDone });
    expect(buttons(h)[0]).toContain("Link To J-055 Instead");
    expect(h).toContain("made that day and finished.");
  });
});

describe("crew, no job yet: no dead end", () => {
  const html = render({ isStaff: false });
  it("asks the office, and calls or texts it", () => {
    expect(html).toContain('data-visit-start="ask"');
    expect(html).toContain("Ask the office to start the job");
    expect(html).toContain("Ask The Office");
    expect(html).toContain('href="tel:5305550133"');
    expect(html).toContain('href="sms:5305550133"');
    expect(html).not.toContain("Start The Job");
  });
  it("is phone-safe at 375px", () => phoneSafe(html));
  it("on a visit that is over, it never promises a clock-in right here (audit v1018)", () => {
    const h = render({ isStaff: false, visitOver: true });
    expect(h).toContain("This visit is done and has no job. If the work goes on, ask the office to start one.");
    expect(h).not.toContain("clock in right here");
    expect(h).toContain("Ask The Office");
    phoneSafe(h);
    expect(html).toContain("Once they do, you can clock in right here.");
  });
  it("with no office phone on file, Ask The Office is still there", () => {
    const h = render({ isStaff: false, officePhone: null });
    expect(h).toContain("Ask The Office");
    expect(h).not.toContain("tel:");
  });
});

describe("a linked job, for the office and the crew alike", () => {
  for (const isStaff of [true, false]) {
    const who = isStaff ? "office" : "crew";
    it(`${who}: Clock In On J-055 and Open J-055`, () => {
      const html = render({ isStaff, job: j55 });
      expect(html).toContain('data-visit-start="linked"');
      expect(html).toContain("Clock In On J-055");
      expect(html).toContain('href="/jobs/job-55"');
      expect(html).toContain("Open J-055");
      expect(html).not.toContain("Start The Job");
      phoneSafe(html);
    });
  }

  it("on the clock elsewhere: Switch To J-055, naming what it ends", () => {
    const html = render({ job: j55, openEntry: onJ50 });
    expect(html).toContain('data-visit-start="switch"');
    expect(html).toContain("Switch To J-055");
    expect(html).not.toContain("Clock In On");
    expect(html).toContain("Switching ends that part now");
    phoneSafe(html);
  });

  it("already on it: You're On The Clock Here, and nothing to tap twice", () => {
    const html = render({ isStaff: false, job: j55, openEntry: onJ55 });
    expect(html).toContain('data-visit-start="here"');
    expect(html).toContain("On The Clock Here");
    expect(html).not.toContain("Clock In On");
    expect(html).toContain("Open J-055");
    phoneSafe(html);
  });
});

/**
 * THE CARD MAY NOT PROMISE A CUT THE SERVER IS GOING TO MOVE WHOLE (review, 2026-10-03).
 *
 * The visit card is the THIRD door onto switchJob, and the young-punch rule (switch-window) reached
 * only the other two. Its sentences hung on a `whole` flag that still meant "no job and no code", so a
 * man five minutes into J-050 was told "Switching ends that part now" while the server moved his whole
 * punch and left J-050 with nothing. The sentence is about which customer gets the hours.
 *
 * The rule is the punch's AGE, so these render the real card against a fixed clock.
 */
describe("whole or cut, decided by the punch's age and not by a flag", () => {
  const CLOCK_IN = "2026-09-25T15:00:00.000Z"; // 8:00 AM on the org's clock
  const youngOnJ50 = { ...onJ50, job_code: null, clock_in: CLOCK_IN };
  /** Render with the clock at a fixed moment: whole-or-cut turns on what time it is NOW. */
  const atClock = (iso: string, p: Partial<Props>) => {
    vi.useFakeTimers({ now: Date.parse(iso) });
    try {
      return render(p);
    } finally {
      vi.useRealTimers();
    }
  };

  it("THE DEFECT: five minutes into J-050, the switch face says the whole punch moves — never that a part ends", () => {
    const h = atClock("2026-09-25T15:05:00.000Z", { job: j55, openEntry: youngOnJ50 });
    expect(h).toContain("on the clock on J-050 since 8:00 AM");
    expect(h).toContain("Switching moves this whole punch onto J-055 — none of it stays behind.");
    expect(h).not.toContain("ends that part now");
  });

  it("and the start face, where the same tap makes the job first, says the same thing", () => {
    const h = atClock("2026-09-25T15:05:00.000Z", { openEntry: youngOnJ50 });
    expect(h).toContain("Starting this job moves this whole punch onto it — none of it stays behind.");
    expect(h).not.toContain("switches your clock here");
  });

  it("a tech on the switch face reads it too: visitStartState has no staff gate once a job is linked", () => {
    const h = atClock("2026-09-25T15:05:00.000Z", { isStaff: false, job: j55, openEntry: youngOnJ50 });
    expect(h).toContain("Switching moves this whole punch onto J-055 — none of it stays behind.");
  });

  it("the window still has an end: twenty minutes in, the cut is named as the cut", () => {
    const h = atClock("2026-09-25T15:20:00.000Z", { job: j55, openEntry: youngOnJ50 });
    expect(h).toContain("Switching ends that part now and starts this one.");
    expect(h).not.toContain("whole punch");
    const started = atClock("2026-09-25T15:20:00.000Z", { openEntry: youngOnJ50 });
    expect(started).toContain("Starting this job switches your clock here.");
  });

  it("a punch with a TIME CODE and no job is placed too, so it is judged by the clock like any other", () => {
    const onDrive = { id: "e-dr", job_id: null, job_code: "DRIVE", label: "DRIVE", clock_in: CLOCK_IN };
    expect(atClock("2026-09-25T15:05:00.000Z", { job: j55, openEntry: onDrive })).toContain("Switching moves this whole punch onto J-055");
    expect(atClock("2026-09-25T15:20:00.000Z", { job: j55, openEntry: onDrive })).toContain("Switching ends that part now");
  });

  it("the card carries no baked answer: the two facts travel, the rule is asked here", () => {
    const card = src("./visit-start-card.tsx");
    // ONE derivation, the shared function, for both faces and the sheet.
    expect(card).toContain('import { switchMovesWholeNow } from "../../timeclock/switch-window";');
    expect(card).toMatch(/const movesWhole = \(oc: \{ jobId: string \| null; jobCode: string \| null; clockIn: string \}\) =>\s*switchMovesWholeNow\(!!oc\.jobId \|\| !!oc\.jobCode, Date\.parse\(oc\.clockIn\), nowMs\);/);
    expect(card).toContain("{movesWhole(onClock)");
    // The sheet's whole branch no longer claims the punch has no job — it names the job it is on.
    expect(card).not.toContain("with no job. This moves that whole shift");
    expect(card).toContain("This moves this whole punch onto the new job");
    // A render-time answer goes stale on a card left open in a truck, so the card re-renders while
    // somebody is on the clock (the Timeclock panel's ticker, for the same reason).
    expect(card).toMatch(/useEffect\(\(\) => \{\s*if \(!onClock && !sheet\) return;\s*setNowMs\(Date\.now\(\)\);\s*const t = setInterval\(\(\) => setNowMs\(Date\.now\(\)\), 1000\);/);
    // And the page hands over the facts, never the decision.
    const page = src("./page.tsx");
    expect(page).not.toContain("whole: !oe.job_id");
    expect(page).toContain('job_code: (oe.job_code ?? "").trim() || null,');
  });
});
