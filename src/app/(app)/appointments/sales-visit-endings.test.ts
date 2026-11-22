import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ONE WORD FOR AN ENDING, ONE BOX (cn-v1175, R8), on the visit's own page. The owner: "i thought we got
 * rid of the Didn't Happen terminology and now could we safely say that it could go in the Not Sold box
 * to simplify everything". A SALES visit (an inspection, an estimate visit) still booked offers Not Sold
 * in its ⋯, never Dismiss; a WORK visit (a job day, a service call, the city's) keeps Dismiss. A win with
 * no job picked hands the office the job picker at once. Not Sold before its day takes the visit off
 * the schedule, the record kept.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../appointments/actions", () => ({}));

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
const page = read("src/app/(app)/appointments/[id]/page.tsx");
const header = read("src/app/(app)/appointments/[id]/visit-header-actions.tsx");
const actions = read("src/app/(app)/appointments/actions.ts");

describe("the visit page's endings", () => {
  it("a work visit keeps Dismiss; a sales visit is offered Not Sold in its place, and never both", () => {
    expect(page).toContain("{booked && !isSalesVisit(a.type) && <WontHappenRow id={a.id} deletes={wontHappenDeletes} afterHref={home.href} />}");
    expect(page).toContain("{booked && isSalesVisit(a.type) && !a.outcome && <NotSoldRow id={a.id} />}");
    expect(page.match(/<WontHappenRow /g)).toHaveLength(1);
  });

  it("Not Sold is the visit's own answer (setAppointmentOutcome lost), asked by no browser dialog, with an Undo that puts it back", () => {
    const row = header.slice(header.indexOf("export function NotSoldRow"), header.indexOf("export function WontHappenRow"));
    // The person's tap asks for the off-schedule step (it carries the Undo); the assistant's route never does.
    expect(row).toContain('await setAppointmentOutcome(id, "lost", { offSchedule: true })');
    expect(row).toContain("await setAppointmentOutcome(id, null)");
    expect(row).toContain("wontHappenUndo(off.previousStatus, lang, t).status");
    expect(row).not.toMatch(/\bconfirm\(/);
    expect(row).toContain('t("vp_btn_lost")');
  });

  it("Not Sold before its day takes it off the schedule by the status door, and says what it was", () => {
    const fn = actions.slice(actions.indexOf("export async function setAppointmentOutcome"), actions.indexOf("export async function setAppointmentStatus"));
    expect(fn).toContain('.select("id, inquiry_id, status, starts_at")');
    expect(fn).toMatch(/const ahead = !row\.starts_at \|\| \(Number\.isFinite\(at\) && at > Date\.now\(\)\);/);
    expect(fn).toContain('(row.status === "scheduled" || row.status === "proposed") && ahead');
    expect(fn).toContain('await setAppointmentStatus(id, "cancelled")');
    // Only Not Sold (or the old no_bid) does it: a win or a cleared answer never moves the calendar.
    // And only when the caller asked (skeptic #78): the two person-tapped doors, never the assistant.
    expect(fn).toContain('if (opts?.offSchedule === true && (outcome === "lost" || outcome === "no_bid")) {\n    const at');
    expect(fn).toContain("opts?: { offSchedule?: boolean },");
  });
});

describe("a win with no job picked asks for its job at once (R8)", () => {
  it("jobAsked: the office, a visit with a win to record, Won, no job", async () => {
    const { jobAsked } = await import("./[id]/visit-ending");
    expect(jobAsked({ isStaff: true, decidable: true, outcome: "won", hasJob: false })).toBe(true);
    expect(jobAsked({ isStaff: true, decidable: true, outcome: "won", hasJob: true })).toBe(false);
    expect(jobAsked({ isStaff: false, decidable: true, outcome: "won", hasJob: false })).toBe(false);
    expect(jobAsked({ isStaff: true, decidable: false, outcome: "won", hasJob: false })).toBe(false);
    expect(jobAsked({ isStaff: true, decidable: true, outcome: "lost", hasJob: false })).toBe(false);
  });
});
