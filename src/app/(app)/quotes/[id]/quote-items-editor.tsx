"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { LineItemText } from "@/components/line-item-text";
import type { Quote, QuoteLineItem } from "@/lib/types";
import { addQuoteItem, updateQuoteItem, deleteQuoteItem, updateQuoteMeta } from "../actions";

/** Editable line items + totals + header details for a saved quote. */
export function QuoteItemsEditor({ quote, items }: { quote: Quote; items: QuoteLineItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const refresh = () => router.refresh();

  // add-item state
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState(0);

  // edit-item state
  const [editId, setEditId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editQty, setEditQty] = useState(1);
  const [editPrice, setEditPrice] = useState(0);

  // details modal state
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [title, setTitle] = useState(quote.title ?? "");
  const [notes, setNotes] = useState(quote.notes ?? "");
  const [taxPct, setTaxPct] = useState(Number(quote.tax_rate) * 100);
  const [validUntil, setValidUntil] = useState(quote.valid_until?.slice(0, 10) ?? "");
  const [error, setError] = useState<string | null>(null);

  function addItem() {
    if (!desc.trim()) return;
    setError(null);
    start(async () => {
      const res = await addQuoteItem(quote.id, { description: desc.trim(), quantity: qty, unit: "ea", unit_price: price });
      if (!res.ok) return setError(res.error ?? "Couldn't add the item.");
      setDesc("");
      setQty(1);
      setPrice(0);
      refresh();
    });
  }

  function startEdit(it: QuoteLineItem) {
    setEditId(it.id);
    setEditDesc(it.description);
    setEditQty(Number(it.quantity));
    setEditPrice(Number(it.unit_price));
  }

  function saveEdit() {
    if (!editId) return;
    setError(null);
    start(async () => {
      const res = await updateQuoteItem(editId, quote.id, { description: editDesc, quantity: editQty, unit_price: editPrice });
      if (!res.ok) return setError(res.error ?? "Couldn't save the item.");
      setEditId(null);
      refresh();
    });
  }

  function saveDetails() {
    setError(null);
    start(async () => {
      const res = await updateQuoteMeta(quote.id, {
        title,
        notes,
        tax_rate: (taxPct || 0) / 100,
        valid_until: validUntil || null,
      });
      if (!res.ok) {
        setError(res.error ?? "Could not save.");
        return;
      }
      setDetailsOpen(false);
      refresh();
    });
  }

  return (
    <>
      <Card>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <span className="text-sm font-semibold text-slate-900">Line items</span>
          <Button size="sm" variant="outline" onClick={() => setDetailsOpen(true)}>
            <Pencil className="h-3.5 w-3.5" /> Edit details
          </Button>
        </div>
        {error && !detailsOpen && (
          <div className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <ul className="divide-y divide-slate-100">
          {items.map((it) =>
            editId === it.id ? (
              <li key={it.id} className="space-y-2 bg-slate-50/80 px-5 py-3 text-sm">
                <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description" />
                <div className="flex items-center gap-2">
                  <NumberInput value={editQty} onValueChange={setEditQty} className="w-20 text-center" />
                  <span className="text-slate-400">×</span>
                  <NumberInput value={editPrice} onValueChange={setEditPrice} className="flex-1 text-right" />
                  <button
                    onClick={saveEdit}
                    disabled={pending || !editDesc.trim()}
                    className="rounded-md bg-brand p-1.5 text-white hover:bg-brand-dark disabled:opacity-50"
                    aria-label="Save"
                  >
                    <Check className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setEditId(null)}
                    className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"
                    aria-label="Cancel"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ) : (
              <li key={it.id} className="group flex items-center gap-3 px-5 py-3 text-sm transition-colors hover:bg-slate-50">
                <button
                  type="button"
                  onClick={() => startEdit(it)}
                  disabled={pending}
                  className="min-w-0 flex-1 cursor-pointer text-left"
                  title="Edit line item"
                >
                  <LineItemText description={it.description} className="block font-medium text-slate-800" />
                  <div className="text-xs text-slate-400">
                    {it.quantity} {it.unit} × {formatCurrency(it.unit_price)}
                  </div>
                </button>
                <div className="shrink-0 font-medium text-slate-900">{formatCurrency(it.line_total)}</div>
                <button
                  onClick={() => startEdit(it)}
                  disabled={pending}
                  className="shrink-0 text-slate-500 hover:text-brand"
                  aria-label="Edit"
                  title="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => start(async () => { setError(null); const res = await deleteQuoteItem(it.id, quote.id); if (!res.ok) return setError(res.error ?? "Couldn't remove the item."); refresh(); })}
                  disabled={pending}
                  className="shrink-0 text-slate-500 hover:text-red-600"
                  aria-label="Remove"
                  title="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ),
          )}
          {items.length === 0 && <li className="px-5 py-6 text-center text-sm text-slate-400">No line items yet.</li>}
        </ul>

        <div className="space-y-2 border-t border-slate-100 bg-slate-50/60 p-3">
          <Input
            placeholder="Add a line item…"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addItem()}
          />
          <div className="flex items-center gap-2">
            <NumberInput value={qty} onValueChange={setQty} className="w-20 text-center" placeholder="Qty" />
            <span className="text-slate-400">×</span>
            <NumberInput value={price} onValueChange={setPrice} className="flex-1 text-right" placeholder="Price" />
            <Button onClick={addItem} disabled={pending || !desc.trim()}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        </div>

        <div className="border-t border-slate-100 px-5 py-4">
          <div className="ml-auto max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal</span>
              <span>{formatCurrency(quote.subtotal)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Tax ({(Number(quote.tax_rate) * 100).toFixed(2)}%)</span>
              <span>{formatCurrency(quote.tax)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-1.5 text-base font-semibold text-slate-900">
              <span>Total</span>
              <span>{formatCurrency(quote.total)}</span>
            </div>
          </div>
        </div>
      </Card>

      {quote.notes && (
        <Card className="mt-6">
          <div className="px-5 py-5">
            <h3 className="mb-1 text-sm font-semibold text-slate-900">Notes</h3>
            <p className="whitespace-pre-wrap text-sm text-slate-600">{quote.notes}</p>
          </div>
        </Card>
      )}

      <Modal
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title="Edit quote details"
        footer={
          <ModalActions onCancel={() => setDetailsOpen(false)} onSave={saveDetails} saving={pending} saveLabel="Save changes" />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div>
            <Label htmlFor="qd-title">Title</Label>
            <Input id="qd-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Panel upgrade — 200A" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="qd-tax">Tax rate (%)</Label>
              <NumberInput id="qd-tax" value={taxPct} onValueChange={setTaxPct} />
            </div>
            <div>
              <Label htmlFor="qd-valid">Valid until</Label>
              <Input id="qd-valid" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="qd-notes">Notes</Label>
            <Textarea id="qd-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </Modal>
    </>
  );
}
