import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

/**
 * HOW THE VISIT ENDED, RENDERED (cn-v1069): the face says what the visit became and offers the two
 * honest endings only where they apply, each a 44px door in Title Case; a visit with nothing to say
 * draws nothing. Run the selector, count the doors (the dead-door lesson).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../actions", () => ({ setAppointmentOutcome: vi.fn(), linkAppointmentTo: vi.fn(), searchLinkTargets: vi.fn(async () => []) }));

import { VisitEnding, endingOffered, outcomeWord } from "./visit-ending";
import { DECIDABLE_VISIT_TYPES, isDecidableVisitType } from "@/lib/statuses";

const TZ = "America/Los_Angeles";
const base = {
  appointmentId: "appt-1",
  isStaff: true,
  decidable: true,
  status: "completed",
  estimate: null,
  outcome: null,
  outcomeAt: null,
  job: null,
  tz: TZ,
};
const html = (o: Partial<Parameters<typeof VisitEnding>[0]>) => renderToStaticMarkup(createElement(VisitEnding, { ...base, ...o }));
const doors = (s: string) => (s.match(/<button[^>]*>/g) ?? []).length;

describe("which visits have a win or a loss to record", () => {
  it("a meeting, a call, an Other visit, an inspection, a quote visit — and an untyped one; never a work visit or a final inspection", () => {
    // Erik's two meetings "with nothing else to come of them" are stored as the plain appointment type.
    for (const t of ["appointment", "meeting", "call", "other", "inspection", "quote", null, ""]) expect(isDecidableVisitType(t), String(t)).toBe(true);
    for (const t of ["job", "service_call", "final_inspection"]) expect(isDecidableVisitType(t), t).toBe(false);
    expect(DECIDABLE_VISIT_TYPES).not.toContain("job");
    expect(DECIDABLE_VISIT_TYPES).toContain("appointment");
  });
});

describe("the ending doors are offered only where they apply", () => {
  it("a completed visit with a loss to record, undecided, no job, no live estimate: the office gets ONE door, Lost (KISS)", () => {
    expect(endingOffered({ isStaff: true, status: "completed", outcome: null, hasJob: false, estimateLive: false, decidable: true })).toBe(true);
    const s = html({});
    expect(s).toContain("How did this one end?");
    expect(s).toContain(">Lost<");
    expect(s).not.toContain("Nothing Came Of It"); // Erik: "just keep Lost everywhere"
    expect(s).not.toContain(">Won<"); // a win is never typed alone: it is the job the visit became
    expect(s).toContain("Won · Pick The Job"); // the attach door, jobs only, right on the card
    expect(doors(s)).toBe(2);
    for (const m of s.match(/<button[^>]*>/g) ?? []) expect(m).toContain("min-h-[44px]");
  });

  it("not for a tech, a booked visit, a visit with a job, one with a live estimate, a work visit, or one already decided", () => {
    expect(endingOffered({ isStaff: false, status: "completed", outcome: null, hasJob: false, estimateLive: false, decidable: true })).toBe(false);
    expect(endingOffered({ isStaff: true, status: "scheduled", outcome: null, hasJob: false, estimateLive: false, decidable: true })).toBe(false);
    expect(endingOffered({ isStaff: true, status: "completed", outcome: null, hasJob: true, estimateLive: false, decidable: true })).toBe(false);
    expect(endingOffered({ isStaff: true, status: "completed", outcome: null, hasJob: false, estimateLive: true, decidable: true })).toBe(false);
    expect(endingOffered({ isStaff: true, status: "completed", outcome: null, hasJob: false, estimateLive: false, decidable: false })).toBe(false);
    expect(endingOffered({ isStaff: true, status: "completed", outcome: "lost", hasJob: false, estimateLive: false, decidable: true })).toBe(false);
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
    expect(outcomeWord("no_bid")).toBe("Lost"); // an old no_bid row reads the one word too
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


describe("the Edit Details modal escapes the glass ⋯ panel", () => {
  it("the row-triggered modal is portaled (the cn-v463 class: an in-place overlay inside a backdrop-filter panel clips to a sliver)", () => {
    const src = readFileSync(new URL("../appointment-button.tsx", import.meta.url), "utf8");
    expect(src).toContain("portal={!!rowLabel}");
    expect(src).toContain('formId="appt-form"'); // portal-safe submit: the form is inside the modal
  });
});
