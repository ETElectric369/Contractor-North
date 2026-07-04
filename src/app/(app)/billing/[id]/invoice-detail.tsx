"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { invoiceBalance } from "@/lib/invoice-math";
import { LineItemText } from "@/components/line-item-text";
import { CostBreakdown } from "@/components/cost-breakdown";
import type { Invoice, InvoiceItem, Payment } from "@/lib/types";
import {
  addInvoiceItem,
  updateInvoiceItem,
  deleteInvoiceItem,
  setInvoiceStatus,
  setInvoiceTaxRate,
  setInvoiceDescription,
  setInvoiceTitle,
  setInvoiceDueDate,
  setInvoiceCustomerJob,
  recordPayment,
  importQuoteItemsIntoInvoice,
  importLaborIntoInvoice,
  importCostsIntoInvoice,
  updatePayment,
  deletePayment,
} from "../actions";

interface PriceItemLite { id: string; code: string | null; description: string; unit: string; buy_price: number; markup_pct: number; }
interface TaxRateLite { id: string; name: string; rate: number; is_default: boolean; }
interface CustomerLite { id: string; name: string; }
interface JobLite { id: string; name: string | null; job_number: string | null; customer_id: string | null; }

const sellPrice = (buy: number, markup: number) => buy * (1 + (markup || 0) / 100);

/** ISO timestamp → "YYYY-MM-DD" in local time, for a <input type=date>. */
const toDateInput = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function InvoiceDetail({
  invoice,
  items,
  payments,
  priceItems = [],
  taxRates = [],
  paymentMethods = [],
  materialMarkup = 0,
  customers = [],
  jobs = [],
}: {
  invoice: Invoice;
  items: InvoiceItem[];
  payments: Payment[];
  priceItems?: PriceItemLite[];
  taxRates?: TaxRateLite[];
  paymentMethods?: string[];
  materialMarkup?: number;
  customers?: CustomerLite[];
  jobs?: JobLite[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const refresh = () => router.refresh();

  const balance = invoiceBalance(invoice.total, invoice.amount_paid);

  // invoice description (scope shown above the line items)
  const [descr, setDescr] = useState((invoice as any).description ?? "");
  const [descrSaved, setDescrSaved] = useState(false);
  const descrDirty = descr !== ((invoice as any).description ?? "");
  function saveDescr() {
    setDescrSaved(false);
    start(async () => {
      const res = await setInvoiceDescription(invoice.id, descr);
      if (!res?.ok) { toast(res?.error ?? "Couldn't save the description — try again.", "error"); return; }
      setDescrSaved(true);
      setTimeout(() => setDescrSaved(false), 2000);
    });
  }

  const isDraft = invoice.status === "draft";

  // inline-editable title (the short header label)
  const [titleEditing, setTitleEditing] = useState(false);
  const [title, setTitle] = useState(invoice.title ?? "");
  const [titleError, setTitleError] = useState<string | null>(null);
  function saveTitle() {
    setTitleError(null);
    start(async () => {
      const res = await setInvoiceTitle(invoice.id, title);
      if (!res.ok) { setTitleError(res.error ?? "Could not save the title."); return; }
      setTitleEditing(false);
      refresh();
    });
  }

  // editable due date (the field the Overdue tracker reads)
  const [dueDate, setDueDate] = useState(toDateInput(invoice.due_date));
  const [dueSaved, setDueSaved] = useState(false);
  const [dueError, setDueError] = useState<string | null>(null);
  const dueDirty = dueDate !== toDateInput(invoice.due_date);
  function saveDue() {
    setDueError(null);
    setDueSaved(false);
    start(async () => {
      const res = await setInvoiceDueDate(invoice.id, dueDate || null);
      if (!res.ok) { setDueError(res.error ?? "Could not save the due date."); return; }
      setDueSaved(true);
      setTimeout(() => setDueSaved(false), 2000);
      refresh();
    });
  }

  // draft-only customer/job correction
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkCustomer, setLinkCustomer] = useState(invoice.customer_id ?? "");
  const [linkJob, setLinkJob] = useState(invoice.job_id ?? "");
  const [linkError, setLinkError] = useState<string | null>(null);
  function openLink() {
    setLinkCustomer(invoice.customer_id ?? "");
    setLinkJob(invoice.job_id ?? "");
    setLinkError(null);
    setLinkOpen(true);
  }
  function saveLink() {
    setLinkError(null);
    start(async () => {
      const res = await setInvoiceCustomerJob(invoice.id, {
        customer_id: linkCustomer || null,
        job_id: linkJob || null,
      });
      if (!res.ok) { setLinkError(res.error ?? "Could not update the link."); return; }
      setLinkOpen(false);
      refresh();
    });
  }
  // When a job is chosen, narrow the customer to that job's customer for clarity.
  const linkJobObj = jobs.find((j) => j.id === linkJob) ?? null;
  const customerOf = (jobObj: JobLite | null) => jobObj?.customer_id ?? "";

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
  const [markup, setMarkup] = useState(materialMarkup); // material markup % for the costs import
  function runImport(fn: (id: string) => Promise<{ ok: boolean; error?: string }>, label: string) {
    setImportMsg(null);
    start(async () => {
      const res = await fn(invoice.id);
      if (!res.ok) {
        setImportMsg(res.error ?? "Import failed.");
        toast(res.error ?? `Couldn't import ${label.toLowerCase()} — try again.`, "error");
        setTimeout(() => setImportMsg(null), 5000);
        return;
      }
      setImportMsg(`${label} imported.`);
      toast(`${label} imported`, "success");
      setTimeout(() => setImportMsg(null), 5000);
      refresh();
    });
  }

  // edit-payment state
  const [payEditId, setPayEditId] = useState<string | null>(null);
  const [payEditAmount, setPayEditAmount] = useState(0);
  const [payEditMethod, setPayEditMethod] = useState("check");
  const [payEditNote, setPayEditNote] = useState("");
  const [payEditDate, setPayEditDate] = useState("");

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
      const res = await updateInvoiceItem(editId, invoice.id, {
        description: editDesc,
        quantity: editQty,
        unit_price: editPrice,
      });
      if (!res?.ok) { toast(res?.error ?? "Couldn't save the line item — try again.", "error"); return; }
      setEditId(null);
      refresh();
    });
  }

  const plMatches = plQuery.trim()
    ? priceItems.filter((p) => [p.code, p.description].some((v) => (v ?? "").toLowerCase().includes(plQuery.trim().toLowerCase()))).slice(0, 6)
    : [];
  function addFromPrice(p: PriceItemLite) {
    start(async () => {
      const res = await addInvoiceItem(invoice.id, {
        description: p.code ? `${p.code} — ${p.description}` : p.description,
        quantity: 1,
        unit: p.unit || "ea",
        unit_price: Number(sellPrice(p.buy_price, p.markup_pct).toFixed(2)),
      });
      if (!res?.ok) { toast(res?.error ?? "Couldn't add the line item — try again.", "error"); return; }
      setPlQuery("");
      setPlOpen(false);
      refresh();
    });
  }
  const [payNote, setPayNote] = useState("");
  const [payDate, setPayDate] = useState("");
  const [payError, setPayError] = useState<string | null>(null);

  function addItem() {
    if (!desc.trim()) return;
    start(async () => {
      const res = await addInvoiceItem(invoice.id, {
        description: desc,
        quantity: qty || 1,
        unit,
        unit_price: price || 0,
      });
      if (!res?.ok) { toast(res?.error ?? "Couldn't add the line item — try again.", "error"); return; }
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
        paid_at: payDate,
      });
      if (!res.ok) {
        setPayError(res.error ?? "Could not record payment.");
        toast(res.error ?? "Couldn't record the payment — try again.", "error");
        return;
      }
      toast("Payment recorded", "success");
      setPayNote("");
      setPayDate("");
      refresh();
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {/* Header fields — title (inline), due date (drives the Overdue tracker),
            and on drafts the customer/job link. */}
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
          {/* Title */}
          <div>
            <Label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Title</Label>
            {titleEditing ? (
              <div className="flex items-center gap-2">
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Short label for this invoice"
                  onKeyDown={(e) => e.key === "Enter" && saveTitle()}
                  autoFocus
                />
                <button
                  onClick={saveTitle}
                  disabled={pending}
                  className="rounded-md bg-brand p-1.5 text-white hover:bg-brand-dark disabled:opacity-50"
                  aria-label="Save title"
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  onClick={() => { setTitleEditing(false); setTitle(invoice.title ?? ""); setTitleError(null); }}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"
                  aria-label="Cancel"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setTitleEditing(true)}
                className="group flex w-full items-center gap-2 text-left"
                title="Edit title"
              >
                <span className={invoice.title ? "font-medium text-slate-800" : "text-slate-400"}>
                  {invoice.title || "Add a title…"}
                </span>
                <Pencil className="h-3.5 w-3.5 text-slate-400 group-hover:text-brand" />
              </button>
            )}
            {titleError && <p className="mt-1 text-xs text-red-600">{titleError}</p>}
          </div>

          {/* Due date — without this the Overdue tracker can never fire. */}
          <div>
            <Label htmlFor="inv-due" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Due date</Label>
            <div className="flex items-center gap-2">
              <Input
                id="inv-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-44"
              />
              <Button size="sm" onClick={saveDue} disabled={pending || !dueDirty}>
                {dueSaved ? <Check className="h-3.5 w-3.5" /> : null}
                {dueSaved ? "Saved" : "Save"}
              </Button>
              {dueDate && (
                <button
                  type="button"
                  onClick={() => setDueDate("")}
                  className="text-xs text-slate-400 hover:text-red-600"
                >
                  Clear
                </button>
              )}
              {dueDirty && !pending && <span className="text-xs text-slate-400">Unsaved</span>}
            </div>
            {dueError && <p className="mt-1 text-xs text-red-600">{dueError}</p>}
          </div>

          {/* Customer / job link — correctable while it's still a draft. */}
          {isDraft && (
            <div>
              <Label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Customer / Job</Label>
              <Button size="sm" variant="outline" onClick={openLink} disabled={pending}>
                <Pencil className="mr-1 h-3.5 w-3.5" /> Edit Customer / Job
              </Button>
            </div>
          )}
        </div>

        {/* Status is mostly system-derived: "Sent" comes from actually sending the
            invoice, and "Paid"/"Partial" from recorded payments — letting the user
            pick those by hand fakes money/send state (a "Sent" with no email, a
            "Paid" with no payment row so Collected never moves). The manual menu is
            limited to Draft and Void; the live status still shows as a locked option
            when it's one the system owns. */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-500">Status</span>
          <Select
            value={invoice.status}
            className="w-36"
            disabled={pending}
            onChange={(e) => {
              const next = e.target.value;
              start(async () => {
                const res = await setInvoiceStatus(invoice.id, next);
                if (!res?.ok) { toast(res?.error ?? "Couldn't change the status — try again.", "error"); return; }
                toast(next === "void" ? "Invoice voided" : "Status updated", "success");
                refresh();
              });
            }}
          >
            <option value="draft">Draft</option>
            {/* Keep the current status visible even though it isn't a manual choice. */}
            {!["draft", "void"].includes(invoice.status) && (
              <option value={invoice.status} disabled>
                {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
              </option>
            )}
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

        {/* Re-import is hidden on deposit/progress/final DRAWS: a draw is itemized
            at creation with a frozen "Less previous billings" credit, so a manual
            re-import would desync that credit and mis-bill. To refresh a draw,
            delete and recreate it (it re-imports + recomputes the credit). */}
        {/* Description / scope — printed above the line items on the invoice. */}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <Label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Description (above line items)</Label>
          <Textarea
            value={descr}
            onChange={(e) => setDescr(e.target.value)}
            placeholder="Scope of work — shows above the line items on the invoice."
            className="min-h-[60px]"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={saveDescr} disabled={pending || !descrDirty}>
              {descrSaved ? <Check className="h-3.5 w-3.5" /> : null}
              {descrSaved ? "Saved" : "Save"}
            </Button>
            {descrDirty && !pending && <span className="text-xs text-slate-400">Unsaved</span>}
          </div>
        </div>

        {(invoice.job_id || (invoice as any).quote_id) &&
          !["deposit", "progress", "final"].includes((invoice as any).invoice_kind ?? "") && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-3 py-2.5">
            <span className="text-xs font-medium text-slate-500">Import:</span>
            <Button size="sm" variant="outline" onClick={() => runImport(importQuoteItemsIntoInvoice, "Estimate items")} disabled={pending}>
              From Estimate
            </Button>
            {invoice.job_id && (
              <>
                <Button size="sm" variant="outline" onClick={() => runImport(importLaborIntoInvoice, "Labor")} disabled={pending}>
                  Labor From Timecards
                </Button>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => runImport((id) => importCostsIntoInvoice(id, markup), "Materials")} disabled={pending}>
                    Materials From Costs
                  </Button>
                  <NumberInput value={markup} onValueChange={setMarkup} className="h-8 w-14 text-center text-sm" aria-label="Material markup percent" />
                  <span className="text-xs text-slate-400">% markup</span>
                </div>
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
                    onClick={() => start(async () => { const res = await deleteInvoiceItem(it.id, invoice.id); if (!res?.ok) { toast(res?.error ?? "Couldn't remove the line item — try again.", "error"); return; } refresh(); })}
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
            <CostBreakdown items={items} className="mb-1" />
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
                      const res = await setInvoiceTaxRate(invoice.id, r ? Number(r.rate) : 0);
                      if (!res?.ok) { toast(res?.error ?? "Couldn't change the tax rate — try again.", "error"); return; }
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

        {/* id + scroll-mt: the header's "Record payment" impulse button anchor-jumps
            here (at 375px this card stacks below the whole line-items editor). */}
        <Card id="record-payment" className="scroll-mt-24">
          <CardContent className="space-y-3 py-5">
            <h3 className="text-sm font-semibold text-slate-900">Record payment</h3>
            {/* You can't collect on an invoice you haven't billed yet. On an unsent
                draft the form is de-emphasized behind a "send it first" hint so a
                payment is never recorded against an invoice the customer never got. */}
            {isDraft ? (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
                Send this invoice first — once it&apos;s billed to the customer you can
                record payments here.
              </p>
            ) : (
            <>
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
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="pay-date">Date</Label>
                <Input id="pay-date" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="pay-note">Note</Label>
                <Input
                  id="pay-note"
                  placeholder="e.g. check #1042"
                  value={payNote}
                  onChange={(e) => setPayNote(e.target.value)}
                />
              </div>
            </div>
            <Button className="w-full" onClick={pay} disabled={pending}>
              {pending ? "Saving…" : "Record Payment"}
            </Button>
            </>
            )}
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
                      <Input type="date" value={payEditDate} onChange={(e) => setPayEditDate(e.target.value)} className="w-40" aria-label="Payment date" />
                      <Input value={payEditNote} onChange={(e) => setPayEditNote(e.target.value)} placeholder="Note" />
                      <button
                        onClick={() =>
                          start(async () => {
                            const res = await updatePayment(p.id, invoice.id, { amount: payEditAmount, method: payEditMethod, note: payEditNote, paid_at: payEditDate });
                            if (!res?.ok) { toast(res?.error ?? "Couldn't update the payment — try again.", "error"); return; }
                            toast("Payment updated", "success");
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
                        setPayEditDate(toDateInput(p.paid_at));
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
                          const res = await deletePayment(p.id, invoice.id);
                          if (!res?.ok) { toast(res?.error ?? "Couldn't delete the payment — try again.", "error"); return; }
                          toast("Payment deleted", "success");
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

      <Modal open={linkOpen} onClose={() => setLinkOpen(false)} title="Edit customer / job">
        <div className="space-y-4">
          {linkError && <p className="text-sm text-red-600">{linkError}</p>}
          <div>
            <Label htmlFor="link-job">Job</Label>
            <Select
              id="link-job"
              value={linkJob}
              onChange={(e) => {
                const id = e.target.value;
                setLinkJob(id);
                // Inherit the job's customer so the invoice stays attached to it.
                const cust = customerOf(jobs.find((j) => j.id === id) ?? null);
                if (cust) setLinkCustomer(cust);
              }}
            >
              <option value="">No job</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.job_number ? `${j.job_number} — ` : ""}{j.name || "Untitled job"}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="link-customer">Customer</Label>
            <Select
              id="link-customer"
              value={linkCustomer}
              disabled={!!linkJobObj?.customer_id}
              onChange={(e) => setLinkCustomer(e.target.value)}
            >
              <option value="">No customer</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
            {linkJobObj?.customer_id && (
              <p className="mt-1 text-xs text-slate-400">Set from the selected job.</p>
            )}
          </div>
        </div>
        <ModalActions
          onCancel={() => setLinkOpen(false)}
          onSave={saveLink}
          saving={pending}
          saveLabel="Save link"
        />
      </Modal>
    </div>
  );
}
