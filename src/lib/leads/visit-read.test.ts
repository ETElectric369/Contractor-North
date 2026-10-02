import { describe, it, expect } from "vitest";
import { readLeadVisits, VISIT_IDS_PER_REQUEST, type VisitRow } from "./visit-read";
import { leadNextStep, VISITS_UNREAD, type LeadStepInput } from "./next-step";

/**
 * THE LEADS CHIP STOPS TELLING YOU TO COLD-CALL SOMEBODY YOU ARE SEEING TUESDAY.
 *
 * WHAT WAS WRONG. The board read every open lead's appointments in ONE request — `.in(inquiry_id,
 * <every open lead's uuid>)`, 500 rows — and threw the error away: `const { data: visitRows } = await
 * …`. A read that FAILED and a lead with NO visits came out of that identical (an empty Map), so the
 * one next-step chip fell through to its last rule and printed "New · Call Them" on a lead with a
 * walk-through booked for Tuesday. The two ways it fails are both ordinary: past ~200 open leads the
 * uuid list makes the request too long for the gateway, and a busy book overflows 500 rows.
 *
 * SO: the request is bounded by the number of ids in it, never by hiding leads (the lead read keeps
 * no cap — "build for millions", and a cap there would make the Open Leads badge lie); the error is
 * KEPT; a batch that came back capped counts as not read, because nobody can tell a short answer
 * from a complete one; and a lead whose visits are not known says so on its own row instead of
 * printing an instruction that may be wrong.
 */

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `lead-${String(i + from).padStart(4, "0")}`);
const booked = (id: string, at: string): VisitRow => ({ inquiry_id: id, status: "scheduled", starts_at: at, type: "inspection" });

describe("the visits behind the chip: read, or honestly unknown", () => {
  it("a read that FAILS is not an empty book — every lead in that batch says its visits are unknown", async () => {
    const read = await readLeadVisits(ids(3), async () => ({ data: null, error: { message: "canceling statement due to statement timeout" } }));
    for (const id of ids(3)) expect(read.forLead(id)).toBe(VISITS_UNREAD);
  });

  it("a batch that comes back CAPPED is not read either: nobody can tell a short answer from a whole one", async () => {
    // One batch of leads with a busy book between them: the request comes back at exactly its cap.
    const read = await readLeadVisits(ids(VISIT_IDS_PER_REQUEST), async (chunk, cap) => ({
      data: Array.from({ length: cap }, (_, i) => booked(chunk[i % chunk.length], "2026-10-06T17:00:00Z")),
      error: null,
    }));
    // Every id asked for in the capped batch is unknown — including the ones whose rows did arrive,
    // because a capped answer says nothing about what was left out.
    expect(read.forLead("lead-0000")).toBe(VISITS_UNREAD);
    expect(read.unreadCount).toBe(VISIT_IDS_PER_REQUEST);
  });

  it("a read that LANDS answers each lead: what is booked, what is done, and nothing for a lead with neither", async () => {
    const rows: VisitRow[] = [
      booked("lead-0000", "2026-10-06T17:00:00Z"),
      booked("lead-0000", "2026-10-02T17:00:00Z"),
      { inquiry_id: "lead-0001", status: "completed", starts_at: "2026-09-20T17:00:00Z", type: "inspection" },
    ];
    const read = await readLeadVisits(ids(3), async (chunk) => ({ data: rows.filter((r) => chunk.includes(r.inquiry_id!)), error: null }));
    // The EARLIEST booked start wins, as the chip's "Walk-Through · Fri Oct 2" needs.
    expect(read.forLead("lead-0000")).toEqual({ done: 0, upcoming: 2, nextAt: "2026-10-02T17:00:00Z", nextType: "inspection" });
    expect(read.forLead("lead-0001")).toEqual({ done: 1, upcoming: 0, nextAt: null, nextType: null });
    expect(read.forLead("lead-0002")).toBeNull();
  });

  it("a busy board never builds one enormous request: the ids go in batches the gateway can carry", async () => {
    const asked: number[] = [];
    await readLeadVisits(ids(260), async (chunk) => (asked.push(chunk.length), { data: [], error: null }));
    expect(asked.length).toBeGreaterThan(1);
    for (const n of asked) expect(n).toBeLessThanOrEqual(VISIT_IDS_PER_REQUEST);
    expect(asked.reduce((a, b) => a + b, 0)).toBe(260);
  });

  it("one batch failing never makes the others unknown: only the leads nobody could read say so", async () => {
    const all = ids(VISIT_IDS_PER_REQUEST + 2);
    const read = await readLeadVisits(all, async (chunk) =>
      chunk.includes(all[0]) ? { data: null, error: { message: "boom" } } : { data: [booked(chunk[0], "2026-10-06T17:00:00Z")], error: null },
    );
    expect(read.forLead(all[0])).toBe(VISITS_UNREAD);
    expect(read.forLead(all[VISIT_IDS_PER_REQUEST])).toEqual({ done: 0, upcoming: 1, nextAt: "2026-10-06T17:00:00Z", nextType: "inspection" });
  });
});

const lead = (over: Partial<LeadStepInput> = {}): LeadStepInput => ({
  status: "new",
  converted_at: null,
  converted_to: null,
  next_follow_up_at: null,
  lead_bucket: null,
  site_inspection_required: false,
  source: "manual",
  referred_by: null,
  ...over,
});
const chip = (over: Partial<LeadStepInput>, visits: Parameters<typeof leadNextStep>[1]) =>
  leadNextStep(lead(over), visits, "2026-10-01", { estimatesOn: true, tz: "America/Los_Angeles" });

describe("the chip when the visits are not known", () => {
  it("THE DEFECT: it never says Call Them about a lead whose visits it could not read", () => {
    const step = chip({}, VISITS_UNREAD);
    expect(step.label).not.toContain("Call Them");
    expect(step.label).not.toContain("New");
    expect(step.label).toBe("Visits Didn't Load");
    expect(step.tone).toBe("amber");
  });

  it("and it never claims a visit is still needed, which is the same guess the other way", () => {
    expect(chip({ site_inspection_required: true }, VISITS_UNREAD).label).not.toContain("Needs A Visit");
  });

  it("a lead's bucket still leads the chip: the letter is the lead's own fact, not the visit read's", () => {
    expect(chip({ lead_bucket: "A" }, VISITS_UNREAD).label).toBe("A · Visits Didn't Load");
  });

  it("what the visits could not change still gets said: a lead that became something, said no, or is overdue", () => {
    expect(chip({ converted_at: "2026-09-30T00:00:00Z", converted_to: "job" }, VISITS_UNREAD).label).toBe("Became A Job");
    expect(chip({ status: "lost" }, VISITS_UNREAD).label).toBe("Lost");
    expect(chip({ next_follow_up_at: "2026-09-20" }, VISITS_UNREAD).label).toBe("Call Back · Sep 20");
  });

  it("a lead the board DID read is unchanged: no visits still means New · Call Them", () => {
    expect(chip({}, null).label).toBe("New · Call Them");
    expect(chip({}, { done: 0, upcoming: 1, nextAt: "2026-10-06T17:00:00Z", nextType: "inspection" }).label).toBe("Walk-Through · Tue Oct 6");
  });
});
