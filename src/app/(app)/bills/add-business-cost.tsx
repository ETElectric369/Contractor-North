"use client";

import { QuickCostButton } from "@/components/quick-cost-button";

/**
 * ADD BY HAND (W1-32): the Bills page's typed door, a plain text link beside Snap Or Note. It opens
 * THE ONE TYPED COST SHEET (QuickCostButton's Type It In), with the job picker first: a job's cost,
 * a business cost in its bucket (gas off the card statement, the phone bill, an insurance payment),
 * or Shop Stock while that switch is on. Paid? is asked (Already Paid, or On Account and still
 * owed), so a purchase on a supplier's account counts in what is owed them.
 *
 * It replaced two doors that did one job: Add Business Cost (always saved as paid) and the ledger's
 * Add A Bill By Hand fold. Both saved through createBill, and so does this.
 */
export function AddByHandButton({
  jobs,
  shopStock = false,
  jobsUnread = false,
}: {
  /** The jobs a cost can go on (open and finished, never cancelled), labelled as Erik reads them. */
  jobs: { id: string; label: string }[];
  /** The Shop Stock switch (0352): on, What's It For? offers Shop Stock. */
  shopStock?: boolean;
  /** The page's jobs read failed: the sheet says it couldn't load them, never "no jobs yet". */
  jobsUnread?: boolean;
}) {
  return (
    <QuickCostButton
      typeOnly
      jobs={jobs}
      shopStock={shopStock}
      jobsUnread={jobsUnread}
      label="Add By Hand"
      icon="none"
      className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-brand hover:underline"
    />
  );
}
