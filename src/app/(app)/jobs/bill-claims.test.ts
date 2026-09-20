import { describe, expect, it } from "vitest";
import {
  billMoveRefusal,
  billRepricedWarning,
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

describe("planBillEdit — a claimed receipt may be re-priced, but never in silence", () => {
  it("saves and hands back both figures and the invoice", () => {
    const plan = planBillEdit({ storedJobId: CED_456.job, storedAmount: 456.02, nextAmount: 470 }, INV063);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.warning).toContain("INV-063");
    expect(plan.warning).toContain("$456.02");
    expect(plan.warning).toContain("$470.00");
    expect(plan.warning).toContain("The invoice keeps its figure.");
  });

  it("never points at Import Costs — a claimed bill is skipped by that importer, so it would be a dead end", () => {
    const plan = planBillEdit({ storedJobId: CED_467.job, storedAmount: 467.87, nextAmount: 400 }, INV063);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.warning?.toLowerCase()).not.toContain("import");
    expect(plan.warning).toContain("by hand");
  });

  it("says nothing when nothing bills it", () => {
    expect(planBillEdit({ storedJobId: CED_456.job, storedAmount: 456.02, nextAmount: 470 }, null)).toEqual({ ok: true });
  });

  it("says nothing when the edit touched neither guarded field", () => {
    expect(planBillEdit({ storedJobId: CED_456.job, storedAmount: 456.02, nextJobId: CED_456.job, nextAmount: 456.02 }, INV063)).toEqual({
      ok: true,
    });
  });

  it("a one cent correction on a claimed receipt is still said out loud", () => {
    const plan = planBillEdit({ storedJobId: CED_456.job, storedAmount: 456.02, nextAmount: 456.03 }, INV063);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.warning).toContain("$456.03");
  });
});

describe("the sentences", () => {
  it("a draft with no number yet still reads as a sentence", () => {
    expect(claimantLabel(UNNUMBERED)).toBe("An invoice");
    expect(billMoveRefusal(UNNUMBERED).startsWith("An invoice already bills this receipt")).toBe(true);
    expect(billRepricedWarning(UNNUMBERED, 456.02, 470).startsWith("An invoice bills this receipt")).toBe(true);
  });

  it("carry no em dashes — the copy rule for every surface", () => {
    for (const sentence of [billMoveRefusal(INV063), billRepricedWarning(INV063, 456.02, 470)]) {
      expect(sentence).not.toContain("—");
      expect(sentence).not.toContain("–");
    }
  });

  it("name only doors that exist: void, take the lines off, edit by hand", () => {
    expect(billMoveRefusal(INV063)).toBe(
      "INV-063 already bills this receipt on the job it is on now. " +
        "Void that invoice, or take its materials lines off, then move the receipt. Nothing was changed.",
    );
    expect(billRepricedWarning(INV063, 456.02, 470)).toBe(
      "INV-063 bills this receipt at $456.02 and it now reads $470.00. The invoice keeps its figure. " +
        "Open that invoice and edit its materials lines by hand if the customer should pay the difference.",
    );
  });
});
