import { describe, it, expect } from "vitest";
import { claimedMoveRefusal, entryClaimCarry, planAllocationEdit, type ClaimIndex, type StoredAllocation } from "./allocation-claims";

/**
 * THE CLAIM SURVIVES THE EDIT (0255). The reference case is 85 Whitney the morning after INV-061
 * went out paid: Brian's shift is split 6 h on the job (row A, claimed by INV-061) and 2 h Drive
 * (row B, not billable). The office fixes a description, shortens the drive, or splits the day
 * differently — and the customer must never be billed those 6 hours a second time.
 */
const A: StoredAllocation = { id: "a", job_id: "whitney", job_code: null, hours: 6, description: "rough-in", sort_order: 0 };
const B: StoredAllocation = { id: "b", job_id: null, job_code: "DRIVE", hours: 2, description: "drive", sort_order: 1 };
const INV61 = { id: "i61", invoice_number: "INV-061" };
const claimsOn = (...ids: string[]): ClaimIndex => new Map(ids.map((id) => [id, INV61] as const));
const none: ClaimIndex = new Map();

describe("planAllocationEdit — matching", () => {
  it("a submitted row that carries an id is that row, edited in place", () => {
    const plan = planAllocationEdit([A, B], [{ id: "b", job_id: null, job_code: "DRIVE", hours: 1.5, description: "drive" }, { id: "a", job_id: "whitney", job_code: null, hours: 6.5, description: "rough-in + trim" }], none);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.insert).toEqual([]);
    expect(plan.remove).toEqual([]);
    // sort_order follows the office's order on screen, ids follow the rows.
    expect(plan.update.map((u) => [u.id, u.row.sort_order, u.row.hours])).toEqual([["b", 0, 1.5], ["a", 1, 6.5]]);
  });

  it("an id-less row lands on the stored row of the same job, in order (what the timecard editor sends)", () => {
    const plan = planAllocationEdit([A, B], [{ job_id: "whitney", job_code: null, hours: 6, description: "rough-in (panel side)" }, { job_id: null, job_code: "DRIVE", hours: 2, description: "drive" }], claimsOn("a"));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.update.map((u) => u.id)).toEqual(["a", "b"]);
    expect(plan.update[0].row.description).toBe("rough-in (panel side)");
    expect(plan.insert).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("extra rows on a job insert; missing unclaimed rows remove", () => {
    const plan = planAllocationEdit(
      [A, B],
      [
        { job_id: "whitney", job_code: null, hours: 4, description: "rough-in" },
        { job_id: "whitney", job_code: null, hours: 2, description: "trim" },
      ],
      claimsOn("a"),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.update.map((u) => [u.id, u.row.hours])).toEqual([["a", 4]]);
    expect(plan.insert.map((r) => [r.job_id, r.hours, r.sort_order])).toEqual([["whitney", 2, 1]]);
    expect(plan.remove).toEqual(["b"]); // the drive row is unclaimed, so it can go
  });

  it("a cleared split removes every unclaimed row", () => {
    const plan = planAllocationEdit([B], [], none);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.remove).toEqual(["b"]);
    expect(plan.update).toEqual([]);
  });

  it("stored rows with no sort_order still pair deterministically", () => {
    const plan = planAllocationEdit(
      [{ ...A, id: "z", sort_order: null }, { ...A, id: "y", sort_order: null }],
      [{ job_id: "whitney", job_code: null, hours: 1, description: null }, { job_id: "whitney", job_code: null, hours: 2, description: null }],
      none,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.update.map((u) => u.id)).toEqual(["y", "z"]);
  });
});

describe("planAllocationEdit — the auto clock-out debrief (completeAutoClockOut)", () => {
  // The debrief re-submits every stored row AS ITSELF (its id, its job, its hours trimmed to the
  // post-lunch ceiling) and appends the tech's code breakdown without ids. The stored rows must
  // pair by id and edit in place — so INV-061's claim on row A survives the trim — the new rows
  // must insert after them, and nothing may be removed: the old insert-alongside, with ids that
  // hold still. (Before 0255 this door replaced the split through the 0244 RPC, minting new ids.)
  it("pairs stored rows by id (trimmed in place), appends the new rows after them, removes nothing", () => {
    const plan = planAllocationEdit(
      [A, B],
      [
        { id: "a", job_id: "whitney", job_code: null, hours: 5.5, description: "rough-in" },
        { id: "b", job_id: null, job_code: "DRIVE", hours: 1.5, description: "drive" },
        { job_id: "whitney", job_code: null, hours: 1, description: "trim" },
      ],
      claimsOn("a"),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.update.map((u) => [u.id, u.row.hours, u.row.sort_order])).toEqual([["a", 5.5, 0], ["b", 1.5, 1]]);
    expect(plan.insert.map((r) => [r.job_id, r.hours, r.sort_order])).toEqual([["whitney", 1, 2]]);
    expect(plan.remove).toEqual([]);
  });

  it("a new id-less row on the same job never takes a stored row that names itself — it inserts", () => {
    // Unlike the timecard editor (which sends no ids), the debrief carries every stored id, so an
    // appended "whitney" row can't be mistaken for a re-submission of row A.
    const plan = planAllocationEdit(
      [A],
      [
        { id: "a", job_id: "whitney", job_code: null, hours: 6, description: "rough-in" },
        { job_id: "whitney", job_code: null, hours: 2, description: null },
      ],
      claimsOn("a"),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.update.map((u) => u.id)).toEqual(["a"]);
    expect(plan.insert.length).toBe(1);
  });

  it("the debrief's first split of a claimed un-split shift carries the claim; a row headed elsewhere is refused", () => {
    const base = { entryId: "e1", entryJobId: "whitney", stored: [] as StoredAllocation[], claims: claimsOn("e1") };
    expect(entryClaimCarry({ ...base, next: [{ job_id: "whitney", job_code: null, hours: 6, description: null }, { job_id: null, job_code: "DRIVE", hours: 1, description: null }] })).toEqual({ ok: true, carry: true });
    const refused = entryClaimCarry({ ...base, next: [{ job_id: "other-job", job_code: null, hours: 1, description: null }] });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatch(/INV-061/);
    expect(refused.error).toMatch(/Nothing was changed/);
  });
});

describe("planAllocationEdit — the claim refusals", () => {
  it("refuses to remove a row an invoice bills, naming the invoice", () => {
    const plan = planAllocationEdit([A, B], [{ job_id: null, job_code: "DRIVE", hours: 8, description: "drive" }], claimsOn("a"));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/INV-061/);
    expect(plan.error).toMatch(/6\.00 h/);
    expect(plan.error).toMatch(/void or adjust/i);
  });

  it("refuses to move a claimed row to another job (by id)", () => {
    const plan = planAllocationEdit([A], [{ id: "a", job_id: "other-job", job_code: null, hours: 6, description: null }], claimsOn("a"));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/INV-061/);
    expect(plan.error).toMatch(/another job/);
  });

  it("an id-less row on a different job never steals a claimed row — the claimed row is 'removed', and that is refused", () => {
    const plan = planAllocationEdit([A], [{ job_id: "other-job", job_code: null, hours: 6, description: null }], claimsOn("a"));
    expect(plan.ok).toBe(false);
  });

  it("an unclaimed invoice-less shift edits exactly as before", () => {
    const plan = planAllocationEdit([A], [{ job_id: "other-job", job_code: null, hours: 6, description: null }], none);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.insert.length).toBe(1);
    expect(plan.remove).toEqual(["a"]);
  });

  it("names the invoice even when it has no number yet", () => {
    const plan = planAllocationEdit([A], [], new Map([["a", { id: "x", invoice_number: null }]]));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/^an invoice already bills/);
  });
});

describe("entryClaimCarry — an un-split shift billed by its entry id", () => {
  const entry = { entryId: "e1", entryJobId: "whitney" };

  it("carries the claim onto the first split when every row stays on the job (or is a time code)", () => {
    const d = entryClaimCarry({ ...entry, stored: [], next: [{ job_id: "whitney", job_code: null, hours: 6, description: null }, { job_id: null, job_code: "DRIVE", hours: 2, description: null }], claims: claimsOn("e1") });
    expect(d).toEqual({ ok: true, carry: true });
  });

  it("refuses a first split that sends part of the billed shift to another job", () => {
    const d = entryClaimCarry({ ...entry, stored: [], next: [{ job_id: "other-job", job_code: null, hours: 2, description: null }], claims: claimsOn("e1") });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.error).toMatch(/INV-061/);
  });

  it("does nothing when the entry is not claimed, already split, or the split is being cleared", () => {
    expect(entryClaimCarry({ ...entry, stored: [], next: [{ job_id: "whitney", job_code: null, hours: 6, description: null }], claims: none })).toEqual({ ok: true, carry: false });
    expect(entryClaimCarry({ ...entry, stored: [A], next: [{ job_id: "whitney", job_code: null, hours: 6, description: null }], claims: claimsOn("e1") })).toEqual({ ok: true, carry: false });
    expect(entryClaimCarry({ ...entry, stored: [], next: [], claims: claimsOn("e1") })).toEqual({ ok: true, carry: false });
  });
});

describe("claimedMoveRefusal", () => {
  it("names the invoice and the way out", () => {
    expect(claimedMoveRefusal(INV61)).toMatch(/INV-061 already bills this shift — void or adjust/);
  });
});
