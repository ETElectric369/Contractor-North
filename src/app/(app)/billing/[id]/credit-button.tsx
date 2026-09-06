"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { ACTIONS_ROW_CLS } from "@/components/section-actions-menu";
import { formatCurrency } from "@/lib/utils";
import { applyCustomerCredit, createCustomerCredit, listCustomerCreditsForInvoice, markCreditRefunded } from "../actions";

type OpenCredit = { id: string; amount: number; disposition: string; note: string | null; created_at: string; onThisInvoice: boolean };

/** Post a credit/refund to the customer's account from this invoice — and SPEND one that's
 *  already sitting there. With `menuItem` the trigger renders as an Actions-menu row (the rare
 *  accounting verb lives behind the ⋯ seek door, not the header).
 *
 *  The account list is the way out of the dead end (audit v921): a credit posted from an
 *  overpaid invoice reduced nothing there and had no button anywhere that could move it onto
 *  the customer's next bill, so the CRM tile counted it forever. */
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
  const [credits, setCredits] = useState<OpenCredit[]>([]);

  // Load what's already on the account when the window opens — this is the only place the
  // office can see (and use) an open credit from the invoice they're looking at.
  const loadCredits = useCallback(async () => {
    const res = await listCustomerCreditsForInvoice(invoiceId);
    setCredits(res.ok ? (res.credits ?? []) : []);
  }, [invoiceId]);
  useEffect(() => {
    if (open) void loadCredits();
  }, [open, loadCredits]);

  /** Run one account action, then re-read the list so the row reflects what landed. */
  function act(run: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const res = await run();
      if (!res.ok) return setError(res.error ?? "Could not save.");
      await loadCredits();
      router.refresh();
    });
  }

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
          <ModalActions onCancel={() => setOpen(false)} onSave={save} saving={pending} disabled={!(amount > 0)} saveLabel="Post Credit" />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {credits.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">On this customer&apos;s account</div>
              <ul className="mt-2 space-y-2">
                {credits.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-slate-700">
                      <span className="font-medium text-slate-900">{formatCurrency(c.amount)}</span>{" "}
                      {c.disposition === "refund"
                        ? "refund pending"
                        : c.onThisInvoice
                          ? "credited on this invoice"
                          : "account credit"}
                      {c.note ? ` — ${c.note}` : ""}
                    </span>
                    {c.disposition === "refund" ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => act(() => markCreditRefunded(c.id))}
                        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        Mark Refunded
                      </button>
                    ) : c.onThisInvoice ? null : (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => act(() => applyCustomerCredit(c.id, invoiceId))}
                        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        Apply To This Invoice
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <Label htmlFor="cr-amt">Amount</Label>
            <NumberInput id="cr-amt" value={amount} onValueChange={setAmount} />
          </div>
          <div className="space-y-2">
            <Label>What should happen?</Label>
            {opt("credit", "Keep as account credit", "Sits on the customer's account — apply it to another invoice from this window")}
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
