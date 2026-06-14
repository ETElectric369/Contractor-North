"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import type { Invoice, InvoiceItem, Payment } from "@/lib/types";
import {
  addInvoiceItem,
  updateInvoiceItem,
  deleteInvoiceItem,
  setInvoiceStatus,
  setInvoiceTaxRate,
  recordPayment,
  importQuoteItemsIntoInvoice,
  importLaborIntoInvoice,
  importCostsIntoInvoice,
  updatePayment,
  deletePayment,
} from "../actions";

interface PriceItemLite { id: string; code: string | null; description: string; unit: string; buy_price: number; markup_pct: number; }
interface TaxRateLite { id: string; name: string; rate: number; is_default: boolean; }

const sellPrice = (buy: number, markup: number) => buy * (1 + (markup || 0) / 100);

export function InvoiceDetail({
  invoice,
  items,
  payments,
  priceItems = [],
  taxRates = [],
  paymentMethods = [],
}: {
  invoice: Invoice;
  items: InvoiceItem[];
  payments: Payment[];
  priceItems?: PriceItemLite[];
  taxRates?: TaxRateLite[];
  paymentMethods?: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const refresh = () => router.refresh();

  const balance = Number(invoice.total) - Number(invoice.amount_paid);

  // add-item state
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState(1);
  const [unit, setUnit] = useState("ea");
  const [price, setPrice] = useState(0);
  const [plQuery, setPlQuery] = useState("");
  const [plOpen, setPlOpen] = useState(false);

  // payment state
  const [payAmount, setPayAmount] = useState(balance > 0 ? balance : 0);
  const [payMethod, setPayMethod] = useState(paymentMethods[0] ?? "Check");

  // import state
  const [importMsg, setImportMsg] = useState<string | null>(null);
  function runImport(fn: (id: string) => Promise<{ ok: boolean; error?: string }>, label: string) {
    setImportMsg(null);
    start(async () => {
      const res = await fn(invoice.id);
      setImportMsg(res.ok ? `${label} imported.` : res.error ?? "Import failed.");
      setTimeout(() => setImportMsg(null), 5000);
      refresh();
    });
  }

  // edit-payment state
  const [payEditId, setPayEditId] = useState<string | null>(null);
  const [payEditAmount, setPayEditAmount] = useState(0);
  const [payEditMethod, setPayEditMethod] = useState("check");
  const [payEditNote, setPayEditNote] = useState("");

  // edit-item state
  const [editId, setEditId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editQty, setEditQty] = useState(1);
  const [editPrice, setEditPrice] = useState(0);

  function startEdit(it: InvoiceItem) {
    setEditId(it.id);
    setEditDesc(it.description);
    setEditQty(Number(it.quantity));
    setEditPrice(Number(it.unit_price));
  }

  function saveEdit() {
    if (!editId) return;
    start(async () => {
      await updateInvoiceItem(editId, invoice.id, {
        description: editDesc,
        quantity: editQty,
        unit_price: editPrice,
      });
      setEditId(null);
      refresh();
    });
  }

  const plMatches = plQuery.trim()
    ? priceItems.filter((p) => [p.code, p.description].some((v) => (v ?? "").toLowerCase().includes(plQuery.trim().toLowerCase()))).slice(0, 6)
    : [];
  function addFromPrice(p: PriceItemLite) {
    start(async () => {
      await addInvoiceItem(invoice.id, {
        description: p.code ? `${p.code} — ${p.description}` : p.description,
        quantity: 1,
        unit: p.unit || "ea",
        unit_price: Number(sellPrice(p.buy_price, p.markup_pct).toFixed(2)),
      });
      setPlQuery("");
      setPlOpen(false);
      refresh();
    });
  }
  const [payNote, setPayNote] = useState("");
  const [payError, setPayError] = useState<string | null>(null);

  function addItem() {
    if (!desc.trim()) return;
    start(async () => {
      await addInvoiceItem(invoice.id, {
        description: desc,
        quantity: qty || 1,
        unit,
        unit_price: price || 0,
      });
      setDesc("");
      setQty(1);
      setUnit("ea");
      setPrice(0);
      refresh();
    });
  }

  function pay() {
    setPayError(null);
    start(async () => {
      const res = await recordPayment({
        invoice_id: invoice.id,
        amount: payAmount,
        method: payMethod,
        note: payNote,
      });
      if (!res.ok) {
        setPayError(res.error ?? "Could not record payment.");
        return;
      }
      setPayNote("");
      refresh();
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-500">Status</span>
          <Select
            value={invoice.status}
            className="w-36"
            disabled={pending}
            onChange={(e) =>
              start(async () => {
                await setInvoiceStatus(invoice.id, e.target.value);
                refresh();
              })
            }
          >
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="partial">Partial</option>
            <option value="paid">Paid</option>
            <option value="overdue">Overdue</option>
            <option value="void">Void</option>
          </Select>
        </div>

        {priceItems.length > 0 && (
          <div className="relative">
            <Input
              placeholder="Add from Price List — search items…"
              value={plQuery}
              onChange={(e) => { setPlQuery(e.target.value); setPlOpen(true); }}
              onFocus={() => setPlOpen(true)}
              onBlur={() => setTimeout(() => setPlOpen(false), 150)}
            />
            {plOpen && plMatches.length > 0 && (
              <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                {plMatches.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => addFromPrice(p)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      <span className="min-w-0 truncate">
                        {p.code && <span className="mr-1 font-mono text-xs text-slate-400">{p.code}</span>}
                        {p.description}
                      </span>
                      <span className="shrink-0 text-slate-600">{formatCurrency(sellPrice(p.buy_price, p.markup_pct))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(invoice.job_id || (invoice as any).quote_id) && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-3 py-2.5">
            <span className="text-xs font-medium text-slate-500">Import:</span>
            <Button size="sm" variant="outline" onClick={() => runImport(importQuoteItemsIntoInvoice, "Quote items")} disabled={pending}>
              From quote
            </Button>
            {invoice.job_id && (
              <>
                <Button size="sm" variant="outline" onClick={() => runImport(importLaborIntoInvoice, "Labor")} disabled={pending}>
                  Labor from timecards
                </Button>
                <Button size="sm" variant="outline" onClick={() => runImport(importCostsIntoInvoice, "Materials")} disabled={pending}>
                  Materials from costs
                </Button>
              </>
            )}
            {importMsg && <span className="text-xs text-slate-500">{importMsg}</span>}
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-white">
          <ul className="divide-y divide-slate-100">
            {items.map((it) =>
              editId === it.id ? (
                <li key={it.id} className="space-y-2 bg-slate-50/80 px-4 py-3 text-sm">
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
                <li key={it.id} className="group flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-slate-50">
                  <button
                    type="button"
                    onClick={() => startEdit(it)}
                    disabled={pending}
                    className="min-w-0 flex-1 cursor-pointer text-left"
                    title="Edit line item"
                  >
                    <div className="font-medium text-slate-800">{it.description}</div>
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
                    onClick={() => start(async () => { await deleteInvoiceItem(it.id, invoice.id); refresh(); })}
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
            {items.length === 0 && (
              <li className="px-4 py-6 text-center text-slate-400">No line items yet.</li>
            )}
          </ul>
          {/* Add line item */}
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
        </div>
      </div>

      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-2 py-5 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal</span>
              <span>{formatCurrency(invoice.subtotal)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-slate-600">
              {taxRates.length > 0 ? (
                <Select
                  className="h-8 w-44 text-xs"
                  value={taxRates.find((t) => Math.abs(Number(t.rate) / 100 - Number(invoice.tax_rate)) < 1e-9)?.id ?? ""}
                  disabled={pending}
                  onChange={(e) =>
                    start(async () => {
                      const r = taxRates.find((t) => t.id === e.target.value);
                      await setInvoiceTaxRate(invoice.id, r ? Number(r.rate) : 0);
                      refresh();
                    })
                  }
                >
                  <option value="">No tax</option>
                  {taxRates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name} ({Number(t.rate)}%)</option>
                  ))}
                </Select>
              ) : (
                <span>Tax ({(invoice.tax_rate * 100).toFixed(2)}%)</span>
              )}
              <span>{formatCurrency(invoice.tax)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-2 font-semibold text-slate-900">
              <span>Total</span>
              <span>{formatCurrency(invoice.total)}</span>
            </div>
            <div className="flex justify-between text-green-600">
              <span>Paid</span>
              <span>{formatCurrency(invoice.amount_paid)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-2 text-base font-bold text-slate-900">
              <span>Balance due</span>
              <span>{formatCurrency(balance)}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 py-5">
            <h3 className="text-sm font-semibold text-slate-900">Record payment</h3>
            {payError && <p className="text-sm text-red-600">{payError}</p>}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="pay-amt">Amount</Label>
                <NumberInput
                  id="pay-amt"
                  value={payAmount}
                  onValueChange={setPayAmount}
                />
              </div>
              <div>
                <Label htmlFor="pay-method">Method</Label>
                <Select
                  id="pay-method"
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                >
                  {(paymentMethods.length ? paymentMethods : ["Check", "Card", "Cash"]).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </Select>
              </div>
            </div>
            <Input
              placeholder="Note (e.g. check #1042)"
              value={payNote}
              onChange={(e) => setPayNote(e.target.value)}
            />
            <Button className="w-full" onClick={pay} disabled={pending}>
              {pending ? "Saving…" : "Record payment"}
            </Button>
          </CardContent>
        </Card>

        {payments.length > 0 && (
          <Card>
            <div className="border-b border-slate-100 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-900">Payments</h3>
            </div>
            <ul className="divide-y divide-slate-100">
              {payments.map((p) =>
                payEditId === p.id ? (
                  <li key={p.id} className="space-y-2 bg-slate-50/80 px-5 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <NumberInput value={payEditAmount} onValueChange={setPayEditAmount} className="w-28 text-right" />
                      <Select value={payEditMethod} onChange={(e) => setPayEditMethod(e.target.value)} className="flex-1">
                        {/* Keep the stored method selectable even if it's not in the configured list. */}
                        {payEditMethod && !paymentMethods.includes(payEditMethod) && (
                          <option value={payEditMethod}>{payEditMethod}</option>
                        )}
                        {paymentMethods.length ? (
                          paymentMethods.map((m) => <option key={m} value={m}>{m}</option>)
                        ) : (
                          <option value="check">check</option>
                        )}
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input value={payEditNote} onChange={(e) => setPayEditNote(e.target.value)} placeholder="Note" />
                      <button
                        onClick={() =>
                          start(async () => {
                            await updatePayment(p.id, invoice.id, { amount: payEditAmount, method: payEditMethod, note: payEditNote });
                            setPayEditId(null);
                            refresh();
                          })
                        }
                        disabled={pending || payEditAmount <= 0}
                        className="rounded-md bg-brand p-1.5 text-white disabled:opacity-50"
                        aria-label="Save payment"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button onClick={() => setPayEditId(null)} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Cancel">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                ) : (
                  <li key={p.id} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-900">
                        {formatCurrency(p.amount)}
                      </div>
                      <div className="text-xs capitalize text-slate-400">
                        {p.method}
                        {p.note ? ` · ${p.note}` : ""}
                      </div>
                    </div>
                    <span className="text-xs text-slate-400">
                      {formatDateTime(p.paid_at)}
                    </span>
                    <button
                      onClick={() => {
                        setPayEditId(p.id);
                        setPayEditAmount(Number(p.amount));
                        setPayEditMethod(p.method);
                        setPayEditNote(p.note ?? "");
                      }}
                      className="shrink-0 text-slate-400 hover:text-slate-700"
                      aria-label="Edit payment"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => {
                        if (!confirm(`Delete this ${formatCurrency(p.amount)} payment? The invoice balance recalculates.`)) return;
                        start(async () => {
                          await deletePayment(p.id, invoice.id);
                          refresh();
                        });
                      }}
                      disabled={pending}
                      className="shrink-0 text-slate-400 hover:text-red-600"
                      aria-label="Delete payment"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ),
              )}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
