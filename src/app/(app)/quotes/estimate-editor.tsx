"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DropTarget } from "@/components/drop-target";
import { taxFieldShown } from "@/lib/sales-tax-switch";
import { NewCustomerInline } from "@/components/new-customer-inline";
import { applyPriceBookReview } from "../price-list/actions";
import type { BookUpdate, BookAddition } from "@/lib/pricing/book-review";
import { Plus, Trash2, Sparkles, Loader2, ChevronDown, ChevronRight, Check, X, FileUp, ListPlus } from "lucide-react";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented";
import { LineItemText } from "@/components/line-item-text";
import { EmailButton } from "@/components/email-button";
import { ShareIconButton } from "@/components/share-icon-button";
import { SectionActionsMenu } from "@/components/section-actions-menu";
import type { NavTree } from "@/lib/nav-tree";
import type { QuoteDocType } from "@/lib/doc-label";
import { formatCurrency, formatDate } from "@/lib/utils";
import { priceBookLine, type BookPricing } from "@/lib/pricing/item-options";
import { laborRateFor } from "@/lib/pricing/labor-rate";
import { coerceDraftLine, emptyTaskDetail, taskFlags, taskFromLine, type TaskKit } from "@/lib/estimate/task-lines";
import { ruleInputsKey, type RuleInputs } from "@/lib/estimate/reprice-rows";
import { sameTask } from "@/lib/playbook/tasks";
import type { DraftLineItem } from "@/lib/estimate/line-map";
import type { EstimateFormat } from "@/lib/doc-style";
import type { Customer, QuoteCircuit } from "@/lib/types";
import { PaperFormatSwitch } from "./paper-format-switch";
import { subtotalTaxTotal } from "@/lib/invoice-math";
import { useToast } from "@/components/toast";
import {
  appendQuoteLines,
  deleteQuote,
  deleteQuoteItem,
  createJobFromQuote,
  generateQuoteDraft,
  generateQuoteDraftFromLeadPlans,
  generateQuoteDraftFromPlan,
  generateQuoteDraftFromSupplier,
  quoteShareText,
  readQuoteLineIds,
  saveQuote,
  setQuoteCustomer,
  setQuoteType,
  updateQuoteItem,
  updateQuoteMeta,
} from "./actions";
import { createInvoiceFromQuote } from "../billing/actions";
import { createWorkOrderFromQuote } from "../work-orders/actions";
import { createMaterialListFromQuote } from "../materials/actions";
import { AddLineItems } from "@/components/add-line-items";
import { CustomerSelect } from "./[id]/customer-select";
import { StatusControl } from "./[id]/status-control";
import { QuoteTypeToggle } from "./[id]/quote-type-toggle";
import { DuplicateQuoteButton } from "./[id]/duplicate-quote-button";
import { CircuitScheduleCard } from "./[id]/circuit-schedule-card";
import { IntakeFiles } from "../leads/intake-files";
import { LineDescInput, TaskBreakdown, type PersonOption, type PriceItemLite } from "./task-breakdown";
import { joinLineNote, splitLineNote } from "@/lib/estimate/line-note";
import { createQuoteSession, isQuiet, useQuoteSession, type EditorLine, type EstimateHeader, type HeaderField, type Mode, type SessionState } from "./use-quote-writes";
import { browserStash, stashHandoff, takeHandoff, type HandoffProposal } from "./handoff";

/**
 * THE ONE ESTIMATE EDITOR (cn-v1132). Two editors used to hold the same document two ways — the
 * builder on /quotes/new (lines, groups, the task breakdown, the estimator, the kit picker, a
 * browser copy autosaved every 1.5 s) and the saved page's plain-row editor, which never read a
 * line's task. Erik lived the split on 2026-10-27: the visit's estimate had its task layout; the
 * saved copy and the duplicate did not. This is one component for both pages, on the invoice
 * editor's save model (use-quote-writes.ts): one write in flight, the controls disabled while it
 * runs, a refusal said on its row with Retry, and no copy of the document in the browser beyond
 * the field being typed.
 *
 *   mode "unsaved"   /quotes/new?… — the seed is rendered with NO row. The first commit with
 *                    substance (a named line, header text, somebody picked, or the mount when the
 *                    seed carries real lines) saves once under a client-chosen id; the ids come back;
 *                    and the moment nothing is on the wire or waiting (isQuiet) the editor hands the
 *                    estimate to ITS OWN PAGE — the unsaved UI text (the scope, the proposals) in a
 *                    one-shot stash, then router.replace to /quotes/<id>, a real navigation, so Back
 *                    goes to the page before the editor and the status is the server's from then on.
 *                    A cold estimate nobody types into leaves no row.
 *   mode "saved"     /quotes/[id] — the row and its lines, every door the page had: customer, type,
 *                    status, email / share, Duplicate / Revise, the conversions menu, intake files,
 *                    the circuit schedule, delete. A locked estimate reads only — the lock is the
 *                    page's answer from the server rule, never guessed here.
 */

interface CustomerOption {
  id: string;
  name: string;
  company_name: string | null;
  level_markup?: number | null;
  level_rate?: number | null;
}
/** A LEAD — a person who has not bought anything yet. Deliberately NOT a CustomerOption: a lead
 *  has no pricing level, because a pricing level is something you give a customer. */
interface LeadOption {
  id: string;
  name: string;
  company_name: string | null;
}
interface TaxRateLite {
  id: string;
  name: string;
  rate: number;
  is_default: boolean;
}
type KitLite = { id: string; name: string; kit_items: unknown[] };

/**
 * One line the estimator PROPOSED. `keep` starts true on purpose.
 *
 * The kit picker defaults every row to unchecked, on Chris's rule — "don't auto select all items"
 * — and that is right for a KIT, which is a template of what a job could need. A take-off is the
 * opposite: it is a reading of the scope he just typed. Making him tick twenty-five boxes to get
 * back what one press used to give him is a worse tool, not a safer one. He unticks what he does
 * not want; nothing lands until he presses the button.
 */
type Proposal = HandoffProposal;

const blankItem = (): DraftLineItem => ({
  description: "",
  quantity: 1,
  unit: "ea",
  unit_price: 0,
});

/** Everything the editor needs that is not the document: the book, the kits, the team, the switches. */
export interface EditorCatalog {
  /** For storage-first uploads (#116): the org folder the documents bucket's RLS admits. */
  orgId: string;
  priceItems: PriceItemLite[];
  /** The plain parts kits for the Add picker (a task kit is the Inspector's). */
  kits: KitLite[];
  /** The org's TASK kits (0386) with their lines: a line built from one says which, and its units
   *  box re-derives the kit for another count (W4). */
  taskKits: TaskKit[];
  /** The company's Kits switch (0352): off hides Remember As A Kit and the kit chips. */
  kitsOn: boolean;
  taxRates: TaxRateLite[];
  /** The org's active people (profile_pay: id, name, bill rate), for a labor row's Who select. */
  people: PersonOption[];
  /** Org Settings default_markup_pct — the last fallback in effectiveMarkupPct's chain. */
  defaultMarkupPct: number;
  /** Org Settings default_labor_rate — laborRateFor's fallback when the customer's level has no rate. */
  defaultLaborRate: number;
  /** The company's Doc Studio choice for how a task line reads on the paper. */
  companyEstimateFormat: EstimateFormat;
  /** SALES TAX OFF (the switch board, rule g): no default rate seeds a new estimate and the tax
   *  field isn't drawn. One that already carries tax keeps it, and its field. */
  salesTax: boolean;
  /** Draft With Estimator SPLITS the scope into tasks (research orgs) instead of pricing lines. */
  estimatorTaskMode: boolean;
  /** Measurements the inspector already took (?capture=); they prefill the kit picker's sizing boxes. */
  measured?: { sqft?: number | null; linearFt?: number | null; byKey?: Record<string, number | null> | null };
  /** The linked lead's own plan PDFs (intake uploads) — one-tap take-off, no re-upload — and whose. */
  leadPlans?: { leadId: string; files: { path: string; name: string }[] };
  /** The visit's scope word, for Remember As A Kit's "under" box (null = no visit, or no scope). */
  scopeWord?: string | null;
  /** Texting is set up (EmailButton's Text door). */
  textReady: boolean;
  /** The Estimates switch (Duplicate / Revise are its doors; a lock keeps them). */
  estimatesOn: boolean;
}

/** /quotes/new's seed: what the door the estimate was opened from already knows. */
export interface UnsavedSeed {
  /** The id the first save is made under (tests hand one in; the editor picks crypto.randomUUID). */
  clientId?: string;
  customers: CustomerOption[];
  leads: LeadOption[];
  preselected?: string;
  /** When launched from a job, the estimate attaches to it. */
  jobId?: string;
  /** When launched from a lead conversion, the estimate keeps the provenance backlink. */
  inquiryId?: string;
  /** The inspection appointment being written up (?capture=) — saveQuote stamps the quote's id on it. */
  captureId?: string;
  /** Prefill for the estimator scope box — e.g. an inspection's field capture. */
  initialScope?: string;
  /** Line items the INSPECTION already priced, or a lead's configurator lines: real rows, not prose. */
  items: DraftLineItem[];
  quoteExpiryDays: number;
}

/** One stored line, as /quotes/[id] reads it (projection law: every column the editor shows). */
export interface SavedLineRow {
  id: string;
  description: string;
  quantity: number | string;
  unit: string | null;
  unit_price: number | string;
  category?: string | null;
  detail?: unknown;
  sort_order?: number | null;
}

/** The row, as /quotes/[id] reads it. */
export interface SavedQuoteRow {
  id: string;
  quote_number: string;
  status: string;
  doc_type?: string | null;
  title: string | null;
  description?: string | null;
  notes: string | null;
  tax_rate: number | string;
  valid_until: string | null;
  estimate_format?: string | null;
  circuits?: unknown;
  job_id: string | null;
  inquiry_id?: string | null;
  customer_id: string | null;
  revises_quote_id?: string | null;
  created_at: string;
}

export interface SavedEstimate {
  quote: SavedQuoteRow;
  items: SavedLineRow[];
  /** Non-null when requireEditableQuote would refuse a line change: the reason, in a sentence that
   *  says what he CAN do (duplicate it as a revision). */
  lock: { reason: string } | null;
  /** The attached customer's full row (CustomerSelect's EditCustomerButton needs every field). */
  customer: Customer | null;
  /** The lead on quotes.inquiry_id, with what it attached at intake. */
  lead: { id: string; name: string | null; company_name?: string | null; email?: string | null; phone?: string | null; intakePaths: string[] } | null;
  /** The org's customers, for the customer card's picker. */
  customers: { id: string; name: string; company_name: string | null }[];
  /** The customer's pricing level: markup and labor rate. null = none — NEVER 0. */
  level: { markup: number | null; rate: number | null };
  /** What this estimate has already become (idempotent doors: View … instead of a twin). */
  existing: { invoice: string | null; workOrder: string | null; materialList: string | null };
  /** The revision chain (0391), both ways. */
  revises: { id: string; quote_number: string | null; status: string | null } | null;
  supersededBy: { id: string; quote_number: string | null } | null;
  /** The visit this was written up from (capture.quote_id). */
  visitBehind: { id: string; starts_at: string | null } | null;
  /** The circuit schedule card: shown when the Panel Map switch is on or the estimate has circuits. */
  showCircuits: boolean;
  panelJob: { id: string; label: string } | null;
}

export type EstimateEditorProps = { catalog: EditorCatalog } & ({ mode: "unsaved"; seed: UnsavedSeed } | { mode: "saved"; saved: SavedEstimate });

/** The header as the row holds it (saved), or as the door seeded it (unsaved). */
function headerFrom(props: EstimateEditorProps): EstimateHeader {
  if (props.mode === "saved") {
    const q = props.saved.quote;
    return {
      customerId: q.customer_id ?? "",
      leadId: q.inquiry_id ?? "",
      jobId: q.job_id,
      captureId: null,
      docType: q.doc_type === "quote" ? "quote" : "estimate",
      estimateFormat: q.estimate_format === "tasks" || q.estimate_format === "detailed" ? q.estimate_format : null,
      title: q.title ?? "",
      description: q.description ?? "",
      notes: q.notes ?? "",
      taxRate: Number(q.tax_rate) || 0,
      validUntil: q.valid_until?.slice(0, 10) ?? "",
    };
  }
  const { seed, catalog } = props;
  const defaultRate = catalog.salesTax ? catalog.taxRates.find((t) => t.is_default) : undefined;
  const d = new Date();
  d.setDate(d.getDate() + (seed.quoteExpiryDays || 30));
  return {
    customerId: seed.preselected ?? "",
    leadId: seed.inquiryId ?? "",
    jobId: seed.jobId ?? null,
    captureId: seed.captureId ?? null,
    docType: "estimate",
    estimateFormat: null,
    title: "",
    description: "",
    notes: "",
    taxRate: defaultRate ? Number(defaultRate.rate) / 100 : 0,
    validUntil: d.toISOString().slice(0, 10),
  };
}

/** A stored line as the editor holds it: the task behind it coerced (an older shape reads as one
 *  legacy row), the flag rebuilt (it is build-time only), the category as the line's group. */
export function lineFromRow(r: SavedLineRow): DraftLineItem & { id: string } {
  return {
    id: r.id,
    ...coerceDraftLine({
      description: r.description,
      quantity: Number(r.quantity) || 1,
      unit: r.unit ?? "ea",
      unit_price: Number(r.unit_price) || 0,
      ...(r.category ? { group: r.category } : {}),
      detail: r.detail as DraftLineItem["detail"],
    }),
  };
}

function linesFrom(props: EstimateEditorProps): (DraftLineItem & { id?: string | null })[] {
  if (props.mode === "saved") return props.saved.items.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map(lineFromRow);
  // An inspection that already picked and priced its scopes seeds the estimate with those exact
  // rows; otherwise one blank line to start typing into.
  return props.seed.items.length ? props.seed.items.map((l) => coerceDraftLine({ ...l })) : [blankItem()];
}

/** The ⋯ menu's map for a saved estimate — the same tree the page used to build server-side, built
 *  here so an estimate born on this screen has the same doors without a reload. */
function quoteTree(q: {
  id: string;
  number: string;
  status: string;
  jobId: string | null;
  lineCount: number;
  existing: SavedEstimate["existing"];
  revisesId: string | null;
}): NavTree {
  // A REPLACED ESTIMATE MAKES NO MORE PAPER (audit v1085, carried): a superseded estimate offers no
  // Create door — its revision does; a revision not yet accepted makes no work order or list. View
  // doors stay. The rules themselves refuse too.
  const replaced = q.status === "superseded";
  const noPaperYet = replaced || (!!q.revisesId && q.status !== "accepted");
  return {
    center: { label: q.number, icon: "fileText" },
    nodes: [
      ...(q.existing.invoice
        ? [{ id: "qm-inv", label: "View Invoice", icon: "receipt", href: `/billing/${q.existing.invoice}` }]
        : replaced
          ? []
          : [{ id: "qm-inv", label: "Create Invoice", icon: "receipt", run: () => createInvoiceFromQuote(q.id), hrefPrefix: "/billing/" }]),
      ...(q.jobId
        ? [{ id: "qm-job", label: "View Job", icon: "briefcase", href: `/jobs/${q.jobId}` }]
        : replaced
          ? []
          : [{ id: "qm-job", label: "Create Job", icon: "briefcase", run: () => createJobFromQuote(q.id), hrefPrefix: "/jobs/" }]),
      ...(q.lineCount > 0
        ? [
            ...(q.existing.workOrder
              ? [{ id: "qm-wo", label: "View Work Order", icon: "clipboardCheck", href: `/work-orders/${q.existing.workOrder}` }]
              : noPaperYet
                ? []
                : [{ id: "qm-wo", label: "Create Work Order", icon: "clipboardCheck", run: () => createWorkOrderFromQuote(q.id), hrefPrefix: "/work-orders/" }]),
            ...(q.existing.materialList
              ? [{ id: "qm-ml", label: "View Material List", icon: "boxes", href: `/materials/${q.existing.materialList}` }]
              : noPaperYet
                ? []
                : [{ id: "qm-ml", label: "Create Material List", icon: "boxes", run: () => createMaterialListFromQuote(q.id), hrefPrefix: "/materials/" }]),
          ]
        : []),
      { id: "qm-print", label: "Print / PDF", icon: "fileSpreadsheet", href: `/print/pdf-preview?doc=quote&id=${q.id}&back=/quotes/${q.id}` },
      {
        id: "qm-del",
        label: "Delete Quote",
        icon: "trash",
        danger: true,
        confirmText: `Delete quote ${q.number}? Its line items go with it.`,
        run: () => deleteQuote(q.id),
        href: "/quotes",
      },
    ],
  };
}

/** The words beside a refused write and the one way to run it again (Title Case: it is a button). */
function Refused({ words, onRetry, disabled }: { words: string; onRetry: () => void; disabled: boolean }) {
  return (
    <p className="mt-1 text-xs text-red-600">
      {words}{" "}
      <button type="button" onClick={onRetry} disabled={disabled} className="font-semibold underline disabled:opacity-50">
        Retry
      </button>
    </p>
  );
}

/** Words with nothing to press: a commit queued behind the write on the wire, a line waiting for its id. */
function Waiting({ words }: { words?: string }) {
  return words ? <p className="mt-1 text-xs text-amber-700">{words}</p> : null;
}

export function EstimateEditor(props: EstimateEditorProps) {
  const { catalog } = props;
  const { priceItems, kits, taskKits, kitsOn, taxRates, people, defaultMarkupPct, defaultLaborRate, companyEstimateFormat, salesTax, estimatorTaskMode, measured, scopeWord = null, orgId } = catalog;
  const toast = useToast();
  const router = useRouter();
  const { session, state } = useQuoteSession(() =>
    createQuoteSession({
      mode:
        props.mode === "saved"
          ? { kind: "saved", id: props.saved.quote.id, number: props.saved.quote.quote_number, status: props.saved.quote.status, bornHere: false }
          : { kind: "unsaved", clientId: props.seed.clientId ?? crypto.randomUUID() },
      header: headerFrom(props),
      items: linesFrom(props),
      actions: {
        saveQuote,
        appendQuoteLines,
        updateQuoteItem,
        deleteQuoteItem,
        updateQuoteMeta,
        setQuoteCustomer,
        setQuoteType,
        readQuoteLineIds,
      },
    }),
  );
  const { header, items, mode } = state;
  const busy = state.pending !== null;
  const status = mode.kind === "saved" ? mode.status : "draft";
  const savedId = mode.kind === "saved" ? mode.id : null;

  // THE FIRST SAVE AT MOUNT when the seed carries real lines (a visit's tasks, a lead's configurator
  // lines): the row exists before he types, so the Estimates list has it even if he leaves. A cold
  // open saves nothing until the first commit. (Dev strict mode mounts twice: the session is one, and
  // a second mount while the first save is on the wire sends nothing — the flash of "Saving…" is the
  // dev harness's, left as it is.)
  useEffect(() => {
    void session.mount();
  }, [session]);

  // THE PAGE READ THE ROW AGAIN (another door refreshed it: the customer card, the status select):
  // what landed replaces the mirror; a refused row keeps its typed value and its Retry. NOT WHILE A
  // WRITE IS ON THE WIRE OR SOMETHING TYPED IS UNCOMMITTED (S2): Next commits an action's props after
  // the action resolved, by which time the next write of a chain (the reprice pass, a catch-up) may
  // be out — those props are stale for it and would revert its figure and replace what he is typing.
  // A STANDING REFUSAL DOES NOT HOLD IT (skeptic #39, S2): the store keeps a refused row's typed value
  // and its Retry through a reseed, and gating on quiet meant a page re-read (the status, the customer
  // card, another door) never reached the mirror until he resolved a refused line. The effect re-runs
  // when busy or dirty flips and hands the seed over then; the store holds it the same way on its side.
  const reseedKey = props.mode === "saved" ? JSON.stringify([props.saved.quote, props.saved.items]) : "";
  const seededKey = useRef(reseedKey);
  const quiet = isQuiet(state);
  const dirty = session.isDirty();
  useEffect(() => {
    if (props.mode !== "saved" || seededKey.current === reseedKey) return;
    if (busy || dirty) return;
    seededKey.current = reseedKey;
    session.reseed({
      header: headerFrom(props),
      items: props.saved.items.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map(lineFromRow),
      status: props.saved.quote.status,
      number: props.saved.quote.quote_number,
    });
    // reseedKey stands for the row and its lines as the page read them; busy and dirty are the gates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reseedKey, busy, dirty]);

  /* ── WHO'S THIS FOR ───────────────────────────────────────────────────────────────────────── */
  // Customers created inline, merged into the server-provided list.
  const [addedCustomers, setAddedCustomers] = useState<CustomerOption[]>([]);
  const seedCustomers: CustomerOption[] = props.mode === "unsaved" ? props.seed.customers : props.saved.customers;
  const allCustomers = [...addedCustomers, ...seedCustomers];
  const leads: LeadOption[] | undefined = props.mode === "unsaved" ? props.seed.leads : undefined;
  // Resolve the markup via THE one rule (effectiveMarkupPct): the selected customer's pricing-level
  // markup → the item's own markup when > 0 → the org default → 0. On the saved page the level
  // comes with the row (the customer card writes it; the page reads it back); on the new page it
  // follows the picker.
  const selectedCust = allCustomers.find((c) => c.id === header.customerId);
  const levelMarkup = props.mode === "saved" ? props.saved.level.markup : selectedCust?.level_markup ?? null;
  const levelRate = props.mode === "saved" ? props.saved.level.rate : selectedCust?.level_rate ?? null;
  // THE ONE PRICING INPUT for every door on this screen that turns a book item into a line.
  // `?? null`, never `?? 0`: a level ALWAYS wins, so a 0 here would sell every customer without a
  // level at net cost.
  const pricing: BookPricing = { levelPct: levelMarkup ?? null, orgDefaultPct: defaultMarkupPct ?? null };
  // THE ONE LABOR RATE RULE for the hours on this screen (laborRateFor): the customer's level rate
  // when the level has one, else the org default, else 0 — which a task line reads as "no rate set"
  // and SAYS, never a guessed hourly. This is the rule's answer for a row that names NOBODY; a row
  // that names a person asks the rule again with their Team rate on top (TaskBreakdown's ruleFor).
  const rule = laborRateFor({ levelRate, orgDefault: defaultLaborRate });

  // The attached lead ALWAYS has a row to sit on, even if it has been won/lost or aged out of the
  // server's list — a <Select> whose value matches no option renders the first one, which would
  // read "Nobody yet" over an estimate that is very much attached to somebody.
  const leadOptions = useMemo(() => {
    const list = (leads ?? []).slice();
    if (header.leadId && !list.some((l) => l.id === header.leadId)) list.unshift({ id: header.leadId, name: "The lead this estimate came from", company_name: null });
    return list;
  }, [leads, header.leadId]);
  const selectedLead = leadOptions.find((l) => l.id === header.leadId) ?? null;
  // A customer WINS the display slot when there is one — that's the order the printed document
  // and the Estimates list already resolve in (customers ?? inquiries). The lead stays attached
  // underneath as provenance, and is FIXED once the row exists (the first save stamped it).
  const whoValue = header.customerId ? `customer:${header.customerId}` : header.leadId ? `lead:${header.leadId}` : "";
  const leadsOffered = mode.kind === "unsaved";
  function pickWho(v: string) {
    if (v.startsWith("customer:")) {
      session.typeHeader({ customerId: v.slice("customer:".length) });
      void session.commitHeader("customerId");
      return; // the lead stays — it's where this estimate came from, not a competing answer
    }
    if (v.startsWith("lead:")) {
      // Picking a lead is the explicit statement that nobody has been made a customer yet.
      session.typeHeader({ leadId: v.slice("lead:".length), customerId: "" });
      void session.commitHeader("leadId");
      void session.commitHeader("customerId");
      return;
    }
    session.typeHeader({ customerId: "", ...(leadsOffered ? { leadId: "" } : {}) });
    void session.commitHeader("customerId");
    if (leadsOffered) void session.commitHeader("leadId");
  }
  const whoHint = selectedCust
    ? selectedLead
      ? `A customer — started from the lead ${selectedLead.name}.`
      : "" // a plain customer needs no explaining; a line saying "A customer." is noise
    : selectedLead
      ? `${selectedLead.name} is a lead. They become a customer when you win the work — you don't have to make one now.`
      : leadOptions.length || allCustomers.length
        ? "Pick the lead who asked for it, or a customer. You can leave this blank and decide later."
        : "No leads or customers yet — add a customer below, or leave this blank.";
  // The plan PDFs came off the lead this estimate is for. If the picker has since moved to a
  // different lead — or to none — they are somebody else's drawings and must stop being offered.
  const plansForLead = catalog.leadPlans && header.leadId === catalog.leadPlans.leadId ? catalog.leadPlans.files : [];
  /* ── THE LOCK ─────────────────────────────────────────────────────────────────────────────── */
  // The page's answer from the server rule (quoteEditLock → requireEditableQuote), and nothing else:
  // acceptance alone locks nothing, and a superseded estimate whose revision was deleted or walked
  // back is editable again — the rule says so, and a lock invented here from the status would
  // disagree with every write the server then accepts (S7).
  const lock: { reason: string } | null = props.mode === "saved" ? props.saved.lock : null;
  const readOnly = !!lock;

  /* ── LINES ────────────────────────────────────────────────────────────────────────────────── */
  // ADD A TASK (cn-v1131): a task line by hand — no inspection, no estimator. It lands under Tasks
  // reading "hours?" at $0 with its breakdown open (one labor row at the rule's rate, no parts:
  // emptyTaskDetail), and the description box takes focus so the next thing he types is its name.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  function addTask() {
    const detail = emptyTaskDetail(rule);
    setFocusKey(session.addLine({ description: "", quantity: 1, unit: "ea", unit_price: 0, group: "Tasks", detail, flag: taskFlags(detail) }));
  }
  // MAKE THIS A TASK: a plain line keeps its words, count and typed price (as a hand price — the
  // amber note says the breakdown stays off the paper until the hours and parts explain it) and
  // gains an empty breakdown to fill in (taskFromLine). A decision, so it is written at once.
  function makeTask(l: EditorLine) {
    void session.commitLine(l.key, taskFromLine(l, rule));
  }

  // THE RULE'S ANSWER FOLLOWS THE CUSTOMER AND THE CARDS (0386; rows cn-v1131), ON A DRAFT. When the
  // picker lands on a customer whose level carries its own rate, the company default changes under
  // a draft, or a person's Team rate moves, every task line's LABOR re-prices through ONE pure pass
  // (repricedLines → repriceRows). KEYED ON EVERY INPUT of the rule (ruleInputsKey). Not on the
  // first render — the seed and the row already carry their rate — never over a line he priced by
  // hand, and NEVER on a sent estimate (rule 5): there the chip says what the rule says now and the
  // figure stands until he taps Use …. On a saved draft each changed line is written, one deed.
  const ruleNow: RuleInputs = { levelRate, orgDefault: defaultLaborRate, people };
  const ruleKey = ruleInputsKey(ruleNow);
  const ruleSeen = useRef({ key: ruleKey, rate: rule.rate });
  useEffect(() => {
    if (ruleSeen.current.key === ruleKey) return;
    const prevRate = ruleSeen.current.rate;
    ruleSeen.current = { key: ruleKey, rate: rule.rate };
    void session.reprice(ruleNow, prevRate);
    // The key stands for every input the pass reads (ruleNow, rule.rate are this render's answers for it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleKey]);

  // Live totals via the shared subtotalTaxTotal (pure, client-safe) — the SAME rounding the server
  // (recalcQuote) uses, so the screen can never show a cent off from the row.
  const { subtotal, tax, total } = subtotalTaxTotal(
    items.map((i) => i.quantity * i.unit_price),
    header.taxRate || 0,
  );

  // Group the lines by their `group` tag (a kit, Tasks) so the estimate reads as collapsible groups.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (g: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });
  const grouped = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, EditorLine[]>();
    items.forEach((it) => {
      const g = it.group ?? "";
      if (!map.has(g)) {
        map.set(g, []);
        order.push(g);
      }
      map.get(g)!.push(it);
    });
    return order.map((g) => ({ group: g, entries: map.get(g)! }));
  }, [items]);

  /* ── THE ESTIMATOR ────────────────────────────────────────────────────────────────────────── */
  const [scope, setScope] = useState(props.mode === "unsaved" ? props.seed.initialScope ?? "" : "");
  /**
   * WHAT THE ESTIMATOR PROPOSED AND HAS NOT YET BEEN PUT ON THE ESTIMATE. Two lists, each meaning
   * one thing. Below: THE ESTIMATE — every line on it is there because he put it there. Here:
   * PROPOSALS — nothing on this list is on the estimate. A line leaves this list only by being
   * taken or dropped, and it is never in both. Client-side until accepted: a take goes through
   * ONE append (appendQuoteLines), or the first save.
   */
  const [proposed, setProposed] = useState<Proposal[]>([]);
  const [questions, setQuestions] = useState<string[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [generating, startGenerate] = useTransition();
  const [uploading, startUpload] = useTransition();
  // THE PRICE-BOOK REVIEW a supplier quote brought (what it knows that the book doesn't), open until
  // he applies it or says Not Now. Declared here because the hand-off below waits on it.
  const [bookReview, setBookReview] = useState<null | {
    source: string;
    updates: (BookUpdate & { keep: boolean })[];
    additions: (BookAddition & { keep: boolean })[];
    unchanged: number;
  }>(null);
  const [bookMsg, setBookMsg] = useState<string | null>(null);
  const [applyingBook, startApplyBook] = useTransition();

  /* ── THE HAND-OFF (S6): born here → its own page, once, at the first quiet moment ─────────── */
  // The estimate is on the server (the first save landed, the ids came back, nothing is queued,
  // refused or waiting), the estimator is not mid-read, nothing it said is still on the screen (an
  // error he has not acted on), and no price-book review is open: stash the UI text and navigate.
  // A supplier quote's lines birth the row only when he taps Add N To The Estimate, the same tap that
  // used to fire the hand-off — and the review panel beside them went with the page, unread. A real
  // navigation, so the saved page's status and lock are the server's and Back skips the unsaved
  // editor. Once: the ref holds through the re-renders between the call and the unmount.
  // WHEN THE STASH CANNOT BE KEPT (a full or blocked store) and there is text to carry — the scope,
  // proposals, questions — the editor does NOT navigate: it keeps working here, in saved mode. The
  // green line offers the saved page as a link (Open It) WHENEVER the editor is in saved mode on this
  // route — a failed stash, a hand-off still waiting on a refusal, on an estimator error he has not
  // dismissed, on an open review (skeptic #39, N3) — so the way to the row is never missing. Nothing
  // he typed is lost for a page move.
  const handedOff = useRef(false);
  useEffect(() => {
    if (props.mode !== "unsaved" || mode.kind !== "saved" || !mode.bornHere || handedOff.current) return;
    if (!quiet || generating || uploading || bookReview !== null || aiError !== null) return;
    handedOff.current = true;
    const kept = stashHandoff(browserStash(), mode.id, { scope, proposed, questions, number: mode.number });
    if (!kept && (scope.trim() || proposed.length || questions.length)) return; // stays here; the green line links the row
    router.replace(`/quotes/${mode.id}`);
    // The stash is read when the hand-off happens; the effect re-runs on the gates only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode, mode, quiet, generating, uploading, bookReview, aiError]);
  // The saved page takes the stash the new page left, once, on mount; the one green line says the
  // number the save came back with.
  const [born, setBorn] = useState<string | null>(null);
  useEffect(() => {
    if (props.mode !== "saved") return;
    const h = takeHandoff(browserStash(), props.saved.quote.id);
    if (!h) return;
    if (h.scope) setScope(h.scope);
    if (h.proposed.length) setProposed(h.proposed);
    if (h.questions.length) setQuestions(h.questions);
    setBorn(h.number ?? props.saved.quote.quote_number);
    // The row's id is fixed for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyDraft(res: { items: DraftLineItem[]; questions: string[]; description?: string }) {
    // A TASK ALREADY ON THE ESTIMATE IS NOT PROPOSED AGAIN. An inspection's tasks arrive twice: as
    // lines (the seed) and as words in the scope box; a generate on that scope would offer the same
    // tasks back and a tap would double them. Dropped here, and SAID in the questions list.
    const already: string[] = [];
    const fresh = res.items
      .filter((i) => i.description.trim())
      .filter((i) => {
        const dup = !!i.detail && items.some((it) => it.detail && it.description.trim() && sameTask(it.description, i.description));
        if (dup) already.push(i.description);
        return !dup;
      });
    setQuestions([...(res.questions ?? []), ...already.map((n) => `Already on the estimate: ${n}`)]);
    setProposed(fresh.map((i, n) => ({ ...i, pid: n, keep: true })));
    // THE SCOPE, POLISHED — as a DEFAULT: it fills a hole and never overwrites a hand.
    if (res.description?.trim() && !header.description.trim()) {
      session.typeHeader({ description: res.description.trim() });
      void session.commitHeader("description");
    }
  }

  /** Put the ticked proposals on the estimate. They leave this list; a line is never in both. */
  function acceptProposals() {
    const taking = proposed.filter((p) => p.keep);
    if (!taking.length) return;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void session.addLines(taking.map(({ pid, keep, ...line }) => line));
    setProposed(proposed.filter((p) => !p.keep));
  }
  const editProposal = (pid: number, patch: Partial<Proposal>) => setProposed((prev) => prev.map((p) => (p.pid === pid ? { ...p, ...patch } : p)));

  function onGenerate() {
    setAiError(null);
    startGenerate(async () => {
      // Price against THIS customer's level — markup AND labor rate (else the org defaults on the server).
      // WHEN THE LEAD SENT PLANS, GENERATE READS THEM: the text path names the attached PDFs.
      const res =
        plansForLead.length && header.leadId
          ? await generateQuoteDraftFromLeadPlans(header.leadId, scope, levelMarkup ?? undefined, levelRate ?? undefined)
          : await generateQuoteDraft(scope, levelMarkup ?? undefined, levelRate ?? undefined);
      if (!res.ok) {
        setAiError(res.error);
        return;
      }
      applyDraft(res);
    });
  }

  /** #116: the file goes to STORAGE, the action gets a PATH — Vercel caps request bodies at
   *  ~4.5MB, under one sheet of a real plan set. Org folder, so 0013's RLS owns access. */
  async function stashUpload(file: File): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    if (!orgId) return { ok: false, error: "Couldn't start the upload — reload the page and try again." };
    if (file.size > 20 * 1024 * 1024)
      return { ok: false, error: `That file is ${Math.round(file.size / 1024 / 1024)}MB — the plan reader's ceiling is 20MB. Split the PDF (Preview → Print → page range) and upload the sheets that matter.` };
    const supabase = createBrowserClient();
    const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
    const path = `${orgId}/ai-uploads/${crypto.randomUUID()}-${safe}`;
    const { error } = await supabase.storage.from("documents").upload(path, file, { contentType: file.type || undefined });
    if (error)
      return {
        ok: false,
        // Say what STORAGE said (audit 7): a project-cap refusal blamed the jobsite connection.
        error: /fetch|network|load failed/i.test(error.message ?? "")
          ? "Upload didn't finish — check your connection and try again."
          : `Upload refused: ${String(error.message ?? "storage error").slice(0, 140)}`,
      };
    return { ok: true, path };
  }
  function onUploadSupplier(file: File) {
    setAiError(null);
    startUpload(async () => {
      const stashed = await stashUpload(file);
      if (!stashed.ok) return setAiError(stashed.error);
      const fd = new FormData();
      fd.set("storagePath", stashed.path);
      fd.set("fileName", file.name);
      if (levelMarkup != null) fd.set("markupPct", String(levelMarkup));
      const res = await generateQuoteDraftFromSupplier(fd);
      if (!res.ok) {
        setAiError(res.error);
        return;
      }
      applyDraft(res);
      // THE BOOK REVIEW rides alongside the proposals. Ticks default OFF — Erik: "some people
      // arent going to want anything to override anything."
      setBookReview(
        res.bookReview.updates.length || res.bookReview.additions.length
          ? {
              source: `${file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 40)} · ${new Date().toLocaleDateString()}`,
              updates: res.bookReview.updates.map((u) => ({ ...u, keep: false })),
              additions: res.bookReview.additions.map((a) => ({ ...a, keep: false })),
              unchanged: res.bookReview.unchanged,
            }
          : null,
      );
    });
  }

  function applyBook() {
    if (!bookReview) return;
    startApplyBook(async () => {
      setBookMsg(null);
      const r = await applyPriceBookReview(
        bookReview.updates.filter((u) => u.keep).map((u) => ({ itemId: u.itemId, newBuy: u.newBuy })),
        bookReview.additions.filter((a) => a.keep).map((a) => ({ description: a.description, unit: a.unit, newBuy: a.newBuy })),
        bookReview.source,
      );
      if (!r.ok) return setBookMsg(r.error ?? "Couldn't update the price book.");
      setBookMsg(`Price book updated — ${r.updated ?? 0} price${(r.updated ?? 0) === 1 ? "" : "s"}, ${r.added ?? 0} new item${(r.added ?? 0) === 1 ? "" : "s"}.`);
      setBookReview(null);
    });
  }

  // Upload a plan PDF → Claude reads it natively (legend, schedules, notes, drawing) and takes it
  // off into the same price-book-priced lines + review questions.
  function onUploadPlan(file: File) {
    setAiError(null);
    startUpload(async () => {
      const stashed = await stashUpload(file);
      if (!stashed.ok) return setAiError(stashed.error);
      const fd = new FormData();
      fd.set("storagePath", stashed.path);
      fd.set("fileName", file.name);
      // The scope box rides along as a note that OVERRIDES the drawing.
      if (scope.trim()) fd.set("scope", scope.trim());
      if (levelMarkup != null) fd.set("markupPct", String(levelMarkup));
      if (levelRate != null) fd.set("laborRate", String(levelRate));
      // PLANS ARE KEPT (Erik's decision 3): filed as a Plan on the customer, and on the job when
      // there is one. The answer says where, or why not.
      if (header.jobId) fd.set("jobId", header.jobId);
      if (header.customerId) fd.set("customerId", header.customerId);
      const res = await generateQuoteDraftFromPlan(fd);
      if (!res.ok) {
        setAiError(res.kept ? `${res.error} ${res.kept.words}` : res.error);
        return;
      }
      applyDraft(res);
      toast(`Read ${file.name} — review the drafted lines.${res.kept ? ` ${res.kept.words}` : ""}`, "success", undefined, res.kept && !res.kept.kept ? { sticky: true } : undefined);
    });
  }

  // The customer's OWN plan, already in storage on the lead — same take-off, no re-upload.
  function onReadLeadPlan(p: { path: string; name: string }) {
    setAiError(null);
    startUpload(async () => {
      const fd = new FormData();
      fd.set("intakePath", p.path);
      fd.set("inquiryId", header.leadId);
      fd.set("fileName", p.name);
      if (scope.trim()) fd.set("scope", scope.trim());
      if (levelMarkup != null) fd.set("markupPct", String(levelMarkup));
      if (levelRate != null) fd.set("laborRate", String(levelRate));
      const res = await generateQuoteDraftFromPlan(fd);
      if (!res.ok) {
        setAiError(res.error);
        return;
      }
      applyDraft(res);
      toast(`Read ${p.name} — review the drafted lines`, "success");
    });
  }

  /* ── HEADER FIELDS: typed into the mirror, committed on blur / Enter / a pick ─────────────── */
  const typeField = (field: HeaderField, value: string | number) => session.typeHeader({ [field]: value } as Partial<EstimateHeader>);
  const commitField = (field: HeaderField) => void session.commitHeader(field);
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };
  const refusal = (slot: string) => state.refusals[slot];
  const retry = (slot: string) => () => void session.retry(slot);
  /** Under a header field: its refusal with Retry, or its queued-behind-the-wire words. */
  const fieldWords = (slot: string) => (
    <>
      {refusal(slot) && <Refused words={refusal(slot)!} onRetry={retry(slot)} disabled={busy} />}
      <Waiting words={state.waiting[slot]} />
    </>
  );
  // The tax field: the org's rates as a select while the typed rate is one of them; a figure that
  // is nobody's rate (an older estimate, Sales Tax off) is shown as the percent it is.
  const [taxShown] = useState(() => taxFieldShown(salesTax, { tax_rate: header.taxRate }));
  const taxChoice = taxRates.find((t) => Number(t.rate) / 100 === header.taxRate)?.id ?? "";
  const taxAsSelect = salesTax && taxRates.length > 0 && (header.taxRate === 0 || taxChoice !== "");

  /* ── THE SAVED HEADER: the number, the status, every door the page had ────────────────────── */
  const savedPage = props.mode === "saved" ? props.saved : null;
  const number = mode.kind === "saved" ? mode.number ?? "" : "";
  const quoteDocType: QuoteDocType = header.docType;
  const tree =
    savedId && mode.kind === "saved"
      ? quoteTree({
          id: savedId,
          number: number || "this estimate",
          status,
          jobId: header.jobId,
          lineCount: items.filter((l) => l.description.trim()).length,
          existing: savedPage?.existing ?? { invoice: null, workOrder: null, materialList: null },
          revisesId: savedPage?.quote.revises_quote_id ?? null,
        })
      : null;
  const revises = savedPage?.revises ?? null;
  const supersededBy = savedPage?.supersededBy ?? null;
  const revisesWords = !revises
    ? ""
    : revises.status === "superseded"
      ? " — which it superseded when accepted."
      : status === "accepted"
        ? ` — that estimate stands as ${revises.status ?? "it was"}, not superseded.`
        : status === "draft" || status === "sent"
          ? " — accepting this one supersedes it."
          : ".";

  return (
    <div>
      {savedId && mode.kind === "saved" && (
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            {/* TWO LAYERS, NOT ONE ROW: the group takes the remaining width and wraps inside itself,
                while the share stays parked top-right on the first line at every width. */}
            <div className="flex items-start gap-3">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
                <h1 className="min-w-0 text-2xl font-bold text-slate-900">{number}</h1>
                <Badge tone={statusTone(status)}>{status}</Badge>
                {/* The status is what makes this gate work: past draft the toggle reads as text. */}
                <QuoteTypeToggle id={savedId} status={status} value={quoteDocType} />
              </div>
              <ShareIconButton load={(opts) => quoteShareText(savedId, opts)} className="ml-auto shrink-0" />
            </div>
            {header.title && <p className="mt-1 text-slate-600">{header.title}</p>}
            {/* REVISIONS (0391), both ways. */}
            {supersededBy && (
              <p className="mt-1 text-sm text-slate-600">
                Superseded by{" "}
                <Link href={`/quotes/${supersededBy.id}`} className="text-brand hover:underline">
                  {supersededBy.quote_number ?? "its revision"}
                </Link>{" "}
                — that estimate is the price for this work now.
              </p>
            )}
            {revises && (
              <p className="mt-1 text-sm text-slate-600">
                Revises{" "}
                <Link href={`/quotes/${revises.id}`} className="text-brand hover:underline">
                  {revises.quote_number ?? "an earlier estimate"}
                </Link>
                {revisesWords}
              </p>
            )}
            {/* Provenance backlinks — the lead, the visit. */}
            {savedPage?.lead && (
              <Link href={`/leads?focus=${savedPage.lead.id}`} className="mt-1 inline-block text-sm text-brand hover:underline">
                ← From Lead: {savedPage.lead.name}
              </Link>
            )}
            {savedPage?.visitBehind && (
              <Link href={`/appointments/${savedPage.visitBehind.id}`} className="mt-1 block text-sm text-brand hover:underline">
                ← From The Visit{savedPage.visitBehind.starts_at ? ` on ${formatDate(savedPage.visitBehind.starts_at)}` : ""}
              </Link>
            )}
            {/* What the customer attached at intake: this estimate is the thing being priced FROM them. */}
            {savedPage?.lead && <IntakeFiles inquiryId={savedPage.lead.id} paths={savedPage.lead.intakePaths} />}
            {savedPage && (
              <p className="mt-1 text-sm text-slate-400">
                Created {formatDate(savedPage.quote.created_at)}
                {header.validUntil ? ` · Valid until ${formatDate(header.validUntil)}` : ""}
              </p>
            )}
            {(mode.bornHere || born) && (
              <p className="mt-1 text-xs text-emerald-700">
                Saved as {number || born}
                {props.mode === "unsaved" ? (
                  <>
                    {" · "}
                    <Link href={`/quotes/${savedId}`} className="font-semibold underline">
                      Open It
                    </Link>
                  </>
                ) : (
                  <> — it&apos;s on the Estimates list even if you leave.</>
                )}
              </p>
            )}
          </div>
          {/* Impulse verbs first (Send / advance status / Duplicate); the ⋯ Actions menu rides LAST. */}
          <div className="flex flex-wrap items-center gap-2">
            <EmailButton id={savedId} kind="quote" textReady={catalog.textReady} />
            <StatusControl id={savedId} status={status} />
            {(catalog.estimatesOn || lock) && <DuplicateQuoteButton id={savedId} />}
            {(catalog.estimatesOn || lock) && (status === "sent" || status === "accepted") && <DuplicateQuoteButton id={savedId} revision />}
            {tree && <SectionActionsMenu tree={tree} />}
          </div>
        </div>
      )}

      {/* The customer card, when the page read the full row (the new page's picker sits in the sidebar). */}
      {savedPage && savedId && (
        <Card className="mb-6">
          <CardContent className="py-5">
            <CustomerSelect quoteId={savedId} customer={savedPage.customer} lead={savedPage.lead} customers={savedPage.customers} />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* AI drafting — not on a locked estimate: nothing it proposes could land. */}
          {!readOnly && (
            <Card className="border-brand/30 bg-brand-light/40">
              <CardContent className="space-y-3 py-5">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-brand" />
                  <h3 className="text-sm font-semibold text-slate-900">Draft with Estimator</h3>
                </div>
                {/* THE SENTENCE MATCHES THE DOOR (onboarding-truth-law). */}
                <p className="text-xs text-slate-500">
                  {estimatorTaskMode && !plansForLead.length
                    ? "Splits your scope into tasks, one line each, with the hours and parts you wrote. Nothing is priced for you: a task without hours asks for them."
                    : "Priced from your price book (your net cost + markup). Items not in the book come in at a Home Depot estimate, flagged to confirm."}
                </p>
                <Textarea
                  rows={3}
                  placeholder="Describe the work — or, with a plan uploaded, what's already done or excluded, in your own words: which parts, how many, and what's already in."
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                />
                {/* The error has a way off the screen (skeptic #39, N3): the hand-off waits on it, so a
                    stale one held a born-here estimate on this route for good. Title Case: a button. */}
                {aiError && (
                  <p className="text-sm text-red-600">
                    {aiError}{" "}
                    <button type="button" onClick={() => setAiError(null)} className="font-semibold underline">
                      Dismiss
                    </button>
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" onClick={onGenerate} disabled={generating || uploading || busy}>
                    {generating ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Generating…
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" /> Generate Line Items
                      </>
                    )}
                  </Button>
                  {plansForLead.length > 0 && !generating && (
                    <span className="text-xs text-slate-500">reads their plans ({plansForLead.map((p) => p.name).join(", ")})</span>
                  )}
                </div>
                <div className="flex items-center gap-3 pt-1">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-400">or</span>
                  <DropTarget onFiles={(files) => onUploadPlan(files[0])} accept="application/pdf" multiple={false} label="Drop the Plan PDF" disabled={uploading || generating}>
                    <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-brand/40 bg-white/60 px-3 py-2 text-sm font-medium text-brand hover:bg-brand-light/40 ${uploading ? "pointer-events-none opacity-60" : ""}`}>
                      {uploading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" /> Reading plan…
                        </>
                      ) : (
                        <>
                          <FileUp className="h-4 w-4" /> Upload Plans
                        </>
                      )}
                      <input
                        type="file"
                        accept="application/pdf"
                        className="hidden"
                        disabled={uploading || generating}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) onUploadPlan(f);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </DropTarget>
                  <DropTarget onFiles={(files) => onUploadSupplier(files[0])} accept="application/pdf,text/csv,.csv,.txt" multiple={false} label="Drop the Supplier Quote" disabled={uploading || generating}>
                    <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white/60 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 ${uploading ? "pointer-events-none opacity-60" : ""}`}>
                      <FileUp className="h-4 w-4" /> Supplier Quote
                      <input
                        type="file"
                        accept="application/pdf,text/csv,.csv,.txt"
                        className="hidden"
                        disabled={uploading || generating}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) onUploadSupplier(f);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </DropTarget>
                  {scope.trim() && !uploading && <span className="text-xs text-slate-400">applies your note above to the plan</span>}
                </div>
                <p className="text-xs text-slate-500">
                  Plans are kept as Plans on the customer{header.jobId ? " and this job" : ""}. A supplier quote is read, then deleted, so its prices never sit where the crew can open them.
                </p>
                {plansForLead.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <span className="text-xs font-medium text-slate-500">Their plans are already here:</span>
                    {plansForLead.map((p) => (
                      <button
                        key={p.path}
                        type="button"
                        disabled={uploading || generating}
                        onClick={() => onReadLeadPlan(p)}
                        className={`inline-flex items-center gap-1.5 rounded-lg border border-dashed border-brand/40 bg-white/60 px-2.5 py-1.5 text-xs font-medium text-brand hover:bg-brand-light/40 ${uploading ? "pointer-events-none opacity-60" : ""}`}
                      >
                        <FileUp className="h-3.5 w-3.5" /> Read {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* THE PRICE-BOOK REVIEW — what this supplier quote knows that the book doesn't. */}
          {(bookReview || bookMsg) && !uploading && (
            <Card className="border-slate-300">
              <CardContent className="py-4">
                {bookMsg && <p className="text-sm font-medium text-emerald-700">{bookMsg}</p>}
                {bookReview && (
                  <>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-900">Update your price book from this quote?</h3>
                        <p className="text-xs text-slate-500">
                          Tick what you want &mdash; nothing changes unless you apply.
                          {bookReview.unchanged > 0 && ` ${bookReview.unchanged} matched at the same price.`}
                        </p>
                      </div>
                      <button type="button" onClick={() => setBookReview(null)} className="text-xs text-slate-400 hover:text-slate-900">
                        Not Now
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      {bookReview.updates.map((u, i) => (
                        <div key={u.itemId}>
                          <label className="flex min-h-[36px] cursor-pointer items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              checked={u.keep}
                              onChange={(e) => setBookReview((p) => p && { ...p, updates: p.updates.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)) })}
                            />
                            <span className="min-w-0 truncate">
                              {u.description}
                              {u.code ? <span className="ml-1 font-mono text-xs text-slate-400">[{u.code}]</span> : null}
                            </span>
                            <span className="ml-auto whitespace-nowrap font-mono text-xs tabular-nums">
                              {/* THE UNITS, ALWAYS (v800 audit). */}
                              <span className="text-slate-400 line-through">
                                ${u.oldBuy.toFixed(2)}
                                {u.oldUnit ? `/${u.oldUnit}` : ""}
                              </span>
                              {" → "}
                              <span className={u.newBuy > u.oldBuy ? "text-rose-700" : "text-emerald-700"}>
                                ${u.newBuy.toFixed(2)}
                                {u.newUnit ? `/${u.newUnit}` : ""}
                              </span>
                            </span>
                          </label>
                          {u.unitMismatch && (
                            <p className="pl-6 text-xs font-medium text-amber-700">
                              Different units — the quote is per {u.newUnit}, your book is per {u.oldUnit}. Check before you tick this, or the price is wrong by whatever a {u.newUnit} holds.
                            </p>
                          )}
                        </div>
                      ))}
                      {bookReview.additions.map((a, i) => (
                        <label key={`add-${i}`} className="flex min-h-[36px] cursor-pointer items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={a.keep}
                            onChange={(e) => setBookReview((p) => p && { ...p, additions: p.additions.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)) })}
                          />
                          <span className="min-w-0 truncate">{a.description}</span>
                          <span className="ml-auto whitespace-nowrap font-mono text-xs tabular-nums text-slate-600">
                            new · ${a.newBuy.toFixed(2)}/{a.unit}
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="mt-3">
                      <Button type="button" size="sm" onClick={applyBook} disabled={applyingBook || !(bookReview.updates.some((u) => u.keep) || bookReview.additions.some((a) => a.keep))}>
                        {applyingBook ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        Apply {bookReview.updates.filter((u) => u.keep).length + bookReview.additions.filter((a) => a.keep).length} To The Price Book
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* THE READOUT: WHAT IT PROPOSED, AND NOTHING ELSE. None of this is on your estimate. */}
          {(proposed.length > 0 || questions.length > 0) && !generating && !uploading && (
            <Card className="border-brand/30">
              <CardContent className="py-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      {proposed.length ? `Proposed — ${proposed.length} line${proposed.length === 1 ? "" : "s"}` : "Worth checking"}
                    </h3>
                    {proposed.length > 0 && <p className="text-xs text-slate-500">Nothing here is on your estimate yet.</p>}
                  </div>
                  {proposed.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => {
                        const allOn = proposed.every((p) => p.keep);
                        setProposed(proposed.map((p) => ({ ...p, keep: !allOn })));
                      }}
                      className="text-xs font-medium text-slate-500 hover:text-slate-900"
                    >
                      {proposed.every((p) => p.keep) ? "Untick All" : "Tick All"}
                    </button>
                  ) : proposed.length === 0 && questions.length > 0 ? (
                    <button onClick={() => setQuestions([])} className="text-xs text-slate-400 hover:text-slate-900">
                      Clear
                    </button>
                  ) : null}
                </div>
                <div className="space-y-2">
                  {proposed.map((p) => (
                    <div key={p.pid} className={`grid grid-cols-12 items-start gap-2 rounded-lg border p-2 ${p.keep ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50/70 opacity-55"}`}>
                      <div className="col-span-1 pt-2.5">
                        <input type="checkbox" className="h-4 w-4" checked={p.keep} onChange={(e) => editProposal(p.pid, { keep: e.target.checked })} aria-label={`Add ${p.description}`} />
                      </div>
                      <div className="col-span-11 sm:col-span-4">
                        <Input placeholder="Description" value={p.description} onChange={(e) => editProposal(p.pid, { description: e.target.value })} />
                        {p.flag && <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">{p.flag}</span>}
                      </div>
                      <div className="col-span-3 sm:col-span-2">
                        <NumberInput placeholder="Qty" value={p.quantity} onValueChange={(n) => editProposal(p.pid, { quantity: n })} />
                      </div>
                      <div className="col-span-3 sm:col-span-1">
                        <Input placeholder="ea" value={p.unit} onChange={(e) => editProposal(p.pid, { unit: e.target.value })} />
                      </div>
                      <div className="col-span-4 sm:col-span-2">
                        <NumberInput placeholder="Unit $" value={p.unit_price} onValueChange={(n) => editProposal(p.pid, { unit_price: n })} />
                      </div>
                      <div className="col-span-2 flex items-center justify-end gap-1">
                        <span className="text-sm font-medium text-slate-700">{formatCurrency(p.quantity * p.unit_price)}</span>
                        <button type="button" onClick={() => setProposed((prev) => prev.filter((x) => x.pid !== p.pid))} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Drop this proposal">
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                {proposed.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button variant="primary" onClick={acceptProposals} disabled={!proposed.some((p) => p.keep) || busy}>
                      <Check className="h-4 w-4" />
                      Add {proposed.filter((p) => p.keep).length} To The Estimate
                    </Button>
                    <button type="button" onClick={() => setProposed([])} className="text-sm text-slate-500 hover:text-slate-900">
                      Drop Them All
                    </button>
                    <span className="text-sm text-slate-500">{formatCurrency(proposed.filter((p) => p.keep).reduce((t, p) => t + p.quantity * p.unit_price, 0))}</span>
                  </div>
                )}
                {questions.length > 0 && (
                  <div className={proposed.length ? "mt-4 border-t border-slate-200 pt-3" : ""}>
                    {proposed.length > 0 && <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Worth checking</h4>}
                    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
                      {questions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Line items */}
          <Card>
            <CardContent className="py-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">Line items</h3>
                {!readOnly && (
                  <div className="flex items-center gap-2">
                    {/* A task is a line with its hours and parts behind it; a line is just a line. */}
                    <Button size="sm" variant="outline" onClick={addTask} disabled={busy}>
                      <ListPlus className="h-4 w-4" /> Add A Task
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => session.addLine(blankItem())} disabled={busy}>
                      <Plus className="h-4 w-4" /> Add A Line
                    </Button>
                  </div>
                )}
              </div>

              {readOnly ? (
                // A LOCKED LINE IS A READING, NOT A FORM. No click-to-edit; the reason is named below.
                <ul className="divide-y divide-slate-100">
                  {items.map((it) => (
                    <li key={it.key} className="flex items-center gap-3 py-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <LineItemText description={it.description} className="block font-medium text-slate-800" />
                        <div className="text-xs text-slate-400">
                          {it.quantity} {it.unit} × {formatCurrency(it.unit_price)}
                        </div>
                      </div>
                      <div className="shrink-0 font-medium text-slate-900">{formatCurrency(it.quantity * it.unit_price)}</div>
                    </li>
                  ))}
                  {items.length === 0 && <li className="py-6 text-center text-sm text-slate-400">No line items yet.</li>}
                  <li className="mt-3 rounded-lg bg-slate-50/60 px-4 py-3">
                    <div className="text-sm font-medium text-slate-800">These line items are locked</div>
                    <p className="mt-0.5 text-sm text-slate-600">{lock?.reason}</p>
                  </li>
                </ul>
              ) : (
                <>
                  {/* ONE PICKER, THREE SURFACES (add-line-items.tsx). A kit's lines keep their group. It waits
                      with every other add door while a write runs, so a pick cannot land mid-flight. */}
                  <AddLineItems priceItems={priceItems} kits={kits as never} pricing={pricing} measured={measured} disabled={busy} onAdd={(lines) => void session.addLines(lines)} />
                  {priceItems.length === 0 && kits.length === 0 && (
                    <p className="mb-3 text-xs text-slate-500">
                      No price list or kits yet, so there&apos;s nothing to pick from. Type the lines by hand below, or build your catalog under Money → Price List and they&apos;ll show up here.
                    </p>
                  )}
                  <div className="space-y-2">
                    {grouped.map(({ group, entries }) => {
                      const gSub = subtotalTaxTotal(entries.map((it) => it.quantity * it.unit_price), 0).subtotal;
                      const isCollapsed = collapsed.has(group);
                      // NO overflow-hidden on the group box: it clipped the price-book dropdown of every
                      // line inside it. The header rounds its own corners instead.
                      return (
                        <div key={group || "__ungrouped"} className={group ? "rounded-lg border border-slate-200" : ""}>
                          {group && (
                            <button
                              type="button"
                              onClick={() => toggleGroup(group)}
                              className={`flex w-full items-center gap-2 bg-slate-50 px-3 py-2 text-left hover:bg-slate-100 ${isCollapsed ? "rounded-lg" : "rounded-t-lg"}`}
                            >
                              {isCollapsed ? <ChevronRight className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                              <span className="text-sm font-semibold text-slate-800">{group}</span>
                              <span className="text-xs text-slate-400">
                                · {entries.length} item{entries.length === 1 ? "" : "s"}
                              </span>
                              <span className="ml-auto text-sm font-medium text-slate-600">{formatCurrency(gSub)}</span>
                            </button>
                          )}
                          {!(group && isCollapsed) && (
                            <div className={`space-y-2 ${group ? "p-2" : ""}`}>
                              {entries.map((it) => {
                                const lineWords = refusal(`line:${it.key}`) ?? refusal(`delete:${it.key}`);
                                const lineSlot = refusal(`line:${it.key}`) ? `line:${it.key}` : `delete:${it.key}`;
                                const waiting = state.waiting[`line:${it.key}`];
                                const follow = state.follow[it.key];
                                return (
                                  <div key={it.key} className="grid grid-cols-12 items-start gap-2 rounded-lg border border-slate-100 p-2">
                                    <div className="col-span-12 sm:col-span-5">
                                      <LineDescInput
                                        value={it.description}
                                        disabled={busy}
                                        onText={(v) => session.typeLine(it.key, { description: v })}
                                        onBlur={() => void session.commitLine(it.key)}
                                        onPick={(pi) => {
                                          // THE ONE PRICE (priceBookLine): the vendor the org made the
                                          // default when there is one, named in the description, else
                                          // the item's own. A pick is a decision: written at once.
                                          const line = priceBookLine(pi, pricing);
                                          // THE NOTE STAYS (skeptic #43, S6): the book's words replace
                                          // the head; the note he typed under the line is still his.
                                          void session.commitLine(it.key, {
                                            ...it,
                                            description: joinLineNote(line.description, splitLineNote(it.description).note),
                                            unit: line.unit,
                                            unit_price: line.unitPrice,
                                          });
                                        }}
                                        priceItems={priceItems}
                                        pricing={pricing}
                                        // The line Add A Task just made takes the cursor, once.
                                        autoFocus={focusKey === it.key}
                                        onFocus={() => {
                                          if (focusKey === it.key) setFocusKey(null);
                                        }}
                                      />
                                      {it.flag && <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">{it.flag}</span>}
                                      {/* THE TASK IS THE LINE (0386): a line built from a task shows its
                                          hours and parts here, and the Unit $ follows them. */}
                                      {it.detail ? (
                                        <TaskBreakdown
                                          // Keyed by the TASK, not the row: a line deleted above must not
                                          // hand its kit panel and its "Remembered as…" to the next line.
                                          key={it.detail.task_id || `line-${it.key}`}
                                          line={it}
                                          detail={it.detail}
                                          priceItems={priceItems}
                                          pricing={pricing}
                                          taskKits={taskKits}
                                          kitsOn={kitsOn}
                                          scopeWord={scopeWord}
                                          people={people}
                                          levelRate={levelRate ?? null}
                                          defaultLaborRate={defaultLaborRate}
                                          disabled={busy}
                                          onChange={(next) => session.typeLine(it.key, next)}
                                          onCommit={(next) => void session.commitLine(it.key, next)}
                                        />
                                      ) : (
                                        // A plain line can become a task (cn-v1131): its words and price stay,
                                        // and the hours and parts open beneath it.
                                        <button type="button" disabled={busy} onClick={() => makeTask(it)} className="mt-1 text-[11px] text-slate-400 hover:text-brand hover:underline disabled:opacity-50">
                                          Make This A Task
                                        </button>
                                      )}
                                      <Waiting words={waiting} />
                                      {lineWords && <Refused words={lineWords} onRetry={retry(lineSlot)} disabled={busy} />}
                                      {/* The job behind an accepted estimate followed the rename — or could not. Said either way. */}
                                      {follow?.said && <p className="mt-1 text-xs text-slate-500">{follow.said}</p>}
                                      {follow?.note && <p className="mt-1 text-xs text-amber-700">{follow.note}</p>}
                                    </div>
                                    <div className="col-span-3 sm:col-span-2">
                                      <NumberInput placeholder="Qty" value={it.quantity} disabled={busy} onValueChange={(n) => session.typeLine(it.key, { quantity: n })} onBlur={() => void session.commitLine(it.key)} />
                                    </div>
                                    <div className="col-span-3 sm:col-span-1">
                                      <Input placeholder="ea" value={it.unit} disabled={busy} onChange={(e) => session.typeLine(it.key, { unit: e.target.value })} onBlur={() => void session.commitLine(it.key)} onKeyDown={blurOnEnter} />
                                    </div>
                                    <div className="col-span-4 sm:col-span-2">
                                      <NumberInput placeholder="Unit $" value={it.unit_price} disabled={busy} onValueChange={(n) => session.typeLine(it.key, { unit_price: n })} onBlur={() => void session.commitLine(it.key)} />
                                    </div>
                                    <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-2">
                                      <span className="text-sm font-medium text-slate-700">{formatCurrency(it.quantity * it.unit_price)}</span>
                                      <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void session.removeLine(it.key)}
                                        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                                        aria-label="Remove line"
                                      >
                                        <Trash2 className="h-4 w-4" />
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {/* What a removed line's job task did — the line is gone, so it sits under the list. */}
                  {state.said && <p className="mt-3 text-sm text-slate-500">{state.said}</p>}
                  {/* A kit, accepted proposals or the rule pass that did not land: said here, with the one way to run it again. */}
                  {Object.keys(state.refusals)
                    .filter((s) => s.startsWith("append:") || s === "reprice")
                    .map((s) => (
                      <Refused key={s} words={state.refusals[s]} onRetry={retry(s)} disabled={busy} />
                    ))}
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar: details + totals */}
        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-4 py-5">
              {/* What the customer's document calls itself. Once the row exists the header's toggle is
                  the one door (QuoteTypeToggle, which reads as text past draft). */}
              {mode.kind === "unsaved" && (
                <div title="Quote = fixed price · Estimate = time & materials">
                  <Label>Document</Label>
                  <div className={busy ? "pointer-events-none opacity-60" : undefined}>
                    <SegmentedControl
                      stretch
                      activeId={header.docType}
                      onSelect={(id) => {
                        if (busy) return;
                        typeField("docType", id);
                        commitField("docType");
                      }}
                      items={[
                        { id: "quote", label: "Quote (Fixed)" },
                        { id: "estimate", label: "Estimate (T&M)" },
                      ]}
                    />
                  </div>
                  {fieldWords("header:docType")}
                </div>
              )}
              {!savedPage && (
                <div>
                  <Label htmlFor="who">Who&apos;s this for?</Label>
                  <Select id="who" value={whoValue} disabled={busy} onChange={(e) => pickWho(e.target.value)}>
                    <option value="">— Nobody yet —</option>
                    {leadOptions.length > 0 && (
                      <optgroup label={leadsOffered ? "Leads — not customers yet" : "The lead this estimate came from"}>
                        {(leadsOffered ? leadOptions : leadOptions.filter((l) => l.id === header.leadId)).map((l) => (
                          <option key={l.id} value={`lead:${l.id}`}>
                            {l.name}
                            {l.company_name ? ` (${l.company_name})` : ""}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {allCustomers.length > 0 && (
                      <optgroup label="Customers">
                        {allCustomers.map((c) => (
                          <option key={c.id} value={`customer:${c.id}`}>
                            {c.name}
                            {c.company_name ? ` (${c.company_name})` : ""}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </Select>
                  {whoHint && <p className="mt-1.5 text-xs text-slate-500">{whoHint}</p>}
                  {fieldWords("header:customerId")}
                  <NewCustomerInline
                    className="mt-1.5"
                    onCreated={(c) => {
                      setAddedCustomers((prev) => [{ id: c.id, name: c.name, company_name: null }, ...prev]);
                      session.typeHeader({ customerId: c.id });
                      void session.commitHeader("customerId");
                    }}
                  />
                </div>
              )}
              <div>
                <Label htmlFor="title">Title</Label>
                <Input id="title" placeholder="What the job is, in a few words" value={header.title} disabled={busy} onChange={(e) => typeField("title", e.target.value)} onBlur={() => commitField("title")} onKeyDown={blurOnEnter} />
                {fieldWords("header:title")}
              </div>
              <div>
                <Label htmlFor="q-description">
                  Description <span className="font-normal text-slate-400">(shows above the line items)</span>
                </Label>
                <Textarea
                  id="q-description"
                  rows={3}
                  placeholder="Scope summary the customer reads before the line items."
                  value={header.description}
                  disabled={busy}
                  onChange={(e) => typeField("description", e.target.value)}
                  onBlur={() => commitField("description")}
                />
                {fieldWords("header:description")}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {taxShown && (
                  <div>
                    <Label htmlFor="tax">Tax rate</Label>
                    {readOnly ? (
                      // The same substitution the invoice page makes on a sent bill: the rate as text,
                      // not an input that can only be refused.
                      <>
                        <div id="tax" className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                          {(header.taxRate * 100).toFixed(2)}%
                        </div>
                        <p className="mt-1 text-xs text-slate-500">Changing the rate would change the total. {lock?.reason}</p>
                      </>
                    ) : taxAsSelect ? (
                      <Select
                        id="tax"
                        value={taxChoice}
                        disabled={busy}
                        onChange={(e) => {
                          const r = taxRates.find((t) => t.id === e.target.value);
                          typeField("taxRate", r ? Number(r.rate) / 100 : 0);
                          commitField("taxRate");
                        }}
                      >
                        <option value="">No Tax</option>
                        {taxRates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} ({Number(t.rate)}%)
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input
                        id="tax"
                        type="number"
                        step="any"
                        placeholder="8.25"
                        value={header.taxRate ? +(header.taxRate * 100).toFixed(4) : ""}
                        disabled={busy}
                        onChange={(e) => typeField("taxRate", (Number(e.target.value) || 0) / 100)}
                        onBlur={() => commitField("taxRate")}
                        onKeyDown={blurOnEnter}
                      />
                    )}
                    {fieldWords("header:taxRate")}
                  </div>
                )}
                <div>
                  <Label htmlFor="valid">Valid until</Label>
                  <Input id="valid" type="date" value={header.validUntil} disabled={busy} onChange={(e) => typeField("validUntil", e.target.value)} onBlur={() => commitField("validUntil")} />
                  {fieldWords("header:validUntil")}
                </div>
              </div>
              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" rows={3} value={header.notes} disabled={busy} onChange={(e) => typeField("notes", e.target.value)} onBlur={() => commitField("notes")} />
                {fieldWords("header:notes")}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-2 py-5 text-sm">
              {/* THE PAPER SWITCH (cn-v1131): whether the task lines print their labor and parts beneath
                  them on THIS estimate. Only while the estimate is still editable. */}
              {!readOnly && (
                <div className="border-b border-slate-100 pb-3">
                  <PaperFormatSwitch
                    value={header.estimateFormat}
                    companyDefault={companyEstimateFormat}
                    disabled={busy}
                    onChange={(v) => {
                      session.typeHeader({ estimateFormat: v });
                      commitField("estimateFormat");
                    }}
                  />
                  {fieldWords("header:estimateFormat")}
                </div>
              )}
              <div className="flex justify-between text-slate-600">
                <span>Subtotal</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              {taxFieldShown(salesTax, { tax }) && (
                <div className="flex justify-between text-slate-600">
                  <span>Tax</span>
                  <span>{formatCurrency(tax)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-slate-100 pt-2 text-base font-semibold text-slate-900">
                <span>Total</span>
                <span>{formatCurrency(total)}</span>
              </div>
              {/* THE ONE SAVE MODEL, SAID: a write on the wire, the first save that did not land. */}
              {busy && <p className="pt-1 text-xs text-slate-400">Saving…</p>}
              {refusal("first-save") && <Refused words={refusal("first-save")!} onRetry={retry("first-save")} disabled={busy} />}
              {refusal("read-back") && <Refused words={refusal("read-back")!} onRetry={retry("read-back")} disabled={busy} />}
              {mode.kind === "unsaved" && !busy && !refusal("first-save") && (
                <p className="pt-1 text-xs text-slate-400">Saves itself the moment you put something on it.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {savedPage?.showCircuits && savedId && (
        <div className="mt-6">
          <CircuitScheduleCard quoteId={savedId} initial={(savedPage.quote.circuits ?? []) as QuoteCircuit[]} panelJob={savedPage.panelJob} />
        </div>
      )}
    </div>
  );
}

/** For tests and the pages: the editor's seed types by name. */
export type { EditorLine, Mode, SessionState };
