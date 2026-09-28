"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { NewCustomerInline } from "@/components/new-customer-inline";
import { useRouter } from "next/navigation";
import { taxFieldShown } from "@/lib/sales-tax-switch";
import Link from "next/link";
import { Plus, Trash2, Pencil, Check, X, ChevronsUp, ChevronsDown, Layers, PackagePlus, CalendarClock, Ban, Undo2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { customerLineWords, invoiceBalance, invoiceOverpayment, isDrawKind, supplierNameSet, storedLineKind } from "@/lib/invoice-math";
import { LineKindChips } from "./line-kind-chips";
import { processorFeeLabel } from "@/lib/processor-fee";
import { markupBoxApplied, markupBoxOnSeed, markupBoxStart, markupBoxTyped, markupBoxWords, materialsImportPlan, type MarkupSeed } from "@/lib/invoice-markup";
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
import { AddLineItems } from "@/components/add-line-items";
/* The same Send sheet the header's Send and the ⋯ Send Again open (W1-26) — one send door, not a
   second one written here. It rides inside the "they are holding an older bill" notice so the fix is
   where the problem is said, and nobody has to scroll back up hunting for it. */
import { SendButton } from "@/components/send-sheet";
import { ACTIONS_NOTE_CLS, ACTIONS_ROW_CLS } from "@/components/section-actions-menu";
import { bringInNewWorkSteps, bringInSentence, BRING_IN_NEW_WORK, type BringInOutcome, type BringInStep } from "@/lib/actuals-draw";
import { invoiceStatusItems, statusToSend } from "@/lib/nav-tree";
import { todayStrInTz } from "@/lib/tz";
import { embeddedJob, isFinishedJobStatus } from "@/lib/action-items/due-filters";
import { MarkupBox } from "./markup-box";

interface PriceItemLite { id: string; code: string | null; description: string; unit: string; buy_price: number; markup_pct: number; }
interface TaxRateLite { id: string; name: string; rate: number; is_default: boolean; }
interface CustomerLite { id: string; name: string; }
interface JobLite { id: string; name: string | null; job_number: string | null; customer_id: string | null; }

/** ISO timestamp → "YYYY-MM-DD" in local time, for a <input type=date>. A plain date column
 *  (due_date is `date`) is already that, and goes through untouched: `new Date("2026-10-08")` is
 *  UTC midnight, which in California is Oct 7, so the box showed a day before the header's
 *  "Due Oct 8" (INV-078, 2026-09-24) and a Save from it moved the date back a day. */
const toDateInput = (iso?: string | null) => {
  if (!iso) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
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
/** What the office is told about a line that the customer never sees (audit v994 PL1/PL2). */
type LineNotes = { suppliers: ReadonlySet<string>; noBillRate: ReadonlySet<string> };

/** The person a labor line bills: its key is `labor:<personId>` (or a legacy `labor:<personId>:2`, from
 *  before new hours joined the person's own line - lib/labor-offer). */
function laborPersonId(importKey: unknown): string | null {
  const m = /^labor:([^:]+)/.exec(String(importKey ?? ""));
  return m ? m[1] : null;
}

function LineRowText({ item: it, notes }: { item: InvoiceItem; notes?: LineNotes }) {
  const row = it as InvoiceItem & { import_key?: string | null; edited?: boolean | null };
  // THE CUSTOMER'S WORDS, SAID TO THE OFFICE. This row keeps the supplier's name (it is how the
  // line is traced back to its paper); every customer door prints the same line as "Materials"
  // (customerLineWords). Said here so the two never surprise each other.
  const customerWords = notes ? customerLineWords(row, notes.suppliers) : String(it.description ?? "");
  const reworded = customerWords !== String(it.description ?? "");
  const person = it.import_source === "labor" ? laborPersonId(row.import_key) : null;
  const unrated = !!person && !!notes?.noBillRate.has(person);
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
        {/* NEVER THEIR PAY RATE (audit v994 PL2, Erik's law). Someone with no bill rate is billed
            at the customer's level rate or the default labor rate, and the row says which kind
            of number it is, so nobody reads it as that person's own rate. */}
        {it.import_source === "labor" &&
          (unrated ? (
            <span className="ml-1 font-medium text-amber-700">· No bill rate set - imports bill the level or default rate (set one on the Team page)</span>
          ) : (
            <span className="ml-1 text-slate-300">· their bill rate</span>
          ))}
        {reworded && <span className="ml-1 text-slate-400">· the customer reads “{customerWords}”</span>}
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
  markupSeed = { pct: 0, source: "usual", usualPct: 0 },
  levelMarkupPct = null,
  defaultMarkupPct = 0,
  customers = [],
  jobs = [],
  customerName = null,
  customerHoldsOlderCopy = false,
  runningClocks = [],
  importMode,
  importHeld = null,
  textReady = true,
  supplierNames = [],
  noBillRateIds = [],
  tz = "America/Los_Angeles",
  salesTax = true,
  netDays = 30,
  estimateIsContract,
}: {
  invoice: Invoice;
  items: InvoiceItem[];
  payments: Payment[];
  priceItems?: PriceItemLite[];
  kits?: { id: string; name: string; kit_items: unknown[] }[];
  taxRates?: TaxRateLite[];
  paymentMethods?: string[];
  /** Where the % box starts, and why (page.tsx: lib/invoice-markup-read + markupBoxSeed). */
  markupSeed?: MarkupSeed;
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
  /** What the Import row may offer (page.tsx decides, lib/actuals-draw): "standard" = every import;
   *  "actuals" = a draw built from actuals, refreshed like an invoice (no From Estimate); "none" = a
   *  draw billing a slice of the contract. Absent = by kind, the rule before J-011. */
  importMode?: "standard" | "actuals" | "none";
  /** Why an actuals draw's Import row is closed (a deposit not yet taken off a bill) - said where
   *  the row would be. */
  importHeld?: string | null;
  /** Shifts still running on this invoice's job (page.tsx reads them). Their hours bill nothing
   *  until somebody stops the clock, so the card says so. */
  /** `door` is the trigger's words ("Clock Out Brian"; "Clock Out" on the viewer's own clock). */
  runningClocks?: { id: string; clockIn: string; name: string; self?: boolean; door: string }[];
  /** Can this org text (lib/sms-readiness)? The resend chip's Text door reads it before it promises. */
  textReady?: boolean;
  /** The org's supplier names: a line naming one says what the customer reads instead (PL1). */
  supplierNames?: string[];
  /** Who has no bill rate (profile_pay): their labor line says it was billed at the level or
   *  default rate, never their pay (PL2). */
  noBillRateIds?: string[];
  /** The org's timezone, for the "since" time on a running clock. */
  tz?: string;
  /** The Sales Tax switch (0352). Off: an untaxed invoice draws no tax row. Absent = on. */
  salesTax?: boolean;
  /** The company's terms in days (lib/invoice-due netTermsDays): "Due Oct 8 · Net 14", and on an
   *  untouched draft "Due 14 days after you send it" - the date the first send stamps (W1-27). */
  netDays?: number;
  /** The invoice's job bills its estimate as the contract (estimateIsTheContract), for what Bring In
   *  New Work runs. undefined = not asked; null = the job couldn't be read (lib/actuals-draw). */
  estimateIsContract?: boolean | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const refresh = () => router.refresh();
  const lineNotes = useMemo<LineNotes>(
    () => ({ suppliers: supplierNameSet(supplierNames), noBillRate: new Set(noBillRateIds) }),
    [supplierNames, noBillRateIds],
  );

  const balance = invoiceBalance(invoice.total, invoice.amount_paid);

  /* THE DESCRIPTION SAVES ITSELF (W1-27, the NOT-annoying rule: no save game). 800 ms after the
     typing stops, and on leaving the box, with "Saving…" then "Saved" beside the label - and a red
     "Didn't Save · Try Again" that stays until a save lands, never a quiet loss. Only text that
     really changed is sent: every write to a delivered bill stamps revised_at (0269) and raises the
     holding-an-older-copy notice, so an unchanged blur must write nothing. One save at a time; the
     text typed during one goes next. */
  const [descr, setDescr] = useState((invoice as any).description ?? "");
  const descrSavedText = useRef<string>((invoice as any).description ?? "");
  const [descrState, setDescrState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const descrTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const descrBusy = useRef(false);
  const descrLatest = useRef<string>(descr);
  async function saveDescr(): Promise<void> {
    if (descrTimer.current) clearTimeout(descrTimer.current);
    if (descrBusy.current) return; // the save in flight saves the latest text when it lands
    const text = descrLatest.current;
    if (text.trim() === descrSavedText.current.trim()) {
      if (descrState === "failed") setDescrState("idle");
      return;
    }
    descrBusy.current = true;
    setDescrState("saving");
    const res = await setInvoiceDescription(invoice.id, text).catch(() => ({ ok: false as const, error: "That didn't reach the server." }));
    descrBusy.current = false;
    if (!res?.ok) {
      setDescrState("failed");
      return;
    }
    descrSavedText.current = text;
    setDescrState("saved");
    // A delivered bill just changed: the page reads again, so the older-copy notice says so.
    refresh();
    // Typed while that save was out: save that too.
    if (descrLatest.current.trim() !== text.trim()) void saveDescr();
  }
  function typeDescr(v: string) {
    setDescr(v);
    descrLatest.current = v;
    if (descrState === "saved") setDescrState("idle");
    if (descrTimer.current) clearTimeout(descrTimer.current);
    descrTimer.current = setTimeout(() => void saveDescr(), 800);
  }
  // Leaving the page with a save still waiting on its 800 ms: send it now rather than lose it.
  useEffect(
    () => () => {
      if (descrTimer.current) {
        clearTimeout(descrTimer.current);
        if (descrLatest.current.trim() !== descrSavedText.current.trim()) void setInvoiceDescription(invoice.id, descrLatest.current);
      }
    },
    // One unmount per page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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
  /** The Import row's reach (see importMode). Without the page's answer, by kind as before J-011. */
  const importRow = importMode ?? (isDrawKind((invoice as any).invoice_kind) ? "none" : "standard");
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

  /* THE TITLE: TAP TO EDIT, SAVED ON LEAVING THE BOX OR ENTER, ESCAPE PUTS IT BACK (W1-27). The
     check button went: leaving the box IS the save, and the toast carries Undo, the way back that
     works on a phone with no Escape key. Nothing is sent when nothing changed. */
  const [titleEditing, setTitleEditing] = useState(false);
  const [title, setTitle] = useState(invoice.title ?? "");
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleSaved = useRef<string>(invoice.title ?? "");
  const titleCancelled = useRef(false);
  function writeTitle(next: string, prev: string, undoable: boolean) {
    start(async () => {
      const res = await setInvoiceTitle(invoice.id, next);
      if (!res.ok) {
        setTitleError(res.error ?? "The title didn't save.");
        setTitle(next);
        setTitleEditing(true);
        return;
      }
      titleSaved.current = next;
      setTitle(next);
      setTitleError(null);
      toast(undoable ? "Title saved" : "Title put back", "success", undoable ? { label: "Undo", onClick: () => writeTitle(prev, next, false) } : undefined);
      refresh();
    });
  }
  function commitTitle() {
    if (titleCancelled.current) {
      titleCancelled.current = false;
      return;
    }
    setTitleEditing(false);
    const next = title.trim();
    const prev = titleSaved.current;
    if (next === prev.trim()) {
      setTitle(prev);
      return;
    }
    writeTitle(next, prev, true);
  }
  function cancelTitle() {
    titleCancelled.current = true;
    setTitle(titleSaved.current);
    setTitleError(null);
    setTitleEditing(false);
  }

  /* THE DUE DATE COMES FROM THE COMPANY'S TERMS (W1-27). It reads "Due Oct 8 · Net 14"; a draft
     whose date nobody picked reads "Due 14 days after you send it", because the first send stamps
     send day + the terms (markInvoiceSent) - unless a person picked a date, which is theirs
     (invoices.due_date_by_hand, 0366). Change opens the picker, and a picked date saves on the
     spot with Undo; Save, "Unsaved" and Clear are gone (an invoice always has a due date - the
     Overdue tracker needs one). */
  const [dueEditing, setDueEditing] = useState(false);
  const dueByHand = (invoice as { due_date_by_hand?: boolean | null }).due_date_by_hand;
  function writeDue(date: string | null, byHand: boolean, undo: { date: string | null; byHand: boolean } | null) {
    start(async () => {
      const res = await setInvoiceDueDate(invoice.id, date, { byHand });
      if (!res.ok) {
        toast(res.error ?? "The due date didn't save - try again.", "error");
        return;
      }
      toast(
        undo ? `Due date moved to ${shortDay(date)}` : `Due date put back to ${shortDay(date)}`,
        "success",
        undo ? { label: "Undo", onClick: () => writeDue(undo.date, undo.byHand, null) } : undefined,
      );
      refresh();
    });
  }
  /* A PICKED DATE SAVES; A TYPED ONE SAVES WHEN THE TYPING STOPS. A phone's picker changes the box
     once, but typing a date on a keyboard passes through a valid date at nearly every keystroke
     (0002-10-12, 0020-10-12…), and each would have saved and toasted. So a change waits 700 ms for
     the next one, leaving the box saves at once, and only a whole date from this century is sent. */
  const dueTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const duePending = useRef<string | null>(null);
  function flushDue() {
    if (dueTimer.current) clearTimeout(dueTimer.current);
    const v = duePending.current;
    duePending.current = null;
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number(v.slice(0, 4)) < 2000) return;
    const prev = toDateInput(invoice.due_date);
    if (v === prev) return;
    writeDue(v, true, { date: prev || null, byHand: dueByHand !== false });
  }
  function pickDue(v: string) {
    duePending.current = v;
    if (dueTimer.current) clearTimeout(dueTimer.current);
    dueTimer.current = setTimeout(flushDue, 700);
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
  /** Imports that could not touch ANYTHING — every line edited, or the deleted ones tombstoned.
   *  Naming each source arms its "Start It Over" beside the message (0204). */
  const [stuckSources, setStuckSources] = useState<("labor" | "costs" | "quote" | "change_orders")[]>([]);
  /** A draft deliberately set aside (0206): the one body line says until when, and why. */
  const storedHold = (invoice as { hold_until?: string | null }).hold_until ?? null;
  /** Only a day still ahead is a hold (liveHoldDay): once it comes the draft is back on the list. And
   *  a draft whose job is finished or cancelled is back on it at once ("Finished · Send"), whatever
   *  day it was given, so it never says "Set aside until" there. */
  const jobIsOver = isFinishedJobStatus(embeddedJob<{ status?: string | null }>((invoice as { jobs?: unknown }).jobs)?.status);
  const holdUntil = jobIsOver ? null : liveHoldDay(storedHold, todayStrInTz(tz));
  const holdReason = (invoice as { hold_reason?: string | null }).hold_reason ?? null;
  /* THE % BOX STARTS WHERE THE INVOICE IS (2026-09-25). It used to start at the customer's usual
     markup whatever the lines said, so on INV-078 - moved to 11% - it read 15, and the next touch
     sent that 15 back over every untouched line. The server now reads what the lines are priced at
     (lib/invoice-markup-read, the importer's own read) and the box starts there when they give one
     answer; `applied` starts at the same figure, so opening the page changes nothing. A refresh
     (after any import) takes the server's new reading only while nothing is typed
     (markupBoxOnSeed). Since 0175 the import is an UPSERT that never touches an edited line, so
     applying a new number re-prices only the machine-priced cost lines, and the toast says so. */
  const [box, setBox] = useState(() => markupBoxStart(markupSeed));
  const [seenSeed, setSeenSeed] = useState(markupSeed);
  if (seenSeed.pct !== markupSeed.pct || seenSeed.source !== markupSeed.source || seenSeed.usualPct !== markupSeed.usualPct) {
    setSeenSeed(markupSeed);
    setBox((b) => markupBoxOnSeed(b, markupSeed));
  }
  const costsImported = items.some((i) => i.import_source === "costs");
  /** The lines were just set to `pct` from here (an import that landed). */
  const markupLanded = (pct: number) => setBox((b) => markupBoxApplied(b, pct));
  function applyMarkup() {
    if (pending || !costsImported || !markupBoxTyped(box)) return;
    const pct = box.value;
    runImport((id) => importCostsIntoInvoice(id, pct), "Materials", 0, "costs", false, () => markupLanded(pct));
  }
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
    /** Runs when the import landed, before the refresh (the % box records the markup it used). */
    onOk?: () => void,
    /** One more sentence for the confirm - the markup the materials land at (materialsImportPlan). */
    confirmNote?: string,
  ) {
    if (replacing > 0 && askFirst) {
      // Truthful since 0175 (imports became additive): hand-edited lines are NEVER overwritten —
      // the old text threatened exactly that and scared people off a safe refresh.
      const ok = confirm(
        `Re-import ${label.toLowerCase()}?\n\n` +
          `This refreshes the ${replacing} ${label.toLowerCase()} line${replacing === 1 ? "" : "s"} ` +
          `already on ${invoice.invoice_number} from whatever the job holds right now. ` +
          `Lines you edited by hand are kept exactly as you set them; anything added to the job since is pulled in.\n\n` +
          (confirmNote ? `${confirmNote}\n\n` : "") +
          `Current total: ${formatCurrency(Number(invoice.total))}`,
      );
      if (!ok) return;
    }
    setImportMsg(null);
    setImportWarn(null);
    setStuckSources([]);
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
      setStuckSources(stuck && sourceKey ? [sourceKey] : []);
      setImportMsg(said ? `${label}: ${said}.` : `${label} imported.`);
      // "3 of your edits kept" was the whole story on INV-074 while its edited tax rows sat at the
      // old markup. The warning rides in the toast, and stays under the import row until the next
      // import, because a toast is gone before a sentence with two dollar figures can be read.
      const warn = (st?.warnings ?? []).join(". ");
      setImportWarn(warn || null);
      // A money warning is not good news: it rides an info toast, never the green one.
      toast(`${said ? `${label}: ${said}` : `${label} imported`}${warn ? `. ${warn}` : ""}`, warn ? "info" : "success");
      setTimeout(() => setImportMsg(null), 5000);
      onOk?.();
      refresh();
    });
  }

  /* BRING IN NEW WORK (W1-27): one button where four were. What it runs is lib/actuals-draw's
     bringInNewWorkSteps (a Time & Material or actuals invoice: Labor, Materials, Approved Change
     Orders; an estimate's invoice: its lines while it holds none, then Approved Change Orders -
     never labor or materials on top of a price). The importers run one after another; ONE confirm
     when lines already on the invoice would refresh (the same words the single imports used, with
     the materials' markup sentence), and ONE sentence after, built from what each importer said -
     a part that failed is named beside the parts that landed, never one "failed" for the lot. */
  const bringInSteps: BringInStep[] = bringInNewWorkSteps({
    importMode: importRow,
    hasJob: !!invoice.job_id,
    quoteId: (invoice as { quote_id?: string | null }).quote_id ?? null,
    quoteLinesOnInvoice: items.filter((i) => i.import_source === "quote").length,
    estimateIsContract,
  });
  function bringInNewWork() {
    const plan = materialsImportPlan(box, markupSeed);
    const sourceOf: Record<BringInStep, "labor" | "costs" | "quote" | "change_orders"> = { labor: "labor", materials: "costs", quote: "quote", change_orders: "change_orders" };
    const nounOf: Record<BringInStep, string> = { labor: "labor", materials: "materials", quote: "estimate", change_orders: "change order" };
    const refreshing = bringInSteps
      .map((st) => ({ st, n: items.filter((i) => i.import_source === sourceOf[st]).length }))
      .filter((x) => x.n > 0);
    if (refreshing.length) {
      // Truthful since 0175 (imports are additive): hand-edited lines are NEVER overwritten.
      const lines = refreshing.map((x) => `${x.n} ${nounOf[x.st]} line${x.n === 1 ? "" : "s"}`).join(" and ");
      const ok = confirm(
        `Bring in new work?\n\n` +
          `This refreshes the ${lines} already on ${invoice.invoice_number} from whatever the job holds right now. ` +
          `Lines you edited by hand are kept exactly as you set them; anything added to the job since is pulled in.\n\n` +
          (bringInSteps.includes("materials") && plan.confirmNote ? `${plan.confirmNote}\n\n` : "") +
          `Current total: ${formatCurrency(Number(invoice.total))}`,
      );
      if (!ok) return;
    }
    setImportMsg(null);
    setImportWarn(null);
    setStuckSources([]);
    start(async () => {
      const outcomes: BringInOutcome[] = [];
      const fail = (e: unknown) => ({ ok: false as const, error: String((e as { message?: unknown })?.message ?? e ?? "That didn't reach the server.") });
      for (const st of bringInSteps) {
        const res: { ok: boolean; error?: string; empty?: boolean; emptyNote?: string; stats?: Partial<ImportStats> } =
          st === "labor"
            ? await importLaborIntoInvoice(invoice.id).catch(fail)
            : st === "materials"
              ? await importCostsIntoInvoice(invoice.id, plan.pct, plan.keepInvoiceMarkup ? { keepInvoiceMarkup: true } : undefined).catch(fail)
              : st === "quote"
                ? await importQuoteItemsIntoInvoice(invoice.id).catch(fail)
                : await importChangeOrdersIntoInvoice(invoice.id).catch(fail);
        outcomes.push({ step: st, ok: res.ok, empty: res.empty, error: res.error, emptyNote: res.emptyNote, stats: res.stats });
        if (st === "materials" && res.ok) markupLanded(plan.pct);
      }
      const said = bringInSentence(outcomes);
      setStuckSources(said.stuck.map((st) => sourceOf[st]));
      setImportMsg(said.sentence);
      // "3 of your edits kept" was the whole story on INV-074 while its edited tax rows sat at the
      // old markup. The warning rides in the toast, and stays under the button until the next run.
      const warn = said.warnings.join(". ");
      setImportWarn(warn || null);
      toast(`${said.sentence}${warn ? ` ${warn}.` : ""}`, said.partial ? "info" : "success");
      setTimeout(() => setImportMsg(null), 8000);
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
   *      (Since 2026-09-25 the box starts at what the lines ARE priced at when they agree - see
   *      markupSeed above - and says when they don't.)
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
      // What the line was said to be leads (0342), the same first read as the Cost Breakdown.
      const said = storedLineKind(it.line_kind);
      if (said) return said === "labor" ? 0 : said === "materials" ? 1 : said === "credit" ? 3 : 2;
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
          {/* Title — tap to edit; leaving the box or Enter saves, Escape puts it back. A void bill
              shows it as plain text: nothing on it can change. */}
          <div>
            <Label htmlFor={titleEditing ? "inv-title" : undefined} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Title
            </Label>
            {linesLocked ? (
              <p className={invoice.title ? "font-medium text-slate-800" : "text-slate-400"}>{invoice.title || "No title"}</p>
            ) : titleEditing ? (
              <Input
                id="inv-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short label for this invoice"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelTitle();
                  }
                }}
                onBlur={commitTitle}
                disabled={pending}
                className="h-11"
                autoFocus
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  // A fresh edit: an Escape that removed the box without a blur must not swallow this save.
                  titleCancelled.current = false;
                  setTitleEditing(true);
                }}
                className="group flex min-h-11 w-full items-center gap-2 text-left"
                title="Edit title"
              >
                <span className={title ? "font-medium text-slate-800" : "text-slate-400"}>{title || "Add a title…"}</span>
                <Pencil className="h-3.5 w-3.5 text-slate-400 group-hover:text-brand" />
              </button>
            )}
            {titleError && <p className="mt-1 text-xs text-red-600">{titleError}</p>}
          </div>

          {/* Due date — the terms say it; without one the Overdue tracker can never fire. */}
          <div>
            <Label htmlFor={dueEditing ? "inv-due" : undefined} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Due Date
            </Label>
            {dueEditing && !linesLocked ? (
              <Input
                id="inv-due"
                type="date"
                defaultValue={toDateInput(invoice.due_date)}
                onChange={(e) => pickDue(e.target.value)}
                onBlur={() => {
                  flushDue();
                  setDueEditing(false);
                }}
                disabled={pending}
                className="h-11 w-48"
                autoFocus
              />
            ) : (
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="text-sm text-slate-700">
                  {dueWords({ isDraft, dueDate: toDateInput(invoice.due_date), byHand: dueByHand, netDays, sentBefore: wasDelivered })}
                </span>
                {!linesLocked && (
                  <button type="button" onClick={() => setDueEditing(true)} className="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
                    Change
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Customer / job link — correctable while it's still a draft. */}
          {isDraft && (
            <div>
              <Label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Customer / Job</Label>
              <Button variant="outline" onClick={openLink} disabled={pending}>
                <Pencil className="mr-1 h-3.5 w-3.5" /> Edit Customer / Job
              </Button>
            </div>
          )}
        </div>

        {/* SET ASIDE (0206), said on the one line while it is: until when, why, and the two ways
            out. The ⋯ Set Aside Until… sets it; Change is the same sheet; Put Back ends it now. */}
        {isDraft && holdUntil && (
          <div className="flex flex-wrap items-center gap-x-2 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-600">
            <CalendarClock className="h-4 w-4 shrink-0 text-slate-400" />
            <span className="py-2">
              Set aside until {shortDay(holdUntil)}
              {holdReason ? ` · ${holdReason}` : ""}
            </span>
            <span aria-hidden>·</span>
            <SetAsideButton invoiceId={invoice.id} tz={tz} holdUntil={holdUntil} holdReason={holdReason} variant="link" label="Change" />
            <span aria-hidden>·</span>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await parkInvoice(invoice.id, null);
                  if (!res?.ok) {
                    toast(res?.error ?? "Couldn't put it back - try again.", "error");
                    return;
                  }
                  toast("Back on your list.", "success", {
                    label: "Undo",
                    onClick: () => void parkInvoice(invoice.id, holdUntil, holdReason ?? undefined).then(() => refresh()),
                  });
                  refresh();
                })
              }
              className="inline-flex min-h-11 items-center font-medium text-brand hover:underline"
            >
              Put Back
            </button>
          </div>
        )}

        {/* THE STATUS LEFT THE BODY (W1-27): the header's Badge is the one place it shows, and the
            deeds the old picker offered (Mark Sent - I Sent It Myself, Mark Sent Again, Back To Draft,
            Void Invoice) are ⋯ rows (InvoiceStatusMenuItems below, lib/nav-tree invoiceStatusItems),
            with the sentence that says why Draft is gone where it is. Parking is the ⋯'s Set Aside
            Until… and the one line above. */}
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
          pricing={{ levelPct: levelMarkupPct ?? null, orgDefaultPct: defaultMarkupPct }}
          onAdd={(lines) =>
            start(async () => {
              for (const l of lines) {
                const res = await addInvoiceItem(invoice.id, {
                  description: l.description,
                  quantity: l.quantity,
                  unit: l.unit,
                  unit_price: l.unit_price,
                  // A price-book line says what it is (0342), so it files under Materials, not Other.
                  kind: l.kind ?? null,
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
          <div className="mb-1 flex flex-wrap items-center gap-x-2">
            <Label htmlFor={linesLocked ? undefined : "inv-descr"} className="mb-0 block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Description (above line items)
            </Label>
            {descrState === "saving" && <span className="text-xs text-slate-400">Saving…</span>}
            {descrState === "saved" && <span className="text-xs text-emerald-600">Saved</span>}
            {descrState === "failed" && (
              <button type="button" onClick={() => void saveDescr()} className="inline-flex min-h-11 items-center text-xs font-semibold text-red-600 hover:underline">
                Didn&apos;t Save · Try Again
              </button>
            )}
          </div>
          {linesLocked ? (
            <p className="whitespace-pre-wrap text-sm text-slate-700">{descr || "No description."}</p>
          ) : (
            <Textarea
              id="inv-descr"
              value={descr}
              onChange={(e) => typeDescr(e.target.value)}
              onBlur={() => void saveDescr()}
              placeholder="Scope of work — shows above the line items on the invoice."
              className="min-h-[60px]"
            />
          )}
        </div>

        {/* A CLOCK STILL RUNNING ON THIS JOB (2026-09-24): its hours are not on this invoice, and
            nothing used to say so. One line per clock, with the way to stop it at the real time. */}
        {runningClocks.length > 0 && (
          <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
            {runningClocks.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  {c.self ? "You're" : `${c.name} is`} still on the clock on this job since {clockSince(c.clockIn, tz)}. Those
                  hours are not on this invoice until {c.self ? "you're" : `${c.name} is`} clocked out.
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
        {/* A DRAW BUILT FROM ACTUALS GETS THE ROW TOO (J-011, INV-078). The row hid for every draw
            kind, so a time-and-materials progress report could never pull the hours and bills
            logged since, nor take a new markup: Erik, "theres no way to recalculate from the
            invoice itself ... or adjust the markup %". Such a draw is refreshed exactly like a
            standard invoice (Labor, Materials with the % box, Change Orders); From Estimate stays
            off every draw; a draw billing a slice of the contract gets no row. The server's
            importers hold the same line (contractDrawGuard), so this is not the boundary. */}
        {!linesLocked && importHeld && importRow === "none" && (
          <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-3 py-2.5 text-xs text-slate-500">{importHeld}</p>
        )}
        {!linesLocked &&
          (invoice.job_id || (invoice as any).quote_id) &&
          importRow !== "none" && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-3 py-2.5">
            {bringInSteps.length > 0 ? (
              <Button variant="outline" onClick={bringInNewWork} disabled={pending}>
                <PackagePlus className="h-4 w-4" /> {BRING_IN_NEW_WORK}
              </Button>
            ) : (
              // The one case with nothing to run: an estimate's invoice with its lines on it and no job
              // for new work to come from.
              <span className="text-xs text-slate-500">Its estimate&apos;s lines are already on it, and it has no job for new work to come from.</span>
            )}
            {estimateIsContract === null && !(invoice as { quote_id?: string | null }).quote_id && (
              <span className="text-xs text-amber-700">
                Couldn&apos;t read this job just now, so only its approved change orders come in. Reload to bring in its hours and bills.
              </span>
            )}
            {/* THE % BOX BESIDE IT, where materials come in (a Time & Material or actuals invoice). */}
            {bringInSteps.includes("materials") && (
              <div className="flex flex-wrap items-center gap-1.5">
                <MarkupBox
                  value={box.value}
                  applied={box.applied}
                  canApply={costsImported}
                  pending={pending}
                  words={markupBoxWords(markupSeed, levelMarkupPct != null ? customerName : null)}
                  onChange={(v) => setBox((b) => ({ ...b, value: v }))}
                  onApply={applyMarkup}
                />
              </div>
            )}
            {importMsg && <span className="text-xs text-slate-500">{importMsg}</span>}
            {importWarn && <span className="text-xs text-amber-700">{importWarn}.</span>}
            {/* START IT OVER IS STILL DRAFT-ONLY, AND THAT ONE IS NOT OURS TO OPEN. Its refusal
                lives inside the SECURITY DEFINER function reset_import_source (migrations
                0204/0212/0223), which still raises on a non-draft invoice in a Postgres voice no
                screen here can soften. Offering the button on a sent bill would be the dead end
                this wave exists to delete, so on a delivered invoice the sentence says what to do
                instead - the ordinary controls, which now work. */}
            {stuckSources.length > 0 && !isDraft && (
              <span className="text-xs text-amber-700">
                Lines you edited or removed are protected, so nothing came in. On a bill that has
                already gone out, change the lines directly instead.
              </span>
            )}
            {isDraft && stuckSources.map((stuckSource) => (
              <span key={stuckSource} className="flex flex-wrap items-center gap-1.5 text-xs text-amber-700">
                {`${stuckSource === "labor" ? "Labor" : stuckSource === "costs" ? "Materials" : stuckSource === "quote" ? "The estimate's lines" : "Change orders"}: lines you edited or removed are protected, so nothing came in.`}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    const src = stuckSource;
                    const plan = materialsImportPlan(box, markupSeed);
                    const pct = plan.pct;
                    if (
                      !confirm(
                        "Start this import over? Every line from this import is removed and rebuilt from the source — including ones you edited or deleted. Hand-entered lines are untouched." +
                          (src === "costs" ? `\n\n${plan.rebuildNote}` : ""),
                      )
                    )
                      return;
                    runImport(
                      (id) => reimportFromScratch(id, src, src === "costs" ? pct : undefined),
                      src === "labor" ? "Labor" : src === "costs" ? "Materials" : "Estimate items",
                      0,
                      src,
                      true,
                      src === "costs" ? () => markupLanded(pct) : undefined,
                    );
                  }}
                  className="inline-flex min-h-11 items-center rounded-md border border-amber-300 bg-white px-3 font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                >
                  Start It Over
                </button>
              </span>
            ))}
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
                {/* The fix, in reach of the problem: the same Send sheet the header opens. */}
                <SendButton
                  kind="invoice"
                  id={invoice.id}
                  number={invoice.invoice_number}
                  customerName={customerName}
                  amount={Number(invoice.total)}
                  lineCount={items.length}
                  textReady={textReady}
                  label="Send Again"
                  variant="outline"
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
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
                      aria-label="Save"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setEditId(null)}
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100"
                      aria-label="Cancel"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {/* WHAT THE LINE IS on the customer's breakdown (0342): saved on the tap, apart
                      from the words and price above, which still wait for the check mark. */}
                  <LineKindChips item={it} invoiceId={invoice.id} invoiceKind={(invoice as any).invoice_kind ?? null} disabled={pending} onDone={refresh} />
                  {/* From TWO lines: with the one-step chevrons gone these are the only way to swap
                      a pair (Group Materials & Labor leaves hand-typed lines where they are). */}
                  {items.length > 1 && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => moveToEdge(it.id, "top")}
                        disabled={pending || items[0]?.id === it.id}
                        className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                      >
                        <ChevronsUp className="h-4 w-4" /> Move To Top
                      </button>
                      <button
                        type="button"
                        onClick={() => moveToEdge(it.id, "bottom")}
                        disabled={pending || items[items.length - 1]?.id === it.id}
                        className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                      >
                        <ChevronsDown className="h-4 w-4" /> Move To Bottom
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
                      <LineRowText item={it} notes={lineNotes} />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startEdit(it)}
                      disabled={pending}
                      className="min-w-0 flex-1 cursor-pointer text-left"
                      title="Edit line item"
                    >
                      <LineRowText item={it} notes={lineNotes} />
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
                      {/* One step up or down went (W1-27): Move To Top / Move To Bottom in the line's
                          edit form and Group Materials & Labor below do the moving, 44px each. */}
                      <button
                        onClick={() => startEdit(it)}
                        disabled={pending}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-brand"
                        aria-label="Edit"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => start(async () => { const res = await deleteInvoiceItem(it.id, invoice.id); if (!res?.ok) { toast(res?.error ?? "Couldn't remove the line item — try again.", "error"); return; } refresh(); })}
                        disabled={pending}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-red-600"
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
                className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                title="Labor first, then materials — lines you added by hand stay where you put them"
              >
                <Layers className="h-4 w-4" /> Group Materials & Labor
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
                This invoice is void, so its lines are set. If you voided it by mistake, use Back To Draft in
                the ⋯ menu at the top. To bill this work, start a new invoice.
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
            {/* SALES TAX OFF (the switch board, rule g): an invoice with no tax shows no tax row and no
                picker. One that already carries tax keeps both, so its total still reads whole. */}
            {taxFieldShown(salesTax, invoice) && (
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
            )}
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
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-brand text-white disabled:opacity-50"
                        aria-label="Save payment"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button onClick={() => setPayEditId(null)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100" aria-label="Cancel">
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
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
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
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-red-600"
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

/** "Oct 8" - a date-only value read as that calendar day (never shifted by a timezone); the year
 *  only when it isn't this one. */
function shortDay(value: string | null | undefined): string {
  const d = toDateInput(value);
  if (!d) return "no date";
  const at = new Date(`${d}T12:00:00Z`);
  const sameYear = at.getUTCFullYear() === new Date().getUTCFullYear();
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/**
 * THE DUE LINE'S WORDS (W1-27). An untouched draft's due date is not its date yet: the first send
 * stamps send day + the terms (markInvoiceSent), so it says so. Everything else says the date and
 * the company's terms. `byHand` undefined = the column isn't there yet (before 0366): the date as
 * stored is the date, so it is said as one. `sentBefore`: a draft that already went out once (Back
 * To Draft keeps its sent_at) is not waiting on a first send - its next send keeps the date the
 * customer has held since, so the date is said as one.
 */
export function dueWords(f: { isDraft: boolean; dueDate: string; byHand: boolean | null | undefined; netDays: number; sentBefore?: boolean }): string {
  if (f.isDraft && f.byHand === false && !f.sentBefore) return `Due ${f.netDays} days after you send it`;
  if (!f.dueDate) return "No due date yet";
  return `Due ${shortDay(f.dueDate)} · Net ${f.netDays}`;
}

/**
 * IS IT STILL SET ASIDE? Only while its day is ahead: Needs You brings the draft back the day
 * hold_until comes (action-items query: hold_until <= today), and nothing clears the column, so a
 * day that has come is a draft already back on the list - never "set aside until" a day gone by.
 * Returns the live day (YYYY-MM-DD) or null.
 */
export function liveHoldDay(holdUntil: string | null | undefined, today: string): string | null {
  const d = toDateInput(holdUntil);
  return d && d > today ? d : null;
}

/** One week from today in the company's timezone: the Set Aside sheet's first date. */
function weekOutIn(tz: string): string {
  const today = todayStrInTz(tz);
  return new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
}

/**
 * SET ASIDE UNTIL… (W1-27; 0206's park). A draft waiting on a signature or an approval leaves the
 * list until a day, then comes back on it - "parked forever" is how a real bill gets forgotten, so
 * there is no "No Date". The day starts one week out in the company's timezone, and "Why?" rides
 * along (parkInvoice keeps it as hold_reason). The toast says when it comes back, with Undo.
 */
function SetAsideSheet({
  onClose,
  invoiceId,
  tz,
  holdUntil,
  holdReason,
}: {
  onClose: () => void;
  invoiceId: string;
  tz: string;
  holdUntil: string | null;
  holdReason: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  // A day that has already come is no hold: the sheet starts one week out again, and Undo puts
  // back only a hold that was still live.
  const liveHold = liveHoldDay(holdUntil, todayStrInTz(tz));
  const [date, setDate] = useState(liveHold || weekOutIn(tz));
  const [why, setWhy] = useState(holdReason ?? "");
  const [error, setError] = useState<string | null>(null);
  function save() {
    setError(null);
    // The date box's min isn't a rule on its own (Save doesn't run the form's checks): a day that
    // has already come would "set it aside" onto a list it never leaves, so it is said here.
    if (!liveHoldDay(date, todayStrInTz(tz))) {
      setError("Pick a day after today - on that day it comes back on your list.");
      return;
    }
    start(async () => {
      const res = await parkInvoice(invoiceId, date, why);
      if (!res?.ok) {
        setError(res?.error ?? "Couldn't set it aside - try again.");
        return;
      }
      onClose();
      toast(`Set Aside Until ${shortDay(date)}. It comes back on your list that day.`, "success", {
        label: "Undo",
        onClick: () =>
          void parkInvoice(invoiceId, liveHold, holdReason ?? undefined).then((r) => {
            if (!r?.ok) toast(r?.error ?? "Couldn't undo that - try again.", "error");
            router.refresh();
          }),
      });
      router.refresh();
    });
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Set Aside Until…"
      size="sm"
      portal
      holdOpen={pending}
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} saveLabel="Set Aside" disabled={!date} />}
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">It leaves your list until that day, then comes back on it. Nothing is sent, and nothing on the invoice changes.</p>
        <div>
          <Label htmlFor="sa-date">Until</Label>
          <Input id="sa-date" type="date" value={date} min={todayStrInTz(tz)} onChange={(e) => setDate(e.target.value)} className="h-11 w-48" />
        </div>
        <div>
          <Label htmlFor="sa-why">Why?</Label>
          <Textarea id="sa-why" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Waiting on the change order to be signed" />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

/** The ⋯ row "Set Aside Until…" (a draft), or the body line's small "Change". */
export function SetAsideButton({
  invoiceId,
  tz,
  holdUntil = null,
  holdReason = null,
  variant = "menuItem",
  label,
}: {
  invoiceId: string;
  tz: string;
  holdUntil?: string | null;
  holdReason?: string | null;
  variant?: "menuItem" | "link";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === "menuItem" ? (
        <button type="button" onClick={() => setOpen(true)} className={ACTIONS_ROW_CLS}>
          <CalendarClock className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {label ?? "Set Aside Until…"}
        </button>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center font-medium text-brand hover:underline">
          {label ?? "Change"}
        </button>
      )}
      {open && <SetAsideSheet onClose={() => setOpen(false)} invoiceId={invoiceId} tz={tz} holdUntil={holdUntil} holdReason={holdReason} />}
    </>
  );
}

const VOID_ROW_CLS = ACTIONS_ROW_CLS.replace("text-slate-700", "text-red-600");

/**
 * THE STATUS DEEDS, AS ⋯ ROWS (W1-27). lib/nav-tree invoiceStatusItems decides which (no status
 * offered twice, none offered as what the invoice already is); each row calls setInvoiceStatus
 * exactly as the old picker did - the send declarations' own value translated back to "sent"
 * (statusToSend) one line from the call, the same toasts, Void behind its confirm - and where Back
 * To Draft can't be offered, the sentence that says why stands in its place.
 */
export function InvoiceStatusMenuItems({
  invoiceId,
  invoiceNumber,
  status,
  sentAt,
  amountPaid,
  customerHoldsOlderCopy = false,
}: {
  invoiceId: string;
  invoiceNumber?: string | null;
  status: string;
  sentAt?: string | null;
  amountPaid?: number | null;
  customerHoldsOlderCopy?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const items = invoiceStatusItems({ status, invoiceNumber, sentAt, amountPaid, customerHoldsOlderCopy });
  function run(value: string, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    const next = statusToSend(value);
    start(async () => {
      const res = await setInvoiceStatus(invoiceId, next);
      if (!res?.ok) {
        toast(res?.error ?? "Couldn't change the status — try again.", "error");
        return;
      }
      toast(next === "void" ? "Invoice voided" : next === "sent" ? "Marked as sent" : "Status updated", "success");
      router.refresh();
    });
  }
  return (
    <>
      {items.map((it) =>
        "note" in it ? (
          <p key={it.id} className={ACTIONS_NOTE_CLS}>
            {it.note}
          </p>
        ) : (
          <button key={it.id} type="button" disabled={pending} onClick={() => run(it.value, it.confirm)} className={it.value === "void" ? VOID_ROW_CLS : ACTIONS_ROW_CLS}>
            {it.value === "void" ? <Ban className="h-4 w-4 shrink-0" /> : it.value === "draft" ? <Undo2 className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> : <Send className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" />}
            {it.label}
          </button>
        ),
      )}
    </>
  );
}
