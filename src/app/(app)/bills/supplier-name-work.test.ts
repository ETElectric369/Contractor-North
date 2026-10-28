import { describe, it, expect } from "vitest";
import { duplicateTicketGroups, isOpenDuplicateGroup, type NameWorkBill } from "./supplier-name-work";

/**
 * BOTH ARE REAL (0400 bills.both_real_at; cn-v1137). The same ticket filed to two jobs is a question
 * — and "two identical runs a month apart" is one of its answers. A pair whose copies ALL carry the
 * stamp is answered and is not asked again; a half-stamped pair (a third copy scanned since, or one
 * stamp lost) still asks; a pair he answered with Keep It On keeps its row as before.
 */
const copy = (id: string, job: string, over: Partial<NameWorkBill> = {}): NameWorkBill => ({
  id,
  supplier: "Catbird Electric Supply",
  amount: "95.27",
  status: "paid",
  bill_date: "2026-07-29",
  job_id: `job-${job}`,
  jobs: { name: job, job_number: "J-040", customers: { name: "Snowbell" } },
  superseded_by_bill_id: null,
  both_real_at: null,
  notes: "ticket.pdf",
  bill_line_items: Array.from({ length: 8 }, (_, i) => ({ description: `line ${i + 1}` })),
  ...over,
});

describe("duplicateTicketGroups and the both-real stamp", () => {
  it("an unstamped identical pair asks, as before", () => {
    const { groups, ready } = duplicateTicketGroups({ bills: [copy("a", "13 Larkspur"), copy("b", "41 Bayberry")] });
    expect(ready).toBe(true);
    expect(groups).toHaveLength(1);
    expect(groups[0].copies.map((c) => c.billId)).toEqual(["a", "b"]);
    expect(isOpenDuplicateGroup(groups[0])).toBe(true);
  });

  it("a pair whose copies ALL carry both_real_at is skipped: nothing to ask, nothing to count", () => {
    const at = "2026-10-28T15:00:00Z";
    const { groups, ready } = duplicateTicketGroups({
      bills: [copy("a", "13 Larkspur", { both_real_at: at }), copy("b", "41 Bayberry", { both_real_at: at })],
    });
    expect(ready).toBe(true);
    expect(groups).toEqual([]);
  });

  it("a half-stamped pair still asks (a third copy scanned since, or one stamp lost)", () => {
    const at = "2026-10-28T15:00:00Z";
    const half = duplicateTicketGroups({ bills: [copy("a", "13 Larkspur", { both_real_at: at }), copy("b", "41 Bayberry")] });
    expect(half.groups).toHaveLength(1);
    expect(isOpenDuplicateGroup(half.groups[0])).toBe(true);
    // Three copies, two stamped: the pairs that include the unstamped copy ask; the stamped pair does not.
    const three = duplicateTicketGroups({
      bills: [copy("a", "13 Larkspur", { both_real_at: at }), copy("b", "41 Bayberry", { both_real_at: at }), copy("c", "7 Thistlewood")],
    });
    expect(three.groups.map((g) => g.copies.map((c) => c.billId))).toEqual([["a", "c"], ["b", "c"]]);
  });

  it("a pair he answered with Keep It On keeps its row, answered, whatever the stamp says", () => {
    const { groups } = duplicateTicketGroups({
      bills: [copy("a", "13 Larkspur"), copy("b", "41 Bayberry", { superseded_by_bill_id: "a" })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].resolution).toEqual({ keptBillId: "a" });
    expect(isOpenDuplicateGroup(groups[0])).toBe(false);
  });

  it("a read without the stamp column (a database before 0400) asks as it always did", () => {
    const rows = [copy("a", "13 Larkspur"), copy("b", "41 Bayberry")].map(({ both_real_at: _x, ...rest }) => rest);
    const { groups, ready } = duplicateTicketGroups({ bills: rows });
    expect(ready).toBe(true);
    expect(groups).toHaveLength(1);
  });
});
