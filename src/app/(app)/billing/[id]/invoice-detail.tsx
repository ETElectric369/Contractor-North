"use client";

import { useRef, useState, useTransition } from "react";
import { NewCustomerInline } from "@/components/new-customer-inline";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, Pencil, Check, X, ChevronUp, ChevronDown, ChevronsUp, ChevronsDown, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { invoiceBalance, invoiceOverpayment, isDrawKind } from "@/lib/invoice-math";
import { processorFeeLabel } from "@/lib/processor-fee";
import { paymentMethodKey, paymentMethodLabel } from "@/lib/payment-method";
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
  importChangeOrdersIntoInvoice,
  updatePayment,
  deletePayment,
  type ImportStats,
} from "../actions";
import { effectiveMarkupPct } from "@/lib/pricing/markup";
import { AddLineItems } from "@/components/add-line-items";
/* The same Send Invoice the verb row at the top of the page uses — one send door, not a second
   one written here. It rides inside the "they are holding an older bill" notice so the fix is
   where the problem is said, and nobody has to scroll back up hunting for it. */
import { EmailButton } from "@/components/email-button";

interface PriceItemLite { id: string; code: string | null; description: string; unit: string; buy_price: number; markup_pct: number; }
interface TaxRateLite { id: string; name: string; rate: number; is_default: boolean; }
interface CustomerLite { id: string; name: string; }
interface JobLite { id: string; name: string | null; job_number: string | null; customer_id: string | null; }

/** ISO timestamp → "YYYY-MM-DD" in local time, for a <input type=date>. */
const toDateInput = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * THE WORDS ON A LINE ROW, ONCE, SO BOTH VERSIONS OF THE ROW SAY THE SAME THING.
 *
 * A draft row wraps these in a button that opens the editor; a locked row wraps them in a plain
 * div. That fork exists because of INV-069: a whole-row button titled "Edit line item" on an
 * invoice whose lines the server will not let you touch is a promise the page cannot keep, and
 * being the biggest target in the row it was the easiest thing on the page to hit by accident.
 * Pulling the text out means the locked row can never drift from the editable one — the customer
 * sees the same line either way, and the only difference is whether it does anything.
 */
function LineRowText({ item: it }: { item: InvoiceItem }) {
  return (
    <>
      <LineItemText description={it.description} className="block font-medium text-slate-800" />
      <div className="text-xs text-slate-400">
        {it.quantity} {it.unit} × {formatCurrency(it.unit_price)}
        {/* WHERE THAT RATE CAME FROM, FOR THE OFFICE ONLY. Erik once stared at an import saying
            "still importing at 150" with nothing to tell him the number was his tech's own bill
            rate. That answer used to be appended to the line's DESCRIPTION, which is the text the
            customer receives, so it was repeating a man's full name on their invoice to explain
            something only the office needed (2026-09-18: "the rest is repetitive and
            unnecessary"). It belongs here, on the editor row, which no customer ever sees.
            Imported labor only, and only when the office is looking. */}
        {it.import_source === "labor" && <span className="ml-1 text-slate-300">· their bill rate</span>}
      </div>
    </>
  );
}

/** "Tue Sep 22, 1:37 PM" in the org's clock. */
function clockSince(iso: string, tz: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "earlier";
  const day = d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).replace(",", "");
  const t = d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
  return `${day}, ${t}`;
}

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
  customerName = null,
  customerHoldsOlderCopy = false,
  runningClocks = [],
  tz = "America/Los_Angeles",
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
  /** Who holds this bill, for the sentences about their copy of it (page.tsx owns the lookup). */
  customerName?: string | null;
  /** 0269: revised_at is later than sent_at — the bill in their hands is not this one. Decided by
   *  lib/invoice-revision.ts on the server, never re-derived here. */
  customerHoldsOlderCopy?: boolean;
  /** Shifts still running on this invoice's job (page.tsx reads them). Their hours bill nothing
   *  until somebody stops the clock, so the card says so. */
  /** `door` is the trigger's words ("Clock Out Brian"; "Clock Out" on the viewer's own clock). */
  runningClocks?: { id: string; clockIn: string; name: string; self?: boolean; door: string }[];
  /** The org's timezone, for the "since" time on a running clock. */
  tz?: string;
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
  /* ONE NAME FOR THE WHOLE CARD, NOT FOUR MEMORIES (INV-069, 2026-09-18).
   *
   * Erik pressed Pay Now on a $6,412.64 draft he was still building. The card door promoted the
   * row to 'sent' the instant it opened, and told his page nothing — so he sat looking at a Draft
   * badge and live draft controls on an invoice the database had already locked. He tapped the
   * trash on a "Beverage Bottle Dep 0.10" line and got back "This invoice has already been sent,
   * so its lines are locked." His answer: "its not sent its in draft mode thats partially why
   * this is confusing."
   *
   * The server's refusal was right. The dead end was ours. `isDraft` was hand-applied per JSX
   * block, which meant the line row below gated its up/down chevrons and forgot the three
   * controls sitting beside them — the description button, the pencil, the trash. Four siblings,
   * one remembered. That is not a bug you fix four times; it is a bug you stop being able to
   * write. So the line-items card now speaks ONE word, `linesLocked`: the row's entire control
   * cluster lives inside a single gate, the add form and the picker read the same flag, and
   * `editingId` is DERIVED from it rather than trusted, so a status that changes under an open
   * page closes the editor instead of stranding what was typed in it. Adding a fifth control to
   * that row inherits the gate; it cannot be forgotten, because there is nothing to remember.
   *
   * WHAT THE WORD MEANS CHANGED THE VERY NEXT NIGHT (cn-v962, migration 0269). The gate stayed.
   * Its rule did not. It read `!isDraft`, and Erik overruled that outright: "even if i did sent it
   * ill always need to be able to go back and make changes as per a client's request or my own
   * review catches errors." The same night proved him right twice — a client emailed asking that a
   * PAID invoice carry the property owner's name instead of the agent's (he is only the agent),
   * and the invoice that started INV-069 had Erik's own Smartwater on it, caught on review.
   * Contractors revise bills; an app that forbids it isn't protecting anyone, it just gets fought.
   *
   * What the old refusal actually guarded is narrower than it was written: a bill changing without
   * the customer ever learning it changed. So the lock comes off and the RECORD goes on. VOID is
   * the one state still locked, because nothing bills off a voided document. Everything else is
   * open, the server stamps `revised_at` (0269) when money moves on a delivered invoice, and the
   * card says out loud that the copy in their inbox is older than this one — with Send Invoice
   * right there. Nothing silent, which is the whole trade.
   *
   * `isDraft` keeps only the blocks that are still genuinely draft-only, each for a reason the
   * server holds: park (an unsent bill waiting on an approval), the customer/job link (re-pointing
   * a delivered invoice moves its payments and job costs onto someone else, which is a different
   * act from correcting what the bill says) and the import row (an import BUILDS a bill; it is a
   * delete-and-rebuild of a whole line group, not an edit). The tax rate is NOT one of them any
   * more — it is a line-level money edit, it follows `linesLocked`, and the totals card says so.
   */
  const linesLocked = invoice.status === "void";
  /* 0267's sent_at: stamped ONLY where a bill really reached the customer. INV-069 carries NULL
   * here because no card was ever tapped, and that difference is the whole point — an invoice
   * that merely left Draft must not be told it went out, and it must not be trapped out of Draft
   * by the owner's own $200 deposit. Mirrors the server rule: Draft is refused only when money is
   * on it AND it actually went to the customer. */
  const sentAt = (invoice as { sent_at?: string | null }).sent_at ?? null;
  const wasDelivered = !!sentAt;
  const canReturnToDraft = !(Number(invoice.amount_paid ?? 0) > 0 && wasDelivered);
  /* 0269's revised_at, for the DATES this card prints. The DECISION it prints them under is not
   * made here: `customerHoldsOlderCopy` arrives as a prop, decided by the one function that also
   * governs the server's stamp (lib/invoice-revision.ts, which is server-only and cannot be
   * imported into a client component). Re-deriving `revised_at > sent_at` here would be a second
   * copy of the rule living three feet from the first — the exact shape of the draft gate this
   * wave just spent a day untangling, where one of the nine copies was wrong for months. */
  const revisedAt = (invoice as { revised_at?: string | null }).revised_at ?? null;
  /** The customer, by name, in the sentences about what they are holding. */
  const who = customerName?.trim() || "The customer";

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
  /** Enter was pressed on a line with no description. Add is greyed out for that reason, and a
   *  greyed-out button cannot say why on its own (INV-073, Erik 2026-09-22). */
  const [descAsked, setDescAsked] = useState(false);
  const needsDesc = !desc.trim() && (price !== 0 || qty !== 1 || descAsked);

  // payment state

  // import state
  const [importMsg, setImportMsg] = useState<string | null>(null);
  /** Money the last import left for a person to decide (an edited tax row behind its parts). */
  const [importWarn, setImportWarn] = useState<string | null>(null);
  /** An import that could not touch ANYTHING — every line edited, or the deleted ones tombstoned.
   *  Naming the source arms the "start over" button beside the message (0204). */
  const [stuckSource, setStuckSource] = useState<"labor" | "costs" | "quote" | "change_orders" | null>(null);
  /** A draft deliberately waiting — leaves Needs action until this date (0206). */
  const [hold, setHold] = useState<string>((invoice as { hold_until?: string | null }).hold_until ?? "");
  const [markup, setMarkup] = useState(materialMarkup); // material markup % for the costs import
  /* ON-THE-SPOT AGAIN — safely this time. The old debounced auto-reprice was removed because the
     import was a delete-and-rebuild that silently wiped hand edits (the "force feeding"). Since
     0175 it's an UPSERT that never touches an edited line, so committing a new number here
     (Enter, or leaving the box) re-prices only the machine-priced cost lines and the toast says
     exactly what happened. Nothing fires while typing, and an unchanged number is a no-op. */
  const appliedMarkupRef = useRef(materialMarkup);
  function applyMarkup() {
    if (pending || markup === appliedMarkupRef.current) return;
    appliedMarkupRef.current = markup;
    if (!items.some((i) => (i as { import_source?: string | null }).import_source === "costs")) return;
    runImport((id) => importCostsIntoInvoice(id, markup), "Materials", 0, "costs", false);
  }
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
    sourceKey: "labor" | "costs" | "quote" | "change_orders" | null = null,
    askFirst = true,
  ) {
    if (replacing > 0 && askFirst) {
      // Truthful since 0175 (imports became additive): hand-edited lines are NEVER overwritten —
      // the old text threatened exactly that and scared people off a safe refresh.
      const ok = confirm(
        `Re-import ${label.toLowerCase()}?\n\n` +
          `This refreshes the ${replacing} ${label.toLowerCase()} line${replacing === 1 ? "" : "s"} ` +
          `already on ${invoice.invoice_number} from whatever the job holds right now. ` +
          `Lines you edited by hand are kept exactly as you set them; anything added to the job since is pulled in.\n\n` +
          `Current total: ${formatCurrency(Number(invoice.total))}`,
      );
      if (!ok) return;
    }
    setImportMsg(null);
    setImportWarn(null);
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
      const st = (res as { stats?: Partial<ImportStats> }).stats;
      const lines = st
        ? [
            st.inserted ? `${st.inserted} added` : "",
            st.updated ? `${st.updated} updated` : "",
            st.kept_edited ? `${st.kept_edited} of your edits kept` : "",
            st.removed ? `${st.removed} removed` : "",
          ].filter(Boolean).join(" · ")
        : "";
      // THE CLAIM HALF OF THE SENTENCE (0255). `summary` is the importer's own account of the
      // source rows — "5 time entries pulled in · 9 already on INV-061 skipped" — and it is the
      // only place the office learns that this run deliberately LEFT work on another invoice.
      // Without it a labor import that skipped every claimed hour read as "nothing changed",
      // which is the exact sentence that sends someone hunting for a bug (or re-billing by hand
      // what INV-061 already carries). Source sentence first, the line counters after it.
      const said = [st?.summary, lines].filter(Boolean).join(" · ") || (st ? "nothing changed" : "");
      // "nothing changed" is the sentence that sent Erik looking for a bug (8/18). When an
      // import genuinely can't touch anything — every line edited, or the ones he deleted are
      // tombstoned — say WHY, and put the way out right next to it. "Stuck" means the run HAD
      // rows to land (pulled_in > 0) and the RPC could place none of them; a run that had nothing
      // free to pull — the source is empty, or another invoice claims all of it — is not stuck,
      // its summary already says why, and arming Start It Over would only offer to rebuild
      // nothing. Stats from before 0255 carry no pulled_in, so they keep the old rule.
      const stuck = !!st && !st.inserted && !st.updated && !st.removed && (st.pulled_in == null || st.pulled_in > 0);
      setStuckSource(stuck ? sourceKey : null);
      setImportMsg(said ? `${label}: ${said}.` : `${label} imported.`);
      // "3 of your edits kept" was the whole story on INV-074 while its edited tax rows sat at the
      // old markup. The warning rides in the toast, and stays under the import row until the next
      // import, because a toast is gone before a sentence with two dollar figures can be read.
      const warn = (st?.warnings ?? []).join(". ");
      setImportWarn(warn || null);
      // A money warning is not good news: it rides an info toast, never the green one.
      toast(`${said ? `${label}: ${said}` : `${label} imported`}${warn ? `. ${warn}` : ""}`, warn ? "info" : "success");
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
  // Settings' methods, one per stored key ("Cash" and "cash" in Settings are one option).
  const editMethods = paymentMethods.filter(
    (m, i) => paymentMethods.findIndex((o) => paymentMethodKey(o) === paymentMethodKey(m)) === i,
  );
  const editMethodKeys = new Set(editMethods.map(paymentMethodKey));

  // edit-item state
  const [editId, setEditId] = useState<string | null>(null);
  /** WHICH ROW IS ACTUALLY IN EDIT MODE — derived, never the raw state. If the invoice stops being
   *  a draft while this page is open (INV-069: Pay Now promoted it mid-edit), an open editor would
   *  otherwise keep offering a Save that updateInvoiceItem can only refuse — and saveEdit clears
   *  editId only on res.ok, so that refusal left everything he had typed stranded on screen with
   *  no way back out of the form. Deriving it means the form closes with the lock, and the Save,
   *  Move to Top and Move to Bottom buttons inside it are gated by the same single decision. */
  const editingId = linesLocked ? null : editId;
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


  function addItem() {
    if (!desc.trim()) {
      setDescAsked(true);
      return;
    }
    setDescAsked(false);
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
  /* ONE TAP TO THE EDGE. Erik added a referral line, wanted it first, and the only road was the
     single-step chevron — "without having to hit the arrow and follow it 65 times or whatever."
     Same one-call reorder grammar as groupByKind: compute the whole order, send it once. */
  function moveToEdge(id: string, edge: "top" | "bottom") {
    const rest = items.map((i) => i.id).filter((x) => x !== id);
    const ids = edge === "top" ? [id, ...rest] : [...rest, id];
    start(async () => {
      const res = await reorderInvoiceItems(invoice.id, ids);
      if (!res?.ok) { toast(res?.error ?? "Couldn't move that line — try again.", "error"); return; }
      setEditId(null);
      toast(edge === "top" ? "Moved to the top" : "Moved to the bottom", "success");
      refresh();
    });
  }

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
    // LABOR LEADS. Erik: "it sent all the labor down to the bottom when it should all go to the
    // top" — the story of an invoice starts with the work done, then what it took; credits stay
    // last. Order inside each group is untouched.
    const rank = (it: (typeof items)[number]) => {
      const src = (it as { import_source?: string | null }).import_source;
      const d = it.description ?? "";
      if (src === "draw_credit" || /less previous billings/i.test(d)) return 3;
      if (src === "labor" || /^labor — /i.test(d)) return 0;
      if (src === "costs" || /^materials — /i.test(d)) return 1;
      return 2;
    };
    /* HAND-ADDED LINES STAY WHERE THE HAND PUT THEM. Grouping is about the imported piles;
       a line a person typed and placed (a referral he moved to the top) must not get re-sunk
       to "everything else" every time the button is pressed. Pinned = no import_source. */
    const entries = items.map((it, i) => ({ it, i }));
    const pinned = (e: (typeof entries)[number]) => !(e.it as { import_source?: string | null }).import_source;
    const movable = entries.filter((e) => !pinned(e)).sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i);
    const ids: string[] = new Array(items.length);
    for (const e of entries) if (pinned(e)) ids[e.i] = e.it.id;
    let mi = 0;
    for (let i = 0; i < ids.length; i++) if (!ids[i]) ids[i] = movable[mi++].it.id;
    start(async () => {
      const res = await reorderInvoiceItems(invoice.id, ids);
      if (!res?.ok) { toast(res?.error ?? "Couldn't group the lines — try again.", "error"); return; }
      toast("Grouped — labor first, then materials", "success");
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
              /* "SENT AGAIN" IS A DEED YOU DECLARE, NOT A STATE THE BILL IS IN — AND A <select>
                 COULD NOT TELL THE TWO APART (INV-071, 2026-09-20).
                 The declaration below used to carry value="sent", the same value the locked
                 current-status option carries once the invoice really is sent. A browser resolves
                 a select's value by the FIRST option in tree order that matches it, and the
                 declaration sits above the status, so on any bill that went out and was then
                 revised the CLOSED dropdown read "Sent Again - I re-sent it myself" as though the
                 corrected copy were already in Karen Wucher's hands. Three inches below, the amber
                 banner was asking him to go do that exact thing. The picker said done; the banner
                 said not done; only one of them was right.
                 Two options sharing a value broke the declaration as well as the label: picking
                 the one the browser already considers selected fires no change event, so the
                 re-send was a no-op. The door therefore gets its own value and is translated back
                 here, one line from the option, because the server accepts only real statuses
                 (setInvoiceStatus's whitelist) and its cn-v962 `redelivered` branch keys off
                 "sent". Everything past this line still sees the status, never the door. */
              const next = e.target.value === "sent-by-hand" ? "sent" : e.target.value;
              start(async () => {
                const res = await setInvoiceStatus(invoice.id, next);
                if (!res?.ok) { toast(res?.error ?? "Couldn't change the status — try again.", "error"); return; }
                toast(next === "void" ? "Invoice voided" : next === "sent" ? "Marked as sent" : "Status updated", "success");
                refresh();
              });
            }}
          >
            {/* BACK TO DRAFT, ONLY WHEN IT IS REALLY ON OFFER (INV-069). This option used to
                render unconditionally and the server refused it whenever a payment existed, so
                Erik's own $200 deposit had become the lock on his own half-built invoice: the
                one control that would have fixed everything was right there, and it could only
                ever say no. It now matches the server rule exactly — refused only when money is
                on the invoice AND it actually went to the customer (sent_at). `isDraft ||` keeps
                the option present when it is the selected value. */}
            {(isDraft || canReturnToDraft) && <option value="draft">Draft</option>}
            {/* Escape hatch: you sent the PDF yourself (texted/AirDropped/emailed it OUTSIDE
                the app), so record that it went out — the invoice leaves Draft and the job
                reads as invoiced without forcing you back through the Send button.

                IT HAS A SECOND JOB NOW, AND THE SERVER ALREADY DOES IT (cn-v962, caught by two
                reviewers). setInvoiceStatus computes `redelivered` so that re-declaring Sent on a
                revised bill moves the delivery stamp forward and clears the "they're holding an
                older copy" notice. That branch was unreachable: this option only rendered on a
                draft, and a revised bill is never a draft. So a person who fixed a line and then
                handed the customer the new copy by hand had no way to tell the app, and the
                notice would have nagged forever — a banner you cannot clear by doing what it
                asks. It now appears in exactly the two cases the server accepts, with the words
                that match what each one does. */}
            {(invoice.status === "draft" || customerHoldsOlderCopy) && (
              /* ITS OWN VALUE, NEVER A STATUS'S. Both labels name a deed the person is declaring,
                 and the option that shows what the invoice IS is the disabled one below. Give this
                 one the same value and the browser picks whichever comes first in the file, which
                 is how a sent-and-revised bill ended up describing itself as re-sent. Translated
                 back to "sent" in the onChange above. */
              <option value="sent-by-hand">
                {invoice.status === "draft" ? "Sent - I sent it myself" : "Sent Again - I re-sent it myself"}
              </option>
            )}
            {/* Keep the current status visible even though it isn't a manual choice. */}
            {!["draft", "void"].includes(invoice.status) && (
              <option value={invoice.status} disabled>
                {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
              </option>
            )}
            <option value="void">Void</option>
          </Select>
          {/* Taking the choice away silently is the same dead end wearing a different coat, so
              when Draft is gone, say why it is gone — and since cn-v962, say the thing that makes
              it not matter. The old sentence sent him to Credit / Refund as if the missing Draft
              meant the bill was finished; it never did, and now the lines below are simply open. */}
          {!isDraft && !canReturnToDraft && (
            <span className="text-xs text-slate-400">
              This one is with the customer and has money on it, so it can&rsquo;t go back to Draft. You
              don&rsquo;t need Draft to fix it: change the lines below, then send it again.
            </span>
          )}
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
        {/* Open at every live status since cn-v962. It is hidden only on a VOID invoice, where
            addInvoiceItem can still only refuse — a catalog you can browse, price, tick and submit
            whose one possible ending is a red toast is the dead end, not the lock. */}
        {!linesLocked && (
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

        {/* A CLOCK STILL RUNNING ON THIS JOB (2026-09-24): its hours are not on this invoice, and
            nothing used to say so. One line per clock, with the way to stop it at the real time. */}
        {runningClocks.length > 0 && (
          <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
            {runningClocks.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  {c.self ? "You're" : `${c.name} is`} still on the clock on this job since {clockSince(c.clockIn, tz)}. Those
                  hours are not on this invoice until the clock is stopped.
                </span>
                <Link
                  href={`/timecards?entry=${c.id}`}
                  className="inline-flex h-11 shrink-0 items-center rounded-lg border border-amber-400 bg-white px-4 text-sm font-medium text-amber-900 hover:bg-amber-100"
                >
                  {c.door}
                </Link>
              </div>
            ))}
          </div>
        )}

        {/* THE IMPORT ROW FOLLOWS THE SERVER, NOT THE OLD DRAFT HABIT (cn-v962 review). All four
            importers moved from requireDraftInvoice to requireLiveInvoice in this wave, on the
            argument that the 0255 claims - not the status - are what stop an hour or a bill being
            charged twice. This row stayed on `isDraft`, so none of that was reachable and the two
            halves disagreed in silence. It is also the tool Erik actually needs on a delivered
            bill: labor he forgot, a change order signed after the invoice went out. Same word as
            the rest of the card. */}
        {!linesLocked &&
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
                  Labor from Timecards
                </Button>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => runImport((id) => importCostsIntoInvoice(id, markup), "Materials", items.filter((i) => i.import_source === "costs").length, "costs")} disabled={pending}>
                    Materials from Costs
                  </Button>
                  <span onBlur={applyMarkup} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLElement).blur(); }}>
                    <NumberInput value={markup} onValueChange={(v) => setMarkup(v)} className="h-8 w-14 text-center text-sm" aria-label="Material markup percent" />
                  </span>
                  <span className="text-xs text-slate-400">% markup</span>
                </div>
                {/* APPROVED EXTRAS. Until now a change order's amount was read by nothing in the
                    app — you could raise one, get it signed, mark it approved, and the money
                    never appeared on any invoice. Same importer contract as the two above:
                    idempotent, draft-only, and it never overwrites a line the office edited. */}
                <Button size="sm" variant="outline" onClick={() => runImport(importChangeOrdersIntoInvoice, "Change orders", items.filter((i) => i.import_source === "change_orders").length, "change_orders")} disabled={pending}>
                  Approved Change Orders
                </Button>
              </>
            )}
            {importMsg && <span className="text-xs text-slate-500">{importMsg}</span>}
            {importWarn && <span className="text-xs text-amber-700">{importWarn}.</span>}
            {/* START IT OVER IS STILL DRAFT-ONLY, AND THAT ONE IS NOT OURS TO OPEN. Its refusal
                lives inside the SECURITY DEFINER function reset_import_source (migrations
                0204/0212/0223), which still raises on a non-draft invoice in a Postgres voice no
                screen here can soften. Offering the button on a sent bill would be the dead end
                this wave exists to delete, so on a delivered invoice the sentence says what to do
                instead - the ordinary controls, which now work. */}
            {stuckSource && !isDraft && (
              <span className="text-xs text-amber-700">
                Lines you edited or removed are protected, so nothing came in. On a bill that has
                already gone out, change the lines directly instead.
              </span>
            )}
            {stuckSource && isDraft && (
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
                  Start It Over
                </button>
              </span>
            )}
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-white">
          {/* WHAT THE CUSTOMER IS HOLDING, SAID WHERE THE EDITING HAPPENS (cn-v962, 0269).
              The lock is off these lines, so this notice is what stands in its place: a revision is
              allowed, and it is never silent. It reads off sent_at, NEVER status — a pay door can
              promote a row to 'sent' without a customer ever seeing it (0267), and telling Erik
              that the draft he is still building is "with the customer" would be the INV-069 lie in
              a new costume. Nobody has it, so it says nothing at all. */}
          {!linesLocked && wasDelivered && (
            customerHoldsOlderCopy ? (
              <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-amber-900">
                    {who} is holding an older bill than this one. Send it again so they have what you see.
                  </p>
                  {/* The two stamps, because "older" is a claim and these are the facts behind it. */}
                  <p className="mt-0.5 text-xs text-amber-700">
                    Sent {formatDateTime(sentAt)} · changed {formatDateTime(revisedAt)}
                  </p>
                </div>
                {/* The fix, in reach of the problem. */}
                <EmailButton
                  id={invoice.id}
                  kind="invoice"
                  customerName={customerName}
                  amount={Number(invoice.total)}
                />
              </div>
            ) : (
              <p className="border-b border-slate-100 bg-slate-50/60 p-3 text-sm text-slate-500">
                {who} has this bill already. Change anything here and their copy is older than yours, so send
                it again when you&rsquo;re done.
              </p>
            )
          )}
          <ul className="divide-y divide-slate-100">
            {items.map((it) =>
              editingId === it.id ? (
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
                  {items.length > 2 && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => moveToEdge(it.id, "top")}
                        disabled={pending || items[0]?.id === it.id}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                      >
                        <ChevronsUp className="h-3.5 w-3.5" /> Move to Top
                      </button>
                      <button
                        type="button"
                        onClick={() => moveToEdge(it.id, "bottom")}
                        disabled={pending || items[items.length - 1]?.id === it.id}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                      >
                        <ChevronsDown className="h-3.5 w-3.5" /> Move to Bottom
                      </button>
                    </div>
                  )}
                </li>
              ) : (
                <li key={it.id} className="group flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-slate-50">
                  {/* THE ROW'S TEXT IS A FORK, NOT A GATE. On a VOID invoice the same words sit
                      in a plain <div>: it reads identically, it just isn't a promise. A button
                      titled "Edit line item" whose only possible ending is a refusal is the
                      dead end Erik walked into, and the whole-row target made it the easiest
                      thing on the page to hit by accident. Since cn-v962 void is the only status
                      that takes this branch; a sent or paid bill gets the real button back. */}
                  {linesLocked ? (
                    <div className="min-w-0 flex-1">
                      <LineRowText item={it} />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startEdit(it)}
                      disabled={pending}
                      className="min-w-0 flex-1 cursor-pointer text-left"
                      title="Edit line item"
                    >
                      <LineRowText item={it} />
                    </button>
                  )}
                  <div className="shrink-0 font-medium text-slate-900">{formatCurrency(it.line_total)}</div>
                  {/* ONE GATE FOR THE WHOLE CLUSTER. These three controls call reorderInvoiceItems,
                      updateInvoiceItem and deleteInvoiceItem. They used to be gated one at a time,
                      and only the chevrons ever got the gate; the trash Erik pressed never did. A
                      fourth control added here is gated by construction — which is the point, and
                      it is why moving the rule from "draft" to "void" was a one-line change here
                      instead of four blocks to remember. */}
                  {!linesLocked && (
                    <>
                      {items.length > 1 && (
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
                    </>
                  )}
                </li>
              ),
            )}
            {items.length === 0 && (
              <li className="px-4 py-6 text-center text-slate-400">
                {/* A blank invoice has no amount box of its own: the amount is a line. Say where
                    that line is typed, since on a phone it sits below the price list. */}
                {linesLocked ? "No line items yet." : "No line items yet. Type one in the row below, with its price, then tap Add."}
              </li>
            )}
          </ul>
          {/* Reordering is a line control like the chevrons beside it, so it follows the same
              word. Leaving this one on `isDraft` after the unlock would have meant the arrows
              worked on a sent bill and the tidy button silently didn't exist. */}
          {!linesLocked && items.length > 1 && (
            <div className="flex items-center justify-end border-t border-slate-100 px-3 py-2">
              <button
                type="button"
                onClick={groupByKind}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                title="Labor first, then materials — lines you added by hand stay where you put them"
              >
                <Layers className="h-3.5 w-3.5" /> Group Materials & Labor
              </button>
            </div>
          )}
          {/* The words a contractor actually bills in — suggestions, never a limit. */}
          <datalist id="cn-units">
            {["ea", "hrs", "hr", "lot", "ft", "day", "days", "sq ft", "roll", "box", "trip"].map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          {/* THE ADD FORM IS BACK ON EVERY LIVE INVOICE (cn-v962). For one day this spot held a
              sentence telling Erik his sent bill was finished and to set the status back to Draft
              if he wanted to touch it. Both halves died with the lock: a delivered bill is not
              finished, and Draft is not the road back — the lines above are simply open, and the
              notice at the top of this card says what that costs the customer's copy.
              Void keeps its refusal, and the refusal names a door that exists (a new invoice) —
              the rule the old "record an adjustment" sentence broke by sending people after a
              feature this app has never had. */}
          {linesLocked ? (
            <div className="border-t border-slate-100 bg-slate-50/60 p-4 text-sm text-slate-500">
              {/* The same two doors the server's own refusal names (invoiceLineEditRefusal), in the
                  same order, so reading the page and tripping the guard never tell two stories. */}
              <p>
                This invoice is void, so its lines are set. If you voided it by mistake, set the status back
                at the top of the page. To bill this work, start a new invoice.
              </p>
            </div>
          ) : (
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
            {needsDesc && (
              <p className="text-xs text-amber-700">Type what this charge is for in the box above, then tap Add.</p>
            )}
          </div>
          )}
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
              {/* THE TAX RATE IS A LINE-LEVEL EDIT AND IT FOLLOWS THE SAME WORD (cn-v962).
                  Audit 8 made this picker draft-only because a mis-tap on a PAID invoice silently
                  re-totalled it. SILENTLY was the load-bearing half: setInvoiceTaxRate now takes any
                  live invoice and stamps the revision (0269), so a job billed at the wrong county
                  rate is an ordinary correction again. Leaving it on `isDraft` after that would be
                  the other kind of dead end — a control the server would happily accept, hidden
                  with no way forward offered, on a page whose whole left column just unlocked.
                  Void still shows the rate as plain text, which refuses nothing. */}
              {taxRates.length > 0 && !linesLocked ? (
                <Select
                  className="h-8 w-44 text-xs"
                  // Match with a tolerance a stored fraction can actually hit (0243 widened the column to
                  // numeric(8,6)); 1e-9 demanded an exactness the DB never promised, so a taxed draft
                  // at a 3-decimal rate read "No tax" and a re-save could zero it (audit v921).
                  value={taxRates.find((t) => Math.abs(Number(t.rate) / 100 - Number(invoice.tax_rate)) < 5e-7)?.id ?? ""}
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
            {/* TAKING A LINE OFF A PAID BILL LEAVES THEM OVERPAID, AND NOTHING SAID SO (cn-v962
                review). This is Erik's own case, one step on: delete the Smartwater lines from an
                invoice the customer already settled and the total drops below what they handed
                over. paidStatus keeps the status 'paid' (paid >= total) and invoiceBalance floors
                at zero, so the card read Total $495 / Paid $500 / Balance due $0.00 and the five
                dollars he now owes back appeared nowhere at all. That is the silence this whole
                wave traded the edit lock for, so it has to be said out loud, with the door that
                settles it. Credit / Refund is the literal label in the Actions menu. */}
            {invoiceOverpayment(invoice.total, invoice.amount_paid) > 0.005 && (
              <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                They have paid {formatCurrency(invoiceOverpayment(invoice.total, invoice.amount_paid))} more than this
                bill now asks for. Settle it with Credit / Refund in the Actions menu at the top.
              </div>
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
                        {/* The value is the stored KEY (0287); the text is what Settings calls it.
                            Keep the stored method selectable even if no configured one maps to it. */}
                        {payEditMethod && !editMethodKeys.has(paymentMethodKey(payEditMethod)) && (
                          <option value={payEditMethod}>{paymentMethodLabel(payEditMethod)}</option>
                        )}
                        {editMethods.length ? (
                          editMethods.map((m) => <option key={paymentMethodKey(m)} value={paymentMethodKey(m)}>{m}</option>)
                        ) : (
                          <option value="check">Check</option>
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
                      <div className="text-xs text-slate-400">
                        {paymentMethodLabel(p.method)}
                        {p.note ? ` · ${p.note}` : ""}
                      </div>
                      {/* What Stripe took for an online payment (0284), once it is known. Staff
                          only: this screen is the office's, and no customer page reads the column. */}
                      {p.stripe_payment_intent && p.processor_fee != null && (
                        <div className="text-xs text-slate-400">
                          {processorFeeLabel(p.method)} {formatCurrency(Number(p.processor_fee))}
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-slate-400">
                      {formatDateTime(p.paid_at)}
                    </span>
                    <button
                      onClick={() => {
                        setPayEditId(p.id);
                        setPayEditAmount(Number(p.amount));
                        setPayEditMethod(paymentMethodKey(p.method));
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
          saveLabel="Save"
        />
      </Modal>
    </div>
  );
}
