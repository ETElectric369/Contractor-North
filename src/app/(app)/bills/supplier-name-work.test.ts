import { describe, it, expect } from "vitest";
import { duplicateTicketGroups, isOpenDuplicateGroup, type NameWorkBill } from "./supplier-name-work";

/**
 * BOTH ARE REAL (0400 bills.both_real_at; cn-v1137). The same ticket filed to two jobs is a question
 * — and "two identical runs a month apart" is one of its answers. A pair whose copies ALL carry the
 * stamp is answered and is not asked again; a half-stamped pair (a third copy scanned since, or one
 * stamp lost) still asks; a pair he answered with Keep It on keeps its row as before.
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

  it("a pair he answered with Keep It on keeps its row, answered, whatever the stamp says", () => {
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

/**
 * DISMISSED (0419 bills.duplicate_dismissed_at; cn-v1186). "im not going to change my mind, dismiss
 * please": an ANSWERED pair whose set-aside copies ALL carry the stamp leaves the page. An open pair
 * never reads the stamp, a read without the column hides nothing, and `showDismissedWith` (All Bills'
 * Change link, through Reconcile's `pick`) draws one dismissed pair again, and only that one.
 */
describe("duplicateTicketGroups and the dismissed stamp", () => {
  const at = "2026-11-22T21:00:00Z";
  const ticket = (id: string, job: string, over: Partial<NameWorkBill> = {}): NameWorkBill =>
    copy(id, job, { supplier: "Northline Supply", jobs: { name: job, job_number: "J-901", customers: { name: "Sam Tillery" } }, ...over });

  it("answered and stamped: the pair is out", () => {
    const { groups, ready } = duplicateTicketGroups({
      bills: [ticket("a", "Larkspur"), ticket("b", "Snowbell", { superseded_by_bill_id: "a", duplicate_dismissed_at: at })],
    });
    expect(ready).toBe(true);
    expect(groups).toEqual([]);
  });

  it("answered, not stamped: the pair stays, answered", () => {
    const { groups } = duplicateTicketGroups({ bills: [ticket("a", "Larkspur"), ticket("b", "Snowbell", { superseded_by_bill_id: "a" })] });
    expect(groups).toHaveLength(1);
    expect(groups[0].resolution).toEqual({ keptBillId: "a" });
  });

  it("a stamp on the KEPT copy alone does not dismiss: the stamp counts on the copies set aside", () => {
    const { groups } = duplicateTicketGroups({
      bills: [ticket("a", "Larkspur", { duplicate_dismissed_at: at }), ticket("b", "Snowbell", { superseded_by_bill_id: "a" })],
    });
    expect(groups).toHaveLength(1);
  });

  it("open with a stale stamp: the question is still asked", () => {
    const { groups } = duplicateTicketGroups({
      bills: [ticket("a", "Larkspur", { duplicate_dismissed_at: at }), ticket("b", "Snowbell", { duplicate_dismissed_at: at })],
    });
    expect(groups).toHaveLength(1);
    expect(isOpenDuplicateGroup(groups[0])).toBe(true);
  });

  it("three copies, one set-aside copy unstamped: the pair holding it stays", () => {
    const { groups } = duplicateTicketGroups({
      bills: [
        ticket("a", "Larkspur"),
        ticket("b", "Snowbell", { superseded_by_bill_id: "a", duplicate_dismissed_at: at }),
        ticket("c", "J-903", { superseded_by_bill_id: "a" }),
      ],
    });
    const ids = groups.map((g) => g.copies.map((c) => c.billId));
    expect(ids).not.toContainEqual(["a", "b"]);
    expect(ids).toContainEqual(["a", "c"]);
    expect(groups.find((g) => g.copies.map((c) => c.billId).join() === "a,c")?.resolution).toEqual({ keptBillId: "a" });
  });

  it("showDismissedWith brings a dismissed pair back, and only that pair", () => {
    const bills = [
      ticket("a", "Larkspur"),
      ticket("b", "Snowbell", { superseded_by_bill_id: "a", duplicate_dismissed_at: at }),
      ticket("x", "Larkspur", { amount: "12.40", bill_line_items: [{ description: "one" }] }),
      ticket("y", "Snowbell", { amount: "12.40", bill_line_items: [{ description: "one" }], superseded_by_bill_id: "x", duplicate_dismissed_at: at }),
    ];
    expect(duplicateTicketGroups({ bills }).groups).toEqual([]);
    const back = duplicateTicketGroups({ bills, showDismissedWith: "b" }).groups;
    expect(back.map((g) => g.copies.map((c) => c.billId))).toEqual([["a", "b"]]);
    expect(back[0].resolution).toEqual({ keptBillId: "a" });
    // The kept copy's id brings it back as well; an id in no pair brings back nothing.
    expect(duplicateTicketGroups({ bills, showDismissedWith: "x" }).groups.map((g) => g.id)).toEqual([`dup:${JSON.stringify(["x", "y"])}`]);
    expect(duplicateTicketGroups({ bills, showDismissedWith: "zzz" }).groups).toEqual([]);
  });

  it("an OPEN pair is never left out by the stamp, even when both its copies were set aside elsewhere and stamped", () => {
    // Three copies, one kept: the two set-aside copies pair with each other, and that pair is open
    // (neither points at the other). Their stamps must not hide it.
    const { groups } = duplicateTicketGroups({
      bills: [
        ticket("a", "Larkspur"),
        ticket("b", "Snowbell", { superseded_by_bill_id: "a", duplicate_dismissed_at: at }),
        ticket("c", "J-903", { superseded_by_bill_id: "a", duplicate_dismissed_at: at }),
      ],
    });
    expect(groups.map((g) => g.copies.map((c) => c.billId))).toEqual([["b", "c"]]);
    expect(isOpenDuplicateGroup(groups[0])).toBe(true);
  });

  it("EVERY set-aside copy must carry the stamp: one set-aside copy of two unstamped keeps the pair", () => {
    const { groups } = duplicateTicketGroups({
      bills: [
        ticket("a", "Larkspur", { superseded_by_bill_id: "b" }),
        ticket("b", "Snowbell", { superseded_by_bill_id: "a", duplicate_dismissed_at: at }),
      ],
    });
    expect(groups).toHaveLength(1);
  });

  it("a read without the column (a database before 0419) hides no pair", () => {
    const rows = [ticket("a", "Larkspur"), ticket("b", "Snowbell", { superseded_by_bill_id: "a" })].map(({ duplicate_dismissed_at: _x, ...rest }) => rest);
    expect(duplicateTicketGroups({ bills: rows }).groups).toHaveLength(1);
  });
});
