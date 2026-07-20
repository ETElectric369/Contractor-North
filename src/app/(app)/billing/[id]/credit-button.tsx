"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { ACTIONS_ROW_CLS } from "@/components/section-actions-menu";
import { createCustomerCredit } from "../actions";

/** Post a credit/refund to the customer's account from this invoice.
 *  With `menuItem` the trigger renders as an Actions-menu row (the rare
 *  accounting verb lives behind the ⋯ seek door, not the header). */
export function CreditButton({
  invoiceId,
  defaultAmount,
  menuItem = false,
}: {
  invoiceId: string;
  defaultAmount?: number;
  menuItem?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(defaultAmount && defaultAmount > 0 ? defaultAmount : 0);
  const [disposition, setDisposition] = useState<"credit" | "refund">("credit");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    start(async () => {
      const res = await createCustomerCredit(invoiceId, amount, disposition, note);
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      setNote("");
      router.refresh();
    });
  }

  const opt = (val: "credit" | "refund", title: string, sub: string) => (
    <label className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${disposition === val ? "border-brand bg-brand-light/40" : "border-slate-200"}`}>
      <input type="radio" name="disposition" checked={disposition === val} onChange={() => setDisposition(val)} className="mt-0.5" />
      <span>
        <span className="block font-medium text-slate-900">{title}</span>
        <span className="block text-xs text-slate-500">{sub}</span>
      </span>
    </label>
  );

  return (
    <>
      {menuItem ? (
        <button type="button" onClick={() => setOpen(true)} className={ACTIONS_ROW_CLS}>
          <RotateCcw className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> Credit / Refund
        </button>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <RotateCcw className="h-4 w-4" /> Credit / Refund
        </button>
      )}
      {/* portal: the trigger lives in the invoice's glass ⋯ Actions panel, whose backdrop-filter
          makes it the containing block for this overlay's position:fixed — un-portaled it was
          sized to the 224px dropdown and clipped by its overflow:hidden. No wrapping <form>
          here (the footer saves via onSave), so portaling alone is safe. See Modal's `portal`. */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Credit / refund"
        portal
        footer={
          <ModalActions onCancel={() => setOpen(false)} onSave={save} saving={pending} disabled={!(amount > 0)} saveLabel="Post credit" />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div>
            <Label htmlFor="cr-amt">Amount</Label>
            <NumberInput id="cr-amt" value={amount} onValueChange={setAmount} />
          </div>
          <div className="space-y-2">
            <Label>What should happen?</Label>
            {opt("credit", "Keep as account credit", "Sits on the customer's account toward future work")}
            {opt("refund", "Flag accounting to refund", "Posts the credit and flags it to be paid back")}
          </div>
          <div>
            <Label htmlFor="cr-note">Note (optional)</Label>
            <Textarea id="cr-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
      </Modal>
    </>
  );
}
