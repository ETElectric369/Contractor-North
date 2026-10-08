import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * HOW THE VISIT ENDED, RENDERED (cn-v1069): the face says what the visit became and offers the two
 * honest endings only where they apply, each a 44px door in Title Case; a visit with nothing to say
 * draws nothing. Run the selector, count the doors (the dead-door lesson).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../actions", () => ({ setAppointmentOutcome: vi.fn() }));

import { VisitEnding, endingOffered, outcomeWord } from "./visit-ending";

const TZ = "America/Los_Angeles";
const base = {
  appointmentId: "appt-1",
  isStaff: true,
  estimateVisit: true,
  status: "completed",
  estimate: null,
  outcome: null,
  outcomeAt: null,
  job: null,
  tz: TZ,
};
const html = (o: Partial<Parameters<typeof VisitEnding>[0]>) => renderToStaticMarkup(createElement(VisitEnding, { ...base, ...o }));
const doors = (s: string) => (s.match(/<button[^>]*>/g) ?? []).length;

describe("the ending doors are offered only where they apply", () => {
  it("a completed estimate visit, undecided, no job, no live estimate: the office gets Lost and Nothing Came Of It", () => {
    expect(endingOffered({ isStaff: true, status: "completed", outcome: null, hasJob: false, estimateLive: false, estimateVisit: true })).toBe(true);
    const s = html({});
    expect(s).toContain("How did this one end?");
    expect(s).toContain(">Lost<");
    expect(s).toContain(">Nothing Came Of It<");
    expect(s).not.toContain(">Won<"); // a win is recorded by the job or the estimate, never typed here
    expect(doors(s)).toBe(2);
    for (const m of s.match(/<button[^>]*>/g) ?? []) expect(m).toContain("min-h-[44px]");
  });

  it("not for a tech, a booked visit, a visit with a job, one with a live estimate, a work visit, or one already decided", () => {
    expect(endingOffered({ isStaff: false, status: "completed", outcome: null, hasJob: false, estimateLive: false, estimateVisit: true })).toBe(false);
    expect(endingOffered({ isStaff: true, status: "scheduled", outcome: null, hasJob: false, estimateLive: false, estimateVisit: true })).toBe(false);
    expect(endingOffered({ isStaff: true, status: "completed", outcome: null, hasJob: true, estimateLive: false, estimateVisit: true })).toBe(false);
    expect(endingOffered({ isStaff: true, status: "completed", outcome: null, hasJob: false, estimateLive: true, estimateVisit: true })).toBe(false);
    expect(endingOffered({ isStaff: true, status: "completed", outcome: null, hasJob: false, estimateLive: false, estimateVisit: false })).toBe(false);
    expect(endingOffered({ isStaff: true, status: "completed", outcome: "lost", hasJob: false, estimateLive: false, estimateVisit: true })).toBe(false);
    // A visit with nothing to say draws nothing at all.
    expect(html({ status: "scheduled" })).toBe("");
    expect(html({ isStaff: false })).toBe("");
  });
});

describe("what the visit became", () => {
  it("the estimate is named and linked; a dead one says so (Start The Estimate returns on the Inspector)", () => {
    const live = html({ estimate: { id: "q1", number: "EST-0042", status: "sent", live: true } });
    expect(live).toContain('href="/quotes/q1"');
    expect(live).toContain("EST-0042");
    expect(live).toContain("· sent");
    expect(live).not.toContain("is over");
    expect(doors(live)).toBe(0); // a live estimate decides it from the estimate's side
    const dead = html({ estimate: { id: "q1", number: "EST-0042", status: "declined", live: false } });
    expect(dead).toContain("that estimate is over");
  });

  it("the outcome reads in plain words with its day, the won job linked, and the office can change it", () => {
    expect(outcomeWord("won")).toBe("Won");
    expect(outcomeWord("lost")).toBe("Lost");
    expect(outcomeWord("no_bid")).toBe("Nothing Came Of It");
    expect(outcomeWord(null)).toBeNull();
    const s = html({ outcome: "won", outcomeAt: "2026-07-31T20:00:00.000Z", job: { id: "j1", job_number: "J-038", name: "The lake place" } });
    expect(s).toContain(">Won<");
    expect(s).toContain("Jul 31, 2026");
    expect(s).toContain('href="/jobs/j1"');
    expect(s).toContain("J-038 The lake place");
    expect(s).toContain(">Change<");
    expect(doors(s)).toBe(1);
    // A tech reads the answer and gets no Change.
    expect(doors(html({ isStaff: false, outcome: "lost", outcomeAt: "2026-07-31T20:00:00.000Z" }))).toBe(0);
  });
});
