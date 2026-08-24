"use client";

import { useState, useTransition } from "react";
import { NewCustomerInline } from "@/components/new-customer-inline";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil, Check, X, ChevronUp, ChevronDown, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { invoiceBalance, isDrawKind } from "@/lib/invoice-math";
import { LineItemText } from "@/components/line-item-text";
import { CostBreakdown } from "@/components/cost-breakdown";
import type { Invoice, InvoiceItem, Payment } from "@/lib/types";
import {
  addInvoiceItem,
  updateInvoiceItem,
  reorderInvoiceItems,
  parkInvoice,
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
  reimportFromScratch,
  importCostsIntoInvoice,
  updatePayment,
  deletePayment,
} from "../actions";
import { effectiveMarkupPct } from "@/lib/pricing/markup";
import { AddLineItems } from "@/components/add-line-items";

interface PriceItemLite { id: string; code: string | null; description: string; unit: string; buy_price: number; markup_pct: number; }
interface TaxRateLite { id: string; name: string; rate: number; is_default: boolean; }
interface CustomerLite { id: string; name: string; }
interface JobLite { id: string; name: string | null; job_number: string | null; customer_id: string | null; }

// Markup is resolved through effectiveMarkupPct (level → item → org default) at both
// call sites, so the invoice picker prices like the quote builder — never raw net cost.
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
  kits = [],
  taxRates = [],
  paymentMethods = [],
  materialMarkup = 0,
  levelMarkupPct = null,
  defaultMarkupPct = 0,
  customers = [],
  jobs = [],
}: {
  invoice: Invoice;
  items: InvoiceItem[];
  payments: Payment[];
  priceItems?: PriceItemLite[];
  kits?: { id: string; name: string; kit_items: unknown[] }[];
  taxRates?: TaxRateLite[];
  paymentMethods?: string[];
  materialMarkup?: number;
  /** The invoice customer's pricing-level markup (null = no level) — feeds effectiveMarkupPct. */
  levelMarkupPct?: number | null;
  defaultMarkupPct?: number;
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
  // Customers created inline from the link modal, merged ahead of the server list.
  const [addedCustomers, setAddedCustomers] = useState<CustomerLite[]>([]);
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

  // payment state
  const [payAmount, setPayAmount] = useState(balance > 0 ? balance : 0);
  const [payMethod, setPayMethod] = useState(paymentMethods[0] ?? "Check");

  // import state
  const [importMsg, setImportMsg] = useState<string | null>(null);
  /** An import that could not touch ANYTHING — every line edited, or the deleted ones tombstoned.
   *  Naming the source arms the "start over" button beside the message (0204). */
  const [stuckSource, setStuckSource] = useState<"labor" | "costs" | "quote" | null>(null);
  /** A draft deliberately waiting — leaves Needs action until this date (0206). */
  const [hold, setHold] = useState<string>((invoice as { hold_until?: string | null }).hold_until ?? "");
  const [markup, setMarkup] = useState(materialMarkup); // material markup % for the costs import
  // The % now applies ONLY when an import button is deliberately tapped — see the block below
  // where the auto-reapply used to live. It seeds from the customer's pricing level, or the org
  // default when they have none, which is NOT necessarily what this invoice's existing lines
  // were billed at: treat the box as "what the next import will use", never as a readout.
  const costsImported = items.some((i) => i.import_source === "costs");
  /**
   * Every import here is a DELETE-AND-REBUILD of its own line group (the 0156 RPC deletes by
   * import_source, then re-inserts from the job's current state). So it is never additive and it
   * never preserves a hand-edit — and on a real invoice that meant one tap could move the total
   * by thousands with nothing but a green "imported" toast to show for it.
   *
   * `replacing` is how many lines are about to be destroyed, said out loud before it happens.
   * The number is what makes this a decision instead of a surprise: "30 lines" reads very
   * differently from "Materials imported."
   */
  function runImport(
    fn: (id: string) => Promise<{ ok: boolean; error?: string }>,
    label: string,
    replacing = 0,
    sourceKey: "labor" | "costs" | "quote" | null = null,
  ) {
    if (replacing > 0) {
      const ok = confirm(
        `Re-import ${label.toLowerCase()}?\n\n` +
          `This REPLACES the ${replacing} ${label.toLowerCase()} line${replacing === 1 ? "" : "s"} ` +
          `already on ${invoice.invoice_number} with whatever the job holds right now — ` +
          `any price you edited by hand is overwritten, and anything added to the job since is pulled in.\n\n` +
          `Current total: ${formatCurrency(Number(invoice.total))}`,
      );
      if (!ok) return;
    }
    setImportMsg(null);
    setStuckSource(null);
    start(async () => {
      const res = await fn(invoice.id);
      if (!res.ok) {
        setImportMsg(res.error ?? "Import failed.");
        toast(res.error ?? `Couldn't import ${label.toLowerCase()} — try again.`, "error");
        setTimeout(() => setImportMsg(null), 5000);
        return;
      }
      // Say what actually happened. An import that left five negotiated lines alone and added
      // two new ones is a very different event from "imported", and the office needs to know
      // which — that ambiguity is what made the old behaviour feel like force-feeding.
      const st = (res as { stats?: { inserted: number; updated: number; kept_edited: number; removed: number } }).stats;
      const said = st
        ? [
            st.inserted ? `${st.inserted} added` : "",
            st.updated ? `${st.updated} updated` : "",
            st.kept_edited ? `${st.kept_edited} of your edits kept` : "",
            st.removed ? `${st.removed} removed` : "",
          ].filter(Boolean).join(" · ") || "nothing changed"
        : "";
      // "nothing changed" is the sentence that sent Erik looking for a bug (8/18). When an
      // import genuinely can't touch anything — every line edited, or the ones he deleted are
      // tombstoned — say WHY, and put the way out right next to it.
      const stuck = !!st && !st.inserted && !st.updated && !st.removed;
      setStuckSource(stuck ? sourceKey : null);
      setImportMsg(said ? `${label}: ${said}.` : `${label} imported.`);
      toast(said ? `${label} — ${said}` : `${label} imported`, "success");
      setTimeout(() => setImportMsg(null), 5000);
      refresh();
    });
  }

  /* REMOVED: a debounced effect that re-ran the FULL materials import 700ms after the markup
   * field changed. Two things made it dangerous rather than convenient:
   *
   *   1. importCostsIntoInvoice is a DELETE-AND-REBUILD, not a re-price — the RPC (migration
   *      0156) deletes every import_source='costs' row and re-inserts from the job's CURRENT
   *      state. So the "convenience" silently discarded any hand-edit on those lines and pulled
   *      in anything added to the job since.
   *   2. The markup box is seeded from the customer's pricing level, or failing that the ORG
   *      DEFAULT (page.tsx: `pricing_levels?.markup_pct ?? orgSettings.material_markup_percent`)
   *      — NOT from what this invoice's lines were actually billed at. On INV-050 the customer
   *      has no pricing level, so the box reads 25% over 30 lines that were not billed at 25%.
   *
   * Together: touch the field, wait 700ms, and a customer's invoice silently re-prices with no
   * confirm and no undo. That is the "force feeding" — it doesn't need a button press at all.
   * The markup now applies only when an import button is deliberately tapped.
   */

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
  const [editUnit, setEditUnit] = useState("ea");

  function startEdit(it: InvoiceItem) {
    setEditId(it.id);
    setEditDesc(it.description);
    setEditQty(Number(it.quantity));
    setEditPrice(Number(it.unit_price));
    setEditUnit(it.unit || "ea");
  }

  function saveEdit() {
    if (!editId) return;
    start(async () => {
      const res = await updateInvoiceItem(editId, invoice.id, {
        description: editDesc,
        quantity: editQty,
        unit: editUnit,
        unit_price: editPrice,
      });
      if (!res?.ok) { toast(res?.error ?? "Couldn't save the line item — try again.", "error"); return; }
      setEditId(null);
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

  /**
   * MOVE ONE LINE (Erik: "just like the playbook"). The whole sequence is written every time —
   * one atomic order rather than two rows swapping numbers and racing.
   */
  function moveItem(id: string, dir: -1 | 1) {
    const ids = items.map((i) => i.id);
    const at = ids.indexOf(id);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    start(async () => {
      const res = await reorderInvoiceItems(invoice.id, ids);
      if (!res?.ok) { toast(res?.error ?? "Couldn't move that line — try again.", "error"); return; }
      refresh();
    });
  }

  /**
   * GROUP THE LABOR TOGETHER (Erik: "itll be showing up at the bottom of the list").
   *
   * Sorts into the SAME buckets the customer's copy already prints its breakdown from
   * (groupInvoiceLines) — materials, then labor, then everything else, credits last — while
   * keeping each bucket's existing internal order, so a tidy never scrambles a sequence he set
   * by hand. It is one button, and the arrows still win afterwards.
   */
  function groupByKind() {
    const rank = (it: (typeof items)[number]) => {
      const src = (it as { import_source?: string | null }).import_source;
      const d = it.description ?? "";
      if (src === "draw_credit" || /less previous billings/i.test(d)) return 3;
      if (src === "labor" || /^labor — /i.test(d)) return 1;
      if (src === "costs" || /^materials — /i.test(d)) return 0;
      return 2;
    };
    const ids = items
      .map((it, i) => ({ it, i }))
      .sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i)
      .map(({ it }) => it.id);
    start(async () => {
      const res = await reorderInvoiceItems(invoice.id, ids);
      if (!res?.ok) { toast(res?.error ?? "Couldn't group the lines — try again.", "error"); return; }
      toast("Grouped — materials, then labor", "success");
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
                toast(next === "void" ? "Invoice voided" : next === "sent" ? "Marked as sent" : "Status updated", "success");
                refresh();
              });
            }}
          >
            <option value="draft">Draft</option>
            {/* Escape hatch: you sent the PDF yourself (texted/AirDropped/emailed it OUTSIDE
                the app), so record that it went out — the invoice leaves Draft and the job
                reads as invoiced without forcing you back through the Send button. Draft-only,
                so it can't be used to fake send-state on a live invoice. */}
            {invoice.status === "draft" && <option value="sent">Sent — I sent it myself</option>}
            {/* Keep the current status visible even though it isn't a manual choice. */}
            {!["draft", "void"].includes(invoice.status) && (
              <option value={invoice.status} disabled>
                {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
              </option>
            )}
            <option value="void">Void</option>
          </Select>
          {/* PARK IT (0206) — the ending that destroys nothing. A draft waiting on a change
              order or an approval had only Void (which unlinks the payment milestones) or
              Delete (which throws away the line items); both record something false about a
              bill that is simply not ready. It leaves Needs action and comes back on the date. */}
          {isDraft && (
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                aria-label="Park this draft until"
                value={hold}
                onChange={(e) => {
                  const v = e.target.value;
                  setHold(v);
                  start(async () => {
                    const res = await parkInvoice(invoice.id, v || null);
                    if (!res?.ok) { toast(res?.error ?? "Couldn't park it — try again.", "error"); return; }
                    toast(v ? `Parked until ${v} — it'll come back then` : "Back on the list", "success");
                    refresh();
                  });
                }}
                className="h-9 w-40 text-sm"
              />
              <span className="text-xs text-slate-400">{hold ? "parked until" : "park until…"}</span>
            </div>
          )}
        </div>

        {/* THE SAME PICKER AS THE COMPOSER. This surface had its own thinner copy: it returned
            NOTHING on an empty query (so you had to guess a search term against a catalog you
            couldn't see) and capped at 6 rows where the composer shows 200 — and it never offered
            kits at all. That divergence is exactly what "different options for new invoice vs edit
            invoice" meant, and it is why a browse-on-empty fix reached one surface and not this one. */}
        <AddLineItems
          priceItems={priceItems}
          kits={kits as never}
          markupFor={(p) =>
            effectiveMarkupPct({ levelPct: levelMarkupPct, itemPct: p.markup_pct, orgDefaultPct: defaultMarkupPct })
          }
          onAdd={(lines) =>
            start(async () => {
              for (const l of lines) {
                const res = await addInvoiceItem(invoice.id, {
                  description: l.description,
                  quantity: l.quantity,
                  unit: l.unit,
                  unit_price: l.unit_price,
                });
                if (!res?.ok) {
                  toast(res?.error ?? "Couldn't add the line item — try again.", "error");
                  return;
                }
              }
              refresh();
            })
          }
        />

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

        {isDraft &&
          (invoice.job_id || (invoice as any).quote_id) &&
          !isDrawKind((invoice as any).invoice_kind) && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-3 py-2.5">
            <span className="text-xs font-medium text-slate-500">Import:</span>
            <Button size="sm" variant="outline" onClick={() => runImport(importQuoteItemsIntoInvoice, "Estimate items", items.filter((i) => i.import_source === "quote").length, "quote")} disabled={pending}>
              From Estimate
            </Button>
            {invoice.job_id && (
              <>
                <Button size="sm" variant="outline" onClick={() => runImport(importLaborIntoInvoice, "Labor", items.filter((i) => i.import_source === "labor").length, "labor")} disabled={pending}>
                  Labor From Timecards
                </Button>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => runImport((id) => importCostsIntoInvoice(id, markup), "Materials", items.filter((i) => i.import_source === "costs").length, "costs")} disabled={pending}>
                    Materials From Costs
                  </Button>
                  <NumberInput value={markup} onValueChange={(v) => setMarkup(v)} className="h-8 w-14 text-center text-sm" aria-label="Material markup percent" />
                  <span className="text-xs text-slate-400">% markup</span>
                </div>
              </>
            )}
            {importMsg && <span className="text-xs text-slate-500">{importMsg}</span>}
            {stuckSource && (
              <span className="flex items-center gap-1.5 text-xs text-amber-700">
                Lines you edited or removed are protected, so nothing came in.
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (
                      !confirm(
                        "Start this import over? Every line from this import is removed and rebuilt from the source — including ones you edited or deleted. Hand-entered lines are untouched.",
                      )
                    )
                      return;
                    const src = stuckSource;
                    runImport(
                      (id) => reimportFromScratch(id, src, src === "costs" ? markup : undefined),
                      src === "labor" ? "Labor" : src === "costs" ? "Materials" : "Estimate items",
                      0,
                      src,
                    );
                  }}
                  className="rounded-md border border-amber-300 bg-white px-2 py-1 font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                >
                  Start it over
                </button>
              </span>
            )}
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-white">
          <ul className="divide-y divide-slate-100">
            {items.map((it) =>
              editId === it.id ? (
                <li key={it.id} className="space-y-2 bg-slate-50/80 px-4 py-3 text-sm">
                  <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description" />
                  <div className="flex items-center gap-2">
                    <NumberInput value={editQty} onValueChange={setEditQty} className="w-16 text-center" />
                    <Input
                      value={editUnit}
                      onChange={(e) => setEditUnit(e.target.value)}
                      className="w-16 text-center"
                      placeholder="unit"
                      aria-label="Unit"
                      list="cn-units"
                    />
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
                  {isDraft && items.length > 1 && (
                    <div className="flex shrink-0 flex-col">
                      <button
                        type="button"
                        onClick={() => moveItem(it.id, -1)}
                        disabled={pending || items[0]?.id === it.id}
                        className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25"
                        aria-label="Move up"
                        title="Move up"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveItem(it.id, 1)}
                        disabled={pending || items[items.length - 1]?.id === it.id}
                        className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25"
                        aria-label="Move down"
                        title="Move down"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
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
          {isDraft && items.length > 1 && (
            <div className="flex items-center justify-end border-t border-slate-100 px-3 py-2">
              <button
                type="button"
                onClick={groupByKind}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                title="Materials together, then labor — keeps the order you set inside each group"
              >
                <Layers className="h-3.5 w-3.5" /> Group materials & labor
              </button>
            </div>
          )}
          {/* The words a contractor actually bills in — suggestions, never a limit. */}
          <datalist id="cn-units">
            {["ea", "hrs", "hr", "lot", "ft", "day", "days", "sq ft", "roll", "box", "trip"].map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          {/* Add line item */}
          <div className="space-y-2 border-t border-slate-100 bg-slate-50/60 p-3">
            <Input
              placeholder="Add a line item…"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addItem()}
            />
            <div className="flex items-center gap-2">
              <NumberInput value={qty} onValueChange={setQty} className="w-16 text-center" placeholder="Qty" />
              {/* THE UNIT, TYPEABLE (Erik 8/18). "hrs" is not "ea", and a line that says the
                  wrong word is a line he has to explain to a customer. Free text with a
                  suggestion list — his trade's words are his, not a dropdown we curate. */}
              <Input
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addItem()}
                className="w-16 text-center"
                placeholder="unit"
                aria-label="Unit"
                list="cn-units"
              />
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
              {/* The picker is a DRAFT control (audit 8) — a sent invoice shows its rate as text,
                  matching every other line-item edit on this page. */}
              {taxRates.length > 0 && isDraft ? (
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
            {/* Payments record on DRAFTS too (Erik 7/24): deposits and Venmo prepayments
                arrive before the invoice goes out, and blocking them here forced a fake
                workflow. The soft note keeps the state honest; the sent invoice shows
                the money as already paid. */}
            {isDraft && (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                This invoice hasn&apos;t been sent yet — recording a prepayment (deposit,
                Venmo) is fine; it&apos;ll show as already paid when you send it.
              </p>
            )}
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
              {[...addedCustomers, ...customers].map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
            {linkJobObj?.customer_id ? (
              <p className="mt-1 text-xs text-slate-400">Set from the selected job.</p>
            ) : (
              /* Erik, on this exact modal: "ive got to be able to add a new customer or at least
                 type someones name on the invoice from here." A brand-new invoice for a brand-new
                 customer was a dead end — leave, create, come back. */
              <NewCustomerInline
                className="mt-1.5"
                onCreated={(c) => {
                  setAddedCustomers((prev) => [c, ...prev]);
                  setLinkCustomer(c.id);
                }}
              />
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
