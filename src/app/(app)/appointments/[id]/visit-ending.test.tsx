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
vi.mock("../actions", () => ({ setAppointmentOutcome: vi.fn(), linkAppointmentTo: vi.fn(), searchLinkTargets: vi.fn(async () => []), searchJobsForVisit: vi.fn(async () => []) }));

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
  visitType: "inspection" as string | null,
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
  it("a completed visit with a loss to record, undecided, no job, no live estimate: the office gets ONE door, Not Sold (KISS)", () => {
    expect(endingOffered({ isStaff: true, status: "completed", outcome: null, hasJob: false, estimateLive: false, decidable: true })).toBe(true);
    const s = html({});
    expect(s).toContain("How did this one end?");
    // cn-v1170: Erik, "Not Sold" replaces "Lost" everywhere.
    expect(s).toContain(">Not Sold<");
    expect(s).not.toContain(">Lost<");
    expect(s).not.toContain("Nothing Came of It"); // Erik: "just keep Lost everywhere"
    expect(s).not.toContain(">Won<"); // a win is never typed alone: it is the job the visit became
    // cn-v1176: Won is the Inspector's bottom door; the card keeps the QUIET pick of a job that exists.
    expect(s).toContain("Already Have the Job? Pick It");
    expect(s).not.toContain("Won · Pick the Job");
    expect(s).not.toContain("Won · Start the Job");
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
  it("the estimate is named and linked; a dead one says so (Start the Estimate returns on the Inspector)", () => {
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
    expect(outcomeWord("lost")).toBe("Not Sold");
    expect(outcomeWord("no_bid")).toBe("Not Sold"); // an old no_bid row reads the one word too
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

/**
 * WON IS THE INSPECTOR'S DOOR (cn-v1176, E4). The card no longer picks a job to be won: an undecided
 * visit is offered Not Sold and the QUIET pick of a job that already exists (narrowed to this visit's
 * own customer and lead); a visit marked Won with no job says so and carries ONE link to the Won sheet.
 */
describe("the ending card after cn-v1176", () => {
  it("Won with no job: the card says so, ONE link to the Won sheet (?won=1), the quiet pick beside it, Change for the rest", () => {
    const s = html({ outcome: "won", outcomeAt: "2026-11-20T20:00:00.000Z" });
    expect(s).toContain(">Won<");
    expect(s).toContain("No job yet.");
    expect(s).toContain('href="/appointments/appt-1?won=1"');
    expect((s.match(/Won · Start the Job/g) ?? []).length).toBe(1);
    expect(s).toContain("Already Have the Job? Pick It");
    expect(s).toContain(">Change<");
    // Not Sold sits behind Change, never beside the win.
    expect(s).not.toContain(">Not Sold<");
    // Nothing new is amber (amber is a real clock).
    expect(s).not.toMatch(/amber/);
  });

  it("an undecided visit: Not Sold and the quiet pick, and nothing that wins it from the card", () => {
    const s = html({});
    expect(s).toContain(">Not Sold<");
    expect(s).toContain("Already Have the Job? Pick It");
    expect(s).not.toContain("?won=1");
    expect(s).not.toMatch(/amber/);
  });

  it("a visit Won with its job, a tech, a work visit: no Won sheet link", () => {
    expect(html({ outcome: "won", job: { id: "j1", job_number: "J-900", name: "12 Larkspur Ln" } })).not.toContain("?won=1");
    expect(html({ isStaff: false, outcome: "won" })).not.toContain("?won=1");
    expect(html({ decidable: false, outcome: "won" })).not.toContain("?won=1");
  });

  it("cn-v1176 fix F2: a call or a meeting marked Won with no job keeps the quiet pick and no Won sheet link (no dead end)", () => {
    for (const visitType of ["call", "meeting", "appointment"]) {
      const s = html({ outcome: "won", visitType });
      expect(s, visitType).toContain("No job yet.");
      expect(s, visitType).toContain("Already Have the Job? Pick It");
      expect(s, visitType).not.toContain("?won=1");
      expect(s, visitType).not.toContain("Won · Start the Job");
    }
    // The estimate visit is a sale the sheet takes: its link is drawn.
    expect(html({ outcome: "won", visitType: "quote" })).toContain('href="/appointments/appt-1?won=1"');
  });

  it("the pick is the narrowed one, through the attach door; the card holds no Won · Pick the Job", () => {
    const src = readFileSync("src/app/(app)/appointments/[id]/visit-ending.tsx", "utf8");
    expect(src).toContain("search={(q) => searchJobsForVisit(appointmentId, q)}");
    expect(src).toContain('openLabel={t("vp_btn_alreadyHaveTheJobPickIt")}');
    expect(src).not.toContain("vp_btn_wonPickTheJob");
    const picker = readFileSync("src/app/(app)/appointments/[id]/link-picker.tsx", "utf8");
    expect(picker).toContain("(search ?? searchLinkTargets)(term)");
    expect(picker).toContain("settleLink(linkAppointmentTo(appointmentId, r.kind, r.id)");
  });
});


describe("the Edit Details modal escapes the glass ⋯ panel", () => {
  it("the row-triggered modal is portaled (the cn-v463 class: an in-place overlay inside a backdrop-filter panel clips to a sliver)", () => {
    const src = readFileSync(new URL("../appointment-button.tsx", import.meta.url), "utf8");
    expect(src).toContain("portal={!!rowLabel}");
    expect(src).toContain('formId="appt-form"'); // portal-safe submit: the form is inside the modal
  });
});
