"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import { BUSINESS_COST_BUCKETS, type BusinessCostBucket } from "@/lib/business-cost-buckets";
import { createBill, deleteBill } from "../jobs/actions";

/**
 * ADD BUSINESS COST: the one typed door for a cost that belongs to no job (Erik, 2026-09-24:
 * "keep it simple stupid for non tech people"). Gas off the card statement, the phone bill, an
 * insurance payment. Amount, date, one of six big bucket buttons, and that is a saved cost.
 *
 * It is NOT a second bill form. It saves through createBill, the same server action the Add Bill
 * row below uses, with job_id null and the bucket as the category, so the cost lands in exactly
 * the rows every other business cost does and nothing downstream has to know which door it came
 * through.
 *
 * ALWAYS SAVED AS PAID. This door is for money already spent. A purchase on a supplier's account
 * is still owed, and saving that as paid would take it out of what he owes the supplier, so the
 * sheet says to use Add Bill for that one, where On Account is a choice.
 *
 * WHERE IS OPTIONAL. createBill needs a supplier name, so a blank Where saves the bucket's own
 * name: one fixed placeholder per bucket, never a made-up supplier per month. The Bills page
 * keeps those placeholders out of its supplier-spelling list.
 */
export function AddBusinessCostButton({ today }: { today: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(today);
  // No bucket is picked for him. A preselected one files every cost nobody looked at under it.
  const [bucket, setBucket] = useState<BusinessCostBucket | null>(null);
  const [where, setWhere] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const dirty = amount > 0 || !!bucket || !!where.trim() || !!note.trim();

  function reset() {
    setAmount(0);
    setDate(today);
    setBucket(null);
    setWhere("");
    setNote("");
    setError(null);
  }

  function close() {
    setOpen(false);
    reset();
  }

  function save() {
    setError(null);
    if (!(amount > 0)) return setError("Type the amount.");
    if (!bucket) return setError("Tap the bucket this cost goes in.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError("Pick the date it was paid.");
    const place = where.trim();
    const picked = bucket;
    start(async () => {
      const res = await createBill({
        job_id: null,
        supplier: place || picked,
        bill_number: "",
        amount,
        status: "paid",
        bill_date: date,
        notes: note,
        category: picked,
      });
      if (!res.ok) return setError(res.error ?? "The business cost didn't save. Nothing was recorded.");
      const said = `${place ? `${place} ` : ""}${formatCurrency(amount)} saved as a Business Cost: ${picked}, ${formatDate(date)}.`;
      const id = res.id;
      toast(
        said,
        "success",
        id
          ? {
              label: "Undo",
              onClick: () => {
                void deleteBill(id, "").then((undone) => {
                  toast(undone.ok ? "Business cost removed." : undone.error ?? "Couldn't remove it. Delete it from the Bills tab.", undone.ok ? "success" : "error");
                  router.refresh();
                });
              },
            }
          : undefined,
      );
      close();
      router.refresh();
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus /> Add Business Cost
      </Button>
      <Modal
        open={open}
        onClose={close}
        title="Add Business Cost"
        size="md"
        dirty={dirty}
        footer={<ModalActions onCancel={close} onSave={save} saving={pending} saveLabel="Save Business Cost" />}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            A cost that belongs to no job: gas, the phone, insurance, tools for the shop. It counts as a cost of running
            the business and never lands on a job.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="abc-amount">Amount</Label>
              <NumberInput id="abc-amount" value={amount} onValueChange={setAmount} placeholder="0.00" autoFocus />
            </div>
            <div>
              <Label htmlFor="abc-date">Date</Label>
              <Input id="abc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          <div>
            <Label>What it was for</Label>
            <div role="radiogroup" aria-label="Business cost bucket" className="grid grid-cols-2 gap-2">
              {BUSINESS_COST_BUCKETS.map((b) => (
                <Button
                  key={b}
                  type="button"
                  role="radio"
                  aria-checked={bucket === b}
                  variant={bucket === b ? "primary" : "outline"}
                  onClick={() => setBucket(b)}
                  className="h-12 w-full whitespace-normal px-2 leading-tight"
                >
                  {b}
                </Button>
              ))}
            </div>
            {bucket === "Fees" && (
              <p className="mt-2 text-xs text-slate-500">
                Bank and permit fees, or card fees from anything other than Stripe (Stripe&apos;s fee is recorded on each payment on its own, so don&apos;t add it here). Don&apos;t add a supplier&apos;s late interest here either: it comes in with that
                supplier&apos;s own paperwork on this page.
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="abc-where">Where (optional)</Label>
            <Input id="abc-where" value={where} onChange={(e) => setWhere(e.target.value)} placeholder="e.g. Goodwin's, Verizon" />
          </div>
          <div>
            <Label htmlFor="abc-note">Note (optional)</Label>
            <Textarea id="abc-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. September gas off the card" />
          </div>

          <p className="text-xs text-slate-500">
            Saved as already paid. Bought on a supplier&apos;s account and still owed? Use Add Bill on the Bills tab, so it
            counts in what you owe them.
          </p>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </Modal>
    </>
  );
}
