import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  billMoveRefusal,
  billRepricedRefusal,
  claimantLabel,
  guardedFieldsMoved,
  planBillEdit,
  type BillClaimHolder,
} from "@/app/(app)/jobs/bill-claims";

/**
 * FIXTURES ARE HIS, not invented. Read out of the live book on 2026-09-20, the day the audit
 * confirmed this hole:
 *
 *   c3dc59ce  Consolidated Electrical Distributors  $456.02  job 825a32b1  <- 8 lines of INV-063 (paid)
 *   c0535cdb  Contractors Electrical Distributors   $467.87  job 3d1bb8cc  <- 8 lines of INV-069 (partial)
 *   387341c7  Consolidated Electrical Dist.         $477.40  job 8760a051  <- 9 lines of INV-068 (DRAFT)
 *
 * Both of the first two were editable through the bills list that morning: open it, correct the
 * job, save, and the claim stayed behind on the old customer's invoice.
 */
const CED_456 = { id: "c3dc59ce-214c-4b9b-8a10-5efa5c451110", job: "825a32b1-c356-4608-9d15-9f318ba08c7d", amount: 456.02 };
const CED_467 = { id: "c0535cdb-e485-4679-8e56-fd0918fd728b", job: "3d1bb8cc-ac74-4a57-9eef-6739d0a1a0c3", amount: 467.87 };
const INV063: BillClaimHolder = { invoice_number: "INV-063" };
const INV068_DRAFT: BillClaimHolder = { invoice_number: "INV-068" };
const UNNUMBERED: BillClaimHolder = { invoice_number: null };

describe("guardedFieldsMoved — what actually has to be read before a write", () => {
  it("a job that did not change is not a move, even though the patch names it", () => {
    // The bills list sends job_id on EVERY save. If "present in the patch" counted as a move,
    // fixing a supplier's spelling on a claimed receipt would be refused.
    expect(
      guardedFieldsMoved({ storedJobId: CED_456.job, storedAmount: CED_456.amount, nextJobId: CED_456.job, nextAmount: CED_456.amount }),
    ).toEqual({ movingJob: false, repricing: false });
  });

  it("job → another job, job → overhead and overhead → job are all moves", () => {
    expect(guardedFieldsMoved({ storedJobId: CED_456.job, storedAmount: 0, nextJobId: CED_467.job }).movingJob).toBe(true);
    expect(guardedFieldsMoved({ storedJobId: CED_456.job, storedAmount: 0, nextJobId: null }).movingJob).toBe(true);
    expect(guardedFieldsMoved({ storedJobId: null, storedAmount: 0, nextJobId: CED_456.job }).movingJob).toBe(true);
  });

  it("an untouched field is never a move — the job tab's modal never sends job_id at all", () => {
    expect(guardedFieldsMoved({ storedJobId: CED_456.job, storedAmount: CED_456.amount, nextAmount: CED_456.amount })).toEqual({
      movingJob: false,
      repricing: false,
    });
  });

  it("one cent is a re-price, and float noise does not eat it", () => {
    // 456.03 - 456.02 is not 0.01 in binary floating point; an `>= 0.01` test can drop this.
    expect(guardedFieldsMoved({ storedJobId: null, storedAmount: 456.02, nextAmount: 456.03 }).repricing).toBe(true);
    expect(guardedFieldsMoved({ storedJobId: null, storedAmount: 467.87, nextAmount: 467.88 }).repricing).toBe(true);
    expect(guardedFieldsMoved({ storedJobId: null, storedAmount: 0.1 + 0.2, nextAmount: 0.3 }).repricing).toBe(false);
  });

  it("a numeric column that arrives as a string still compares as money", () => {
    expect(guardedFieldsMoved({ storedJobId: null, storedAmount: Number("456.02"), nextAmount: 456.02 }).repricing).toBe(false);
  });
});

describe("planBillEdit — a claimed receipt may not change jobs", () => {
  it("refuses the move, names the invoice, and says nothing was changed", () => {
    const plan = planBillEdit(
      { storedJobId: CED_456.job, storedAmount: CED_456.amount, nextJobId: CED_467.job, nextAmount: CED_456.amount },
      INV063,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toContain("INV-063");
    expect(plan.error).toContain("Nothing was changed.");
    // The way out is 0278's, word for word, so the two doors agree.
    expect(plan.error).toContain("Void that invoice, or take its materials lines off");
  });

  it("refuses a DRAFT claimant too — the claim is by id and a draft still holds it", () => {
    const plan = planBillEdit({ storedJobId: "8760a051", storedAmount: 477.4, nextJobId: null }, INV068_DRAFT);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain("INV-068");
  });

  it("refuses the move FIRST when a save both moves and re-prices — nothing is written, so there is nothing to warn about", () => {
    const plan = planBillEdit(
      { storedJobId: CED_456.job, storedAmount: CED_456.amount, nextJobId: CED_467.job, nextAmount: 500 },
      INV063,
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain("already bills this receipt");
  });

  it("lets an UNCLAIMED receipt move, silently, because that is just a correction", () => {
    expect(planBillEdit({ storedJobId: CED_456.job, storedAmount: CED_456.amount, nextJobId: CED_467.job }, null)).toEqual({ ok: true });
  });
});

/**
 * A CLAIMED RECEIPT KEEPS ITS FIGURE (Erik, 2026-10-07, the correction door's question 4).
 *
 * The re-price used to save with a warning, and the difference reached no invoice ever: the importer
 * skips a claimed id forever. On 10-04 a claimed CED bill on a finished job was edited in place and
 * the paid invoice that bills it never heard. Now the edit is refused and sent to Correct This Bill,
 * whose correction is its own bill with its own claimable id. The database refuses it too (0381's
 * guard_claimed_bill_amount), in these words.
 */
describe("planBillEdit — a claimed receipt may not be re-priced", () => {
  it("refuses, names the invoice and the figure it bills, and names the door that moves the difference", () => {
    const plan = planBillEdit({ storedJobId: CED_456.job, storedAmount: 456.02, nextAmount: 470 }, INV063);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toContain("INV-063");
    expect(plan.error).toContain("$456.02");
    expect(plan.error).toContain("Correct This Bill");
    expect(plan.error).toContain("Nothing was changed.");
    // The new figure is not the invoice's and not written: it is not in the sentence.
    expect(plan.error).not.toContain("$470.00");
  });

  it("never points at Import Costs or a hand edit: a claimed bill is skipped by that importer, and a hand edit is how the figure got lost", () => {
    const plan = planBillEdit({ storedJobId: CED_467.job, storedAmount: 467.87, nextAmount: 400 }, INV063);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.toLowerCase()).not.toContain("import");
    expect(plan.error).not.toContain("by hand");
  });

  it("refuses a DRAFT claimant too: the claim is by id, and the trigger asks the same question", () => {
    const plan = planBillEdit({ storedJobId: "8760a051", storedAmount: 477.4, nextAmount: 480 }, INV068_DRAFT);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain("INV-068 already bills this receipt at $477.40");
  });

  it("a one cent change on a claimed receipt is still a re-price, and still refused", () => {
    const plan = planBillEdit({ storedJobId: CED_456.job, storedAmount: 456.02, nextAmount: 456.03 }, INV063);
    expect(plan.ok).toBe(false);
  });

  it("lets an UNCLAIMED receipt be re-priced, silently", () => {
    expect(planBillEdit({ storedJobId: CED_456.job, storedAmount: 456.02, nextAmount: 470 }, null)).toEqual({ ok: true });
  });

  it("says nothing when the edit touched neither guarded field", () => {
    expect(planBillEdit({ storedJobId: CED_456.job, storedAmount: 456.02, nextJobId: CED_456.job, nextAmount: 456.02 }, INV063)).toEqual({
      ok: true,
    });
  });
});

describe("the sentences", () => {
  it("a draft with no number yet still reads as a sentence", () => {
    expect(claimantLabel(UNNUMBERED)).toBe("An invoice");
    expect(billMoveRefusal(UNNUMBERED).startsWith("An invoice already bills this receipt")).toBe(true);
    expect(billRepricedRefusal(UNNUMBERED, 456.02).startsWith("An invoice already bills this receipt at $456.02.")).toBe(true);
  });

  it("carry no em dashes — the copy rule for every surface", () => {
    for (const sentence of [billMoveRefusal(INV063), billRepricedRefusal(INV063, 456.02)]) {
      expect(sentence).not.toContain("—");
      expect(sentence).not.toContain("–");
    }
  });

  it("name only doors that exist: void, take the lines off, Correct This Bill", () => {
    expect(billMoveRefusal(INV063)).toBe(
      "INV-063 already bills this receipt on the job it is on now. " +
        "Void that invoice, or take its materials lines off, then move the receipt. Nothing was changed.",
    );
    expect(billRepricedRefusal(INV063, 456.02)).toBe(
      "INV-063 already bills this receipt at $456.02. Its figure stays. " +
        "Put the difference on a correction (Correct This Bill) and the next invoice carries it. Nothing was changed.",
    );
  });

  /**
   * ONE SENTENCE, TWO PLACES. 0381's guard_claimed_bill_amount raises this refusal when an update
   * reaches the database (Nort, or any door that skipped planBillEdit). If the two drifted, Erik would
   * be taught two different ways out of the same wall. Read off the migration itself, with the
   * trigger's two placeholders filled the way Postgres fills them (the holder; to_char of the figure).
   */
  it("is the database's own refusal, word for word (0381 guard_claimed_bill_amount)", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0381_a_bill_may_correct_an_earlier_bill.sql"), "utf8");
    const raised = sql.match(/raise exception '(% already bills this receipt at \$%\.[^']*)'/);
    expect(raised, "0381 no longer raises the re-price refusal this door repeats").not.toBeNull();
    const filled = raised![1].replace("%", "INV-063").replace("%", "456.02");
    expect(billRepricedRefusal(INV063, 456.02)).toBe(filled);
  });
});
