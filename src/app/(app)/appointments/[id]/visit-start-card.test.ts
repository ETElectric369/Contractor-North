import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
  name: "Inspection — Tom Goodman",
  customer: "Tom Goodman",
  address: "3245 W. Lake Blvd, Homewood, CA 96141",
  scheduledStart: "2026-09-25T17:00:00.000Z",
};
const j55 = { id: "job-55", job_number: "J-055", name: "3245 West Lake Boulevard" };
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
      officePhone: "(530) 933-6686",
      ...p,
    }),
  );

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
    expect(visitStartState({ isStaff: true, job: done, openEntry: null, visitStatus: "completed" })).toBe("closed");
    expect(visitStartState({ isStaff: false, job: done, openEntry: onJ50, visitStatus: "completed" })).toBe("closed");
    // Already on it is still said as it is.
    expect(visitStartState({ isStaff: true, job: done, openEntry: onJ55, visitStatus: "completed" })).toBe("here");
    // A finished job on a visit still to come, or an open job on a finished visit, keeps its clock.
    expect(visitStartState({ isStaff: true, job: done, openEntry: null, visitStatus: "scheduled" })).toBe("linked");
    expect(visitStartState({ isStaff: true, job: { ...j55, status: "in_progress" }, openEntry: null, visitStatus: "completed" })).toBe("linked");
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
    expect(h).toContain("3245 West Lake Boulevard");
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

  it("a clock on no job says the whole shift moves, not that a part ends", () => {
    const h = render({ openEntry: { id: "e-0", job_id: null, label: "no job", clock_in: onJ55.clock_in, whole: true } });
    expect(h).toContain("Starting this job moves that whole shift onto it.");
    const linked = render({ job: j55, openEntry: { id: "e-0", job_id: null, label: "no job", clock_in: onJ55.clock_in, whole: true } });
    expect(linked).toContain("Switching moves that whole shift onto J-055.");
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
    const h = render({ visitStatus: "completed", linkInstead: tomDone });
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
    const h = render({ visitStatus: "completed", linkInstead: tomDone, openEntry: onJ50 });
    expect(h).toContain("Link To J-055</button>");
    expect(h).not.toContain("switches your clock");
    expect(h).not.toContain("Start The Job And Clock In");
  });

  it("with no job to link, it offers one quiet Start A Job From This Visit, and no clock", () => {
    const h = render({ visitStatus: "completed" });
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
        const h = render({ isStaff, visitStatus: "completed", job: { ...j55, status: "complete" }, openEntry });
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
    const h = render({ visitStatus: "scheduled", job: { ...j55, status: "complete" } });
    expect(h).toContain("Clock In On J-055");
  });

  it("before the visit is over, a finished same-day job is still offered, as Link Instead", () => {
    const h = render({ visitStatus: "scheduled", linkInstead: tomDone });
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
    expect(html).toContain('href="tel:5309336686"');
    expect(html).toContain('href="sms:5309336686"');
    expect(html).not.toContain("Start The Job");
  });
  it("is phone-safe at 375px", () => phoneSafe(html));
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
