"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { useToast } from "@/components/toast";
import { formatCurrency } from "@/lib/utils";
import { invoiceBalance } from "@/lib/invoice-math";
import { recordPayment } from "../billing/actions";

interface OpenInvoice {
  id: string;
  invoice_number: string;
  total: number;
  amount_paid: number;
  customers: { name: string } | null;
}

/** The /payments entry point for recording money in — same recordPayment action
 *  (and all its guards) as the invoice page, just with an invoice picker first.
 *  Only open non-draft invoices are offered: drafts can't take payments, and the
 *  action caps the amount at the invoice balance. */
export function RecordPaymentButton({
  invoices,
  paymentMethods,
}: {
  invoices: OpenInvoice[];
  paymentMethods: string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState(paymentMethods[0] ?? "Check");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const dirty = !!(invoiceId || amount || date || note);

  // Confirmed close (the Modal's two-tap guard has already asked when dirty).
  function close() {
    setOpen(false);
    setInvoiceId("");
    setAmount(0);
    setDate("");
    setNote("");
    setError(null);
  }

  function save() {
    setError(null);
    start(async () => {
      const res = await recordPayment({
        invoice_id: invoiceId,
        amount,
        method,
        note,
        paid_at: date,
      });
      if (!res.ok) {
        setError(res.error ?? "Could not record the payment.");
        return;
      }
      toast("Payment recorded", "success");
      close();
      router.refresh();
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Record Payment
      </Button>

      <Modal
        open={open}
        onClose={close}
        title="Record payment"
        dirty={dirty}
        footer={
          <ModalActions
            onCancel={close}
            onSave={save}
            saving={pending}
            disabled={!invoiceId || amount <= 0}
            saveLabel="Record payment"
          />
        }
      >
        {invoices.length === 0 ? (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
            No open invoices with a balance. Send an invoice from{" "}
            <Link href="/billing" className="font-medium text-brand underline">
              Billing
            </Link>{" "}
            first, then record the payment here.
          </p>
        ) : (
          <div className="space-y-4">
            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}

            <div>
              <Label htmlFor="rp-invoice">Invoice</Label>
              <Select
                id="rp-invoice"
                value={invoiceId}
                onChange={(e) => {
                  const id = e.target.value;
                  setInvoiceId(id);
                  // Seed the amount with the open balance (the invoice page's default).
                  const inv = invoices.find((i) => i.id === id);
                  setAmount(inv ? invoiceBalance(inv.total, inv.amount_paid) : 0);
                }}
              >
                <option value="">— Select an invoice —</option>
                {invoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.invoice_number} · {i.customers?.name ?? "—"} ·{" "}
                    {formatCurrency(invoiceBalance(i.total, i.amount_paid))} due
                  </option>
                ))}
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="rp-amount">Amount</Label>
                <NumberInput id="rp-amount" value={amount} onValueChange={setAmount} />
              </div>
              <div>
                <Label htmlFor="rp-method">Method</Label>
                <Select id="rp-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                  {(paymentMethods.length ? paymentMethods : ["Check", "Card", "Cash"]).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="rp-date">Date</Label>
                <Input id="rp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="rp-note">Note</Label>
                <Input
                  id="rp-note"
                  placeholder="e.g. check #1042"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
