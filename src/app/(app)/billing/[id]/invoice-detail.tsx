"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import type { Invoice, InvoiceItem, Payment } from "@/lib/types";
import {
  addInvoiceItem,
  deleteInvoiceItem,
  setInvoiceStatus,
  recordPayment,
} from "../actions";

export function InvoiceDetail({
  invoice,
  items,
  payments,
}: {
  invoice: Invoice;
  items: InvoiceItem[];
  payments: Payment[];
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

  // payment state
  const [payAmount, setPayAmount] = useState(balance > 0 ? balance : 0);
  const [payMethod, setPayMethod] = useState("check");
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

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-5 py-3 font-semibold">Description</th>
                <th className="px-3 py-3 text-right font-semibold">Qty</th>
                <th className="px-3 py-3 text-right font-semibold">Price</th>
                <th className="px-5 py-3 text-right font-semibold">Total</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((it) => (
                <tr key={it.id}>
                  <td className="px-5 py-2.5 text-slate-800">{it.description}</td>
                  <td className="px-3 py-2.5 text-right text-slate-600">
                    {it.quantity} {it.unit}
                  </td>
                  <td className="px-3 py-2.5 text-right text-slate-600">
                    {formatCurrency(it.unit_price)}
                  </td>
                  <td className="px-5 py-2.5 text-right font-medium text-slate-900">
                    {formatCurrency(it.line_total)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      onClick={() =>
                        start(async () => {
                          await deleteInvoiceItem(it.id, invoice.id);
                          refresh();
                        })
                      }
                      disabled={pending}
                      className="text-slate-400 hover:text-red-600"
                      aria-label="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-6 text-center text-slate-400">
                    No line items yet.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-100 bg-slate-50/50">
                <td className="px-5 py-2">
                  <Input
                    placeholder="Add line item…"
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addItem()}
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    step="any"
                    value={qty}
                    onChange={(e) => setQty(Number(e.target.value))}
                    className="text-right"
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    step="any"
                    value={price}
                    onChange={(e) => setPrice(Number(e.target.value))}
                    className="text-right"
                  />
                </td>
                <td className="px-5 py-2 text-right font-semibold text-slate-900">
                  {formatCurrency(invoice.subtotal)}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button size="icon" onClick={addItem} disabled={pending || !desc.trim()}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-2 py-5 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal</span>
              <span>{formatCurrency(invoice.subtotal)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Tax ({(invoice.tax_rate * 100).toFixed(2)}%)</span>
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
                <Input
                  id="pay-amt"
                  type="number"
                  step="any"
                  value={payAmount}
                  onChange={(e) => setPayAmount(Number(e.target.value))}
                />
              </div>
              <div>
                <Label htmlFor="pay-method">Method</Label>
                <Select
                  id="pay-method"
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                >
                  <option value="check">Check</option>
                  <option value="card">Card</option>
                  <option value="cash">Cash</option>
                  <option value="ach">ACH</option>
                  <option value="other">Other</option>
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
              {payments.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between px-5 py-2.5 text-sm"
                >
                  <div>
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
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
