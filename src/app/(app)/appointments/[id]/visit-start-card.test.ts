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

import { VisitStartCard, visitStartState } from "./visit-start-card";

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

  it("names the running clock when the tapper is on another job", () => {
    const h = render({ openEntry: onJ50 });
    expect(h).toContain("on the clock on J-050 since 8:00 AM");
    expect(h).toContain("Starting this job switches your clock here.");
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
