"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { createInvoiceFromQuote, createBlankInvoice } from "./actions";

interface QuoteOption {
  id: string;
  quote_number: string;
  total: number;
  customers: { name: string } | null;
}
interface CustomerOption {
  id: string;
  name: string;
}

export function NewInvoiceButton({
  quotes,
  customers,
}: {
  quotes: QuoteOption[];
  customers: CustomerOption[];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"quote" | "blank">(
    quotes.length ? "quote" : "blank",
  );
  const [quoteId, setQuoteId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [title, setTitle] = useState("");
  const [taxRate, setTaxRate] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function onCreate() {
    setError(null);
    start(async () => {
      const res =
        mode === "quote"
          ? await createInvoiceFromQuote(quoteId)
          : await createBlankInvoice({
              customer_id: customerId || null,
              title,
              tax_rate: taxRate,
            });
      if (!res.ok) {
        setError(res.error ?? "Could not create invoice.");
        return;
      }
      setOpen(false);
      if (res.id) router.push(`/billing/${res.id}`);
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New invoice
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="New invoice">
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => setMode("quote")}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                mode === "quote"
                  ? "border-brand bg-brand-light text-brand-dark"
                  : "border-slate-200 text-slate-600"
              }`}
            >
              From a quote
            </button>
            <button
              onClick={() => setMode("blank")}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                mode === "blank"
                  ? "border-brand bg-brand-light text-brand-dark"
                  : "border-slate-200 text-slate-600"
              }`}
            >
              Blank invoice
            </button>
          </div>

          {mode === "quote" ? (
            <div>
              <Label htmlFor="inv-quote">Quote</Label>
              <Select
                id="inv-quote"
                value={quoteId}
                onChange={(e) => setQuoteId(e.target.value)}
              >
                <option value="">— Select a quote —</option>
                {quotes.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.quote_number} · {q.customers?.name ?? "—"} ·{" "}
                    {formatCurrency(q.total)}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-slate-400">
                Copies the customer, totals, and every line item onto a new
                invoice.
              </p>
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="inv-customer">Customer</Label>
                <Select
                  id="inv-customer"
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                >
                  <option value="">— None —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="inv-title">Title</Label>
                  <Input
                    id="inv-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="inv-tax">Tax rate %</Label>
                  <Input
                    id="inv-tax"
                    type="number"
                    step="any"
                    placeholder="8.25"
                    onChange={(e) =>
                      setTaxRate((Number(e.target.value) || 0) / 100)
                    }
                  />
                </div>
              </div>
            </>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={onCreate}
              disabled={pending || (mode === "quote" && !quoteId)}
            >
              {pending ? "Creating…" : "Create invoice"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
