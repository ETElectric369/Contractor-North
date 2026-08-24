"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { NewCustomerInline } from "@/components/new-customer-inline";
import { applyPriceBookReview } from "../../price-list/actions";
import type { BookUpdate, BookAddition } from "@/lib/pricing/book-review";
import { Plus, Trash2, Sparkles, Loader2, ChevronDown, ChevronRight, Check, X, FileUp, ListPlus } from "lucide-react";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented";
import { docLabel, type QuoteDocType } from "@/lib/doc-label";
import { formatCurrency } from "@/lib/utils";
import { effectiveMarkupPct } from "@/lib/pricing/markup";
import { buildDeckRatesWithMarkup, type DeckRateRow } from "@/lib/estimate/deck";
import { subtotalTaxTotal } from "@/lib/invoice-math";
import { useDraft } from "@/lib/use-draft";
import { quoteDraftKey, quoteDraftLegacyKeys } from "@/lib/quote-draft-key";
import { useToast } from "@/components/toast";
import {
  saveQuote,
  generateQuoteDraft,
  generateQuoteDraftFromLeadPlans,
  generateQuoteDraftFromPlan,
  generateQuoteDraftFromSupplier,
  type DraftLineItem,
} from "../actions";
import { AddLineItems } from "@/components/add-line-items";

interface CustomerOption {
  id: string;
  name: string;
  company_name: string | null;
  level_markup?: number | null;
  level_rate?: number | null;
}
interface PriceItemLite {
  id: string;
  code: string | null;
  description: string;
  category?: string | null;
  unit: string;
  buy_price: number;
  markup_pct: number;
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
type Proposal = DraftLineItem & { pid: number; keep: boolean };

const blankItem = (): DraftLineItem => ({
  description: "",
  quantity: 1,
  unit: "ea",
  unit_price: 0,
});

const sellPrice = (buy: number, markup: number) => buy * (1 + (markup || 0) / 100);

/** SWAP A LINE AGAINST THE BOOK (Andrew, live-testing the plan take-off: "we ended up going
 *  with a metal roof ... had that been a drop down, I would have just dropped it in there —
 *  or at the very least an autocomplete"): the description input of every line autocompletes
 *  against the org's price book; picking a match RE-PRICES the line in place — description,
 *  unit, and unit $ at this customer's markup, the same math as the Add picker. */
function LineDescInput({
  value,
  onText,
  onPick,
  priceItems,
  priced,
}: {
  value: string;
  onText: (v: string) => void;
  onPick: (p: PriceItemLite) => void;
  priceItems: PriceItemLite[];
  priced: (p: PriceItemLite) => number;
}) {
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (q.length < 2) return [];
    return priceItems
      .filter((p) => [p.code, p.description, p.category].some((v) => (v ?? "").toLowerCase().includes(q)))
      .slice(0, 8);
  }, [value, priceItems]);
  return (
    <div className="relative">
      <Input
        placeholder="Description"
        value={value}
        onChange={(e) => {
          onText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && priceItems.length === 0 && value.trim().length >= 2 && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 shadow-lg">
          No price book yet — upload or build one under Tools → Price List and these will autocomplete.
        </div>
      )}
      {open && matches.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {matches.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50"
                onMouseDown={(e) => {
                  // mousedown beats the input's blur — the pick must land before the list hides
                  e.preventDefault();
                  onPick(p);
                  setOpen(false);
                }}
              >
                <span className="truncate">{p.code ? `${p.code} — ${p.description}` : p.description}</span>
                <span className="shrink-0 text-slate-500">{formatCurrency(priced(p))}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function QuoteBuilder({
  customers,
  preselected,
  jobId,
  inquiryId,
  captureId,
  initialQuoteId,
  adoptedSeed,
  draftUserId,
  initialScope,
  seededLines,
  priceItems = [],
  taxRates = [],
  kits = [],
  quoteExpiryDays = 30,
  defaultMarkupPct = 0,
  deckRateRows,
  measured,
  orgId = "",
  leadPlans = [],
}: {
  /** For storage-first uploads (#116): the org folder the documents bucket's RLS admits. */
  orgId?: string;
  customers: CustomerOption[];
  /** Measurements the inspector already took on the walk-through (?capture=). They prefill the
   *  kit picker's sizing boxes, so nobody types a number twice — which is the whole reason the
   *  inspection sheet asks for them as NUMBERS instead of prose. */
  measured?: { sqft?: number | null; linearFt?: number | null };
  preselected?: string;
  /** When launched from a job, the quote attaches to it. */
  jobId?: string;
  /** When launched from a lead conversion, the quote keeps the provenance backlink. */
  inquiryId?: string;
  /** An existing DRAFT for this lead/walk-through, found server-side at mount — the builder
      adopts it so cross-session re-entry (or a different door) updates ONE row instead of
      minting twins (review of cn-v796). */
  initialQuoteId?: string | null;
  /** Signed-in user id — namespaces the sessionStorage draft slot (quoteDraftKey v3). */
  draftUserId?: string | null;
  /** The adopted draft's CONTENT — the builder must start from what the row holds, or its
      empty defaults would autosave over the real lines (the Q-001 wipe hazard). */
  adoptedSeed?: {
    customerId?: string | null;
    docType?: string | null;
    title?: string | null;
    description?: string | null;
    notes?: string | null;
    taxRate?: number | null;
    validUntil?: string | null;
    items?: DraftLineItem[];
  } | null;
  /** The linked lead's own plan PDFs (intake uploads) — one-tap take-off, no re-upload. */
  leadPlans?: { path: string; name: string }[];
  /** The inspection appointment being written up (?capture=) — saveQuote stamps the new
   *  quote's id onto its capture jsonb so /inspections files the row (lead-less path). */
  captureId?: string;
  /** Prefill for the estimator scope box — e.g. an inspection's field capture
   *  (notes/measurements/materials) threaded in via /quotes/new?capture=. */
  initialScope?: string;
  /** Line items the WALK-THROUGH already priced — a `scopes` question's picks, mapped straight
   *  onto quote lines. They arrive as real editable rows, not as prose to re-type. */
  seededLines?: DraftLineItem[];
  priceItems?: PriceItemLite[];
  taxRates?: TaxRateLite[];
  kits?: KitLite[];
  quoteExpiryDays?: number;
  /** Org Settings default_markup_pct — the last fallback in effectiveMarkupPct's chain. */
  defaultMarkupPct?: number;
  /** Deck price-code rows (catalog orgs), NEWEST-FIRST — priced here client-side through THE
   *  markup rule so generator lines re-price with the selected customer, like the hand-picker. */
  deckRateRows?: DeckRateRow[];
}) {
  const router = useRouter();
  const defaultRate = taxRates.find((t) => t.is_default);
  const [customerId, setCustomerId] = useState(adoptedSeed?.customerId ?? preselected ?? "");
  // Customers created inline, merged into the server-provided list. The FIRST screen of the whole
  // estimate flow had a picker and no way to create what it picks — cn-v677 fixed the SAVED-quote
  // picker and never this, its sibling one screen earlier.
  const [addedCustomers, setAddedCustomers] = useState<CustomerOption[]>([]);
  const allCustomers = [...addedCustomers, ...customers];
  // The customer-facing document word — Estimate (T&M) by default, toggle to a
  // fixed-price Quote per document. Same control as the saved-quote editor.
  const [docType, setDocType] = useState<QuoteDocType>(adoptedSeed?.docType === "quote" ? "quote" : "estimate");
  const [title, setTitle] = useState(adoptedSeed?.title ?? "");
  const [description, setDescription] = useState(adoptedSeed?.description ?? "");
  const [notes, setNotes] = useState(adoptedSeed?.notes ?? "");
  const [taxRate, setTaxRate] = useState(adoptedSeed?.taxRate ?? (defaultRate ? Number(defaultRate.rate) / 100 : 0));
  const [taxChoice, setTaxChoice] = useState(defaultRate ? defaultRate.id : "");
  const [validUntil, setValidUntil] = useState(() => {
    if (adoptedSeed?.validUntil) return String(adoptedSeed.validUntil).slice(0, 10);
    const d = new Date();
    d.setDate(d.getDate() + (quoteExpiryDays || 30));
    return d.toISOString().slice(0, 10);
  });
  // A walk-through that already picked and priced its scopes seeds the estimate with those exact
  // rows. Erik: the remodel codes sit at $0 in the book because "it gets built with the
  // inspection" — so by the time the office opens this, the building is done and re-typing it
  // would be the only manual step left in an otherwise automatic chain.
  const [items, setItems] = useState<DraftLineItem[]>(
    // Adoption precedence: the DRAFT ROW's lines (they ARE the document) beat a walk-through
    // seed beat the blank starter. A session draft, when one exists, restores over all three.
    adoptedSeed?.items?.length
      ? adoptedSeed.items.map((l) => ({ ...l }))
      : seededLines?.length
        ? seededLines.map((l) => ({ ...l }))
        : [blankItem()],
  );

  // Resolve the markup via THE one rule (effectiveMarkupPct): the selected customer's
  // pricing-level markup → the item's own markup when > 0 → the org default → 0.
  const selectedCust = allCustomers.find((c) => c.id === customerId);
  const levelMarkup = selectedCust?.level_markup;
  // The customer's pricing level can also carry its own labor rate (e.g. Local = $125/hr);
  // when set, the estimator uses it instead of the org default.
  const levelRate = selectedCust?.level_rate;
  const markupFor = (p: PriceItemLite) =>
    effectiveMarkupPct({ levelPct: levelMarkup, itemPct: p.markup_pct, orgDefaultPct: defaultMarkupPct });
  // The one sell-price rule, shared with the Add picker: buy × (1 + markup%) rounded to cents.
  const priced = (p: PriceItemLite) => Math.round(p.buy_price * (1 + (markupFor(p) || 0) / 100) * 100) / 100;

  // Deck generator rates through the SAME rule as markupFor — D-code lines honor the selected
  // customer's level + the org default exactly like a hand-picked line, and re-price when the
  // customer changes. (The public configurator deliberately keeps item-markup-only pricing.)
  const deckRates = useMemo(
    () =>
      deckRateRows
        ? buildDeckRatesWithMarkup(deckRateRows, (itemPct) =>
            effectiveMarkupPct({ levelPct: levelMarkup, itemPct, orgDefaultPct: defaultMarkupPct }),
          )
        : undefined,
    [deckRateRows, levelMarkup, defaultMarkupPct],
  );

  // BROWSE, don't guess. This used to return [] on an empty query, so opening the box
  // showed nothing and you had to already know a keyword to find anything — Chris:
  // "needs to show comprehensive list" / "see the list and select from it". An empty
  // query now shows the whole price list (scrollable); typing filters it.


  // Picking a kit opens the Kit Picker (all items pre-checked — one confirm keeps the old
  // one-tap feel) instead of dumping every kit line onto the quote. The picker maps the
  // selection to lines tagged with the kit's name (collapsible groups, same as before).

  // The deck generator and the Kit Picker both drop their lines in (tagged with a group),
  // keeping any real lines already entered — the one append rule.
  function addGeneratedLines(lines: DraftLineItem[]) {
    dirtyRef.current = true;
    const real = items.filter((i) => i.description.trim());
    setItems([...real, ...lines]);
  }

  const [scope, setScope] = useState(initialScope ?? "");
  /**
   * WHAT THE ESTIMATOR PROPOSED AND HAS NOT YET BEEN PUT ON THE ESTIMATE.
   *
   * Erik: "keep it to what is proposed for a line item that hasnt been confirmed already and
   * inserted with surety … the readout now is a whole bunch of stuff i cant do anything about or
   * doesnt make sense to the context and some it good but i think thats from the mixing logics."
   *
   * The mixing was this: a generate APPENDED every drafted line straight into the table below,
   * while separately showing an amber box of prose that could not become anything. The box named
   * things — some of which had silently become lines and some of which had not — and there was no
   * way to act on either. That is "some insert, some don't", exactly.
   *
   * Two lists now, each meaning one thing. Below: THE ESTIMATE — every line on it is there because
   * he put it there. Here: PROPOSALS — nothing on this list is on the estimate. A line leaves this
   * list only by being taken or dropped, and it is never in both.
   *
   * Three bugs stop existing rather than getting fixed, which is why it is worth doing this way:
   *   · a second Generate no longer stacks a duplicate set on the estimate (it replaces this list,
   *     and nothing was inserted to duplicate);
   *   · anything typed during the thirty seconds the model is thinking survives, because `items`
   *     is never rewritten from a snapshot taken before the call;
   *   · "Undo AI draft" is gone, and with it the restore-a-stale-snapshot hazard it carried.
   */
  const [proposed, setProposed] = useState<Proposal[]>([]);
  // Things the estimator wants checked before sending — ambiguous counts, implied scope, owner
  // decisions. Shown UNDER the proposals in the same card, because they are the same kind of
  // thing: not on your estimate, and yours to decide about.
  const [questions, setQuestions] = useState<string[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // NO SAVE GAME (the Andrew law: "I said yes and then there's nowhere to be found" — his 45
  // accepted plan lines lived only in this component and died on navigation): once the estimate
  // has substance it AUTOSAVES as a real draft row, so the Estimates tab always has it.
  const [quoteId, setQuoteId] = useState<string | null>(initialQuoteId ?? null);
  const [autoState, setAutoState] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  const [autoNumber, setAutoNumber] = useState<string | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveBusy = useRef(false);
  const autosaveAgain = useRef(false);
  const navigatedAway = useRef(false);
  // THE RACE KILLERS (review of cn-v796 — the twin-minting CRITICAL): timers fire with
  // render-time closures, so every value a save decision depends on lives in a ref read at
  // FIRE time. quoteIdRef is the one identity every save path shares — whichever save lands
  // first hands its row id to all the others.
  const quoteIdRef = useRef<string | null>(initialQuoteId ?? null);
  const savingRef = useRef(false);
  // A restored/prefilled session must not autosave (and stamp a lead) with ZERO user edits —
  // opening a link is not intent (review: "mints a numbered draft with zero interaction").
  const dirtyRef = useRef(false);
  const [generating, startGenerate] = useTransition();
  const [uploading, startUpload] = useTransition();
  const [saving, startSave] = useTransition();
  const toast = useToast();

  // Interruption recovery: a deploy reload / iOS killing the tab restores the
  // half-built estimate (scope, details, every line item). Keyed by launch
  // context (the props, not live state — a mid-edit customer switch must not
  // orphan the draft) so quotes started from different jobs/customers never
  // share.
  const draftState = useMemo(
    // proposed/questions ride too (Andrew's 45 plan lines lived ONLY in this state), and
    // quoteId keeps a refreshed tab autosaving the same draft row instead of minting twins.
    () => ({ customerId, docType, title, description, notes, taxRate, taxChoice, validUntil, items, scope, proposed, questions, quoteId }),
    [customerId, docType, title, description, notes, taxRate, taxChoice, validUntil, items, scope, proposed, questions, quoteId],
  );
  const draft = useDraft(
    // inquiryId is in the key because a lead-sourced estimate (cn-v477 defers the customer, so it
    // arrives with NO ?customer=) would otherwise collapse to the shared "new" slot — two prospects'
    // drafts bleeding into each other. Keyed per-lead keeps the "never share" promise above true.
    //
    // captureId IS FIRST, AND ITS ABSENCE WAS THE BUG THE COMMENT ABOVE PREDICTED.
    //
    // Erik: "im creating an estimate for [Moraine Rd] now and its pulling info from a sarah cain
    // inspection but i cant see anything i wrote for this job."
    //
    // An estimate started from a WALK-THROUGH is exactly the case that has none of the other three.
    // Both of his live inspections — 13125 Moraine Rd and Sarah Cain — carry customer_id, job_id
    // and inquiry_id all null, because an inspection can happen before any of those records exist.
    // So both collapsed to "quote-builder:new", the shared slot, and Sarah Cain's saved draft
    // restored straight over the Moraine Rd prefill: her scope, her description, her line items.
    // Not lost — overwritten on screen by somebody else's job.
    //
    // The appointment is the MOST specific identity here (a job can hold several walk-throughs), so
    // it goes first. Precedence + the one-time eviction prefix live in quoteDraftKey, tested.
    quoteDraftKey({ captureId, jobId, customerId: preselected, inquiryId, userId: draftUserId }),
    draftState,
    (d) => {
      setCustomerId(d.customerId ?? preselected ?? "");
      // Pre-toggle drafts carry no docType — they keep the estimate default.
      if (d.docType === "quote" || d.docType === "estimate") setDocType(d.docType);
      setTitle(d.title ?? "");
      setDescription(d.description ?? "");
      setNotes(d.notes ?? "");
      if (typeof d.taxRate === "number") setTaxRate(d.taxRate);
      setTaxChoice(d.taxChoice ?? "");
      if (d.validUntil) setValidUntil(d.validUntil);
      if (Array.isArray(d.items) && d.items.length) setItems(d.items);
      if (Array.isArray(d.proposed) && d.proposed.length) setProposed(d.proposed);
      if (Array.isArray(d.questions) && d.questions.length) setQuestions(d.questions);
      if (typeof d.quoteId === "string" && d.quoteId) {
        setQuoteId(d.quoteId);
        quoteIdRef.current = d.quoteId;
      }
      // A restored draft wins, but an EMPTY drafted scope must not blank a fresh
      // inspection-capture prefill (?capture=) — that's the whole point of the link.
      setScope(d.scope ? d.scope : (initialScope ?? ""));
    },
    quoteDraftLegacyKeys({ captureId, jobId, customerId: preselected, inquiryId, userId: draftUserId }),
  );
  // The builder is a full page (not a modal), so say it out loud when a draft
  // comes back — otherwise the refilled form just looks like déjà vu.
  useEffect(() => {
    if (draft.restored) toast("Draft restored — pick up where you left off", "info");
  }, [draft.restored, toast]);

  // Live totals via the shared subtotalTaxTotal (pure, client-safe) — the SAME rounding
  // the server save (quotes/actions → quote.create) uses, so the preview can never show
  // a cent off from the quote that actually persists.
  const { subtotal, tax, total } = subtotalTaxTotal(
    items.map((i) => i.quantity * i.unit_price),
    taxRate || 0,
  );

  // Group the lines by their `group` tag (from a kit) so the estimate reads as collapsible groups —
  // Chris sees "Stairs ▸" with its sub-items nested. Each entry keeps its FLAT index so the existing
  // edit/remove handlers keep working. Ungrouped (individually-added) lines fall under group "".
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (g: string) =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  const grouped = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, { it: DraftLineItem; idx: number }[]>();
    items.forEach((it, idx) => {
      const g = it.group ?? "";
      if (!map.has(g)) { map.set(g, []); order.push(g); }
      map.get(g)!.push({ it, idx });
    });
    return order.map((g) => ({ group: g, entries: map.get(g)! }));
  }, [items]);

  function updateItem(idx: number, patch: Partial<DraftLineItem>) {
    dirtyRef.current = true;
    setItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    );
  }

  // Both estimator entry points land here. It PROPOSES and does not insert: `items` is not touched
  // at all, which is what keeps a line he typed during the thirty seconds the model was thinking.
  // A second generate replaces the proposals rather than stacking a duplicate set on the estimate.
  function applyDraft(res: { items: DraftLineItem[]; questions: string[]; description?: string }) {
    setQuestions(res.questions ?? []);
    setProposed(
      res.items
        // A line with no description cannot be read, priced or corrected, and saveQuote drops it
        // silently at save — so it would leave as a number in the subtotal and arrive as nothing.
        .filter((i) => i.description.trim())
        .map((i, n) => ({ ...i, pid: n, keep: true })),
    );
    // THE SCOPE, POLISHED — as a DEFAULT, which means it fills a hole and never overwrites a hand.
    // Erik: "the description is the scope polished / by default and editable." If he has already
    // written the paragraph he wants the customer to read, a generate must not take it away from
    // him; that is the same law the playbook fills run under.
    if (res.description?.trim() && !description.trim()) setDescription(res.description.trim());
  }

  /** Put the ticked proposals on the estimate. They leave this list; a line is never in both. */
  function acceptProposals() {
    const taking = proposed.filter((p) => p.keep);
    if (!taking.length) return;
    dirtyRef.current = true;
    const real = items.filter((i) => i.description.trim());
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setItems([...real, ...taking.map(({ pid, keep, ...line }) => line)]);
    setProposed(proposed.filter((p) => !p.keep));
  }

  const editProposal = (pid: number, patch: Partial<Proposal>) =>
    setProposed((prev) => prev.map((p) => (p.pid === pid ? { ...p, ...patch } : p)));

  function onGenerate() {
    setAiError(null);
    startGenerate(async () => {
      // Price against THIS customer's level — markup AND labor rate (else the org defaults on the server).
      // WHEN THE LEAD SENT PLANS, GENERATE READS THEM (Andrew: "It acknowledges the plans exist,
      // but nothing further…?"). The text path names the attached PDFs while telling the model it
      // can't open them, so it honestly returns questions instead of lines — the one button
      // everyone reaches for must do the whole job. The scope box still overrides the drawings.
      const res =
        leadPlans.length && inquiryId
          ? await generateQuoteDraftFromLeadPlans(inquiryId, scope, levelMarkup ?? undefined, levelRate ?? undefined)
          : await generateQuoteDraft(scope, levelMarkup ?? undefined, levelRate ?? undefined);
      if (!res.ok) {
        setAiError(res.error);
        return;
      }
      applyDraft(res);
    });
  }

  // Upload a SUPPLIER QUOTE (CED etc.) → transcribed faithfully, marked up in code off the same
  // ladder as every other material line, and PROPOSED — never taken off, never re-priced from
  // history: the net on the quote is the buy price by definition.

  /** #116: the file goes to STORAGE, the action gets a PATH — Vercel caps request bodies at
   *  ~4.5MB, under one sheet of a real plan set. Org folder, so 0013's RLS owns access. */
  async function stashUpload(file: File): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    if (!orgId) return { ok: false, error: "Couldn't start the upload — reload the page and try again." };
    // The reader's ceiling, checked BEFORE the upload (audit 7): a 100MB plan set used to
    // upload for minutes and then die server-side with a message blaming the connection.
    if (file.size > 20 * 1024 * 1024)
      return { ok: false, error: `That file is ${Math.round(file.size / 1024 / 1024)}MB — the plan reader's ceiling is 20MB. Split the PDF (Preview → Print → page range) and upload the sheets that matter.` };
    const supabase = createBrowserClient();
    const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
    const path = `${orgId}/ai-uploads/${crypto.randomUUID()}-${safe}`;
    const { error } = await supabase.storage.from("documents").upload(path, file, { contentType: file.type || undefined });
    if (error)
      return {
        ok: false,
        // Say what STORAGE said (audit 7): a project-cap refusal blamed the jobsite connection,
        // prompting doomed retries. The connection wording stays only for the errors that ARE one.
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
      // arent going to want anything to override anything." A fresh upload replaces the review,
      // same as it replaces the proposals.
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

  const [bookReview, setBookReview] = useState<null | {
    source: string;
    updates: (BookUpdate & { keep: boolean })[];
    additions: (BookAddition & { keep: boolean })[];
    unchanged: number;
  }>(null);
  const [bookMsg, setBookMsg] = useState<string | null>(null);
  const [applyingBook, startApplyBook] = useTransition();

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
      // The scope box rides along as a note that OVERRIDES the drawing — this is where you tell it
      // "garage's already done, panel & 2in conduit in, 12 cans + 10 inserts + 2 gimbals" so it
      // doesn't re-bill finished work the plan still shows.
      if (scope.trim()) fd.set("scope", scope.trim());
      if (levelMarkup != null) fd.set("markupPct", String(levelMarkup));
      if (levelRate != null) fd.set("laborRate", String(levelRate));
      const res = await generateQuoteDraftFromPlan(fd);
      if (!res.ok) {
        setAiError(res.error);
        return;
      }
      applyDraft(res);
      toast(`Read ${file.name} — review the drafted lines`, "success");
    });
  }

  // The customer's OWN plan, already in storage on the lead — same take-off, no re-upload.
  // The server re-verifies the lead actually carries this path before a byte moves.
  function onReadLeadPlan(p: { path: string; name: string }) {
    setAiError(null);
    startUpload(async () => {
      const fd = new FormData();
      fd.set("intakePath", p.path);
      fd.set("inquiryId", inquiryId ?? "");
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

  // EVERY FIELD A SAVE SENDS RIDES A REF (audit v800). A timer armed by one render used to fire
  // with THAT render's header — so a title/customer/tax-rate typed while a save was in flight was
  // overwritten by the pre-edit values on the coalesced re-run, under a green "autosaved".
  const headerRef = useRef({ customerId, jobId, inquiryId, captureId, title, description, notes, taxRate, validUntil, docType });
  headerRef.current = { customerId, jobId, inquiryId, captureId, title, description, notes, taxRate, validUntil, docType };
  const quotePayload = (cleaned: DraftLineItem[]) => {
    const h = headerRef.current;
    return {
      id: quoteIdRef.current || undefined,
      customer_id: h.customerId || null,
      job_id: h.jobId || null,
      inquiry_id: h.inquiryId || null,
      capture_appointment_id: h.captureId || null,
      title: h.title,
      description: h.description,
      notes: h.notes,
      tax_rate: h.taxRate,
      valid_until: h.validUntil || null,
      doc_type: h.docType,
      items: cleaned,
    };
  };

  // AUTOSAVE: debounced, substance- AND intent-gated (a restored or link-prefilled builder
  // must not mint a row with zero user edits), single-flight through refs (a timer fires with
  // its arming render's closure — every guard reads current refs instead), coalescing (an
  // edit landing during a save's flight re-arms instead of being dropped), and HONEST: the
  // "saved" badge demotes to "Unsaved changes" the moment anything changes, and failures show.
  const runAutosave = async () => {
    if (autosaveBusy.current || savingRef.current || navigatedAway.current) {
      autosaveAgain.current = true;
      return;
    }
    const cleaned = itemsRef.current.filter((i) => i.description.trim());
    if (!cleaned.length && !quoteIdRef.current) return;
    autosaveBusy.current = true;
    setAutoState("saving");
    try {
      const res = await saveQuote(quotePayload(cleaned));
      if (res.ok) {
        quoteIdRef.current = res.id;
        setQuoteId(res.id);
        setAutoNumber(res.quote_number ?? null);
        setAutoError(null);
        setAutoState("saved");
      } else if ((res as { code?: string }).code === "not_editable") {
        // The draft was sent from another surface — stop autosaving it; offer a fresh start.
        setAutoError(res.error ?? "This draft was sent — it can't be autosaved anymore.");
        setAutoState("error");
      } else {
        setAutoError(res.error ?? "Autosave failed — recent edits aren't saved yet.");
        setAutoState("error");
      }
    } catch {
      setAutoError("Autosave failed — recent edits aren't saved yet.");
      setAutoState("error");
    } finally {
      autosaveBusy.current = false;
      if (autosaveAgain.current && !navigatedAway.current) {
        autosaveAgain.current = false;
        if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
        autosaveTimer.current = setTimeout(() => void runAutosaveRef.current(), 800);
      }
    }
  };
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const runAutosaveRef = useRef(runAutosave);
  runAutosaveRef.current = runAutosave;
  useEffect(() => {
    const cleaned = items.filter((i) => i.description.trim());
    if (!cleaned.length && !quoteIdRef.current) return; // nothing worth a row yet
    if (!dirtyRef.current) return; // no user intent yet — restores/prefills don't count
    if (navigatedAway.current) return;
    setAutoState((prev) => (prev === "saved" ? "pending" : prev));
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => void runAutosaveRef.current(), 1500);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, title, description, notes, taxRate, validUntil, docType, customerId, jobId]);

  function onSave() {
    setSaveError(null);
    const cleaned = items.filter((i) => i.description.trim());
    if (cleaned.length === 0) {
      setSaveError("Add at least one line item.");
      return;
    }
    startSave(async () => {
      // Kill any pending/in-flight autosave BEFORE saving — the explicit-save-vs-timer race
      // was minting twin numbered drafts (review, HIGH). savingRef is the shared guard the
      // timer reads at fire time; the busy-wait drains an autosave already on the wire so
      // its returned id is adopted instead of racing a second insert.
      savingRef.current = true;
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      for (let i = 0; i < 40 && autosaveBusy.current; i++) await new Promise((r) => setTimeout(r, 100));
      const res = await saveQuote(quotePayload(cleaned));
      if (!res.ok) {
        savingRef.current = false;
        setSaveError(res.error ?? "Could not save the quote.");
        return;
      }
      // Saved — stop the autosaver and drop the session draft so the next visit starts clean.
      navigatedAway.current = true;
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      draft.clear();
      router.push(`/quotes/${res.id}`);
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3" onInputCapture={() => (dirtyRef.current = true)}>
      <div className="space-y-6 lg:col-span-2">
        {/* AI drafting */}
        <Card className="border-brand/30 bg-brand-light/40">
          <CardContent className="space-y-3 py-5">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand" />
              <h3 className="text-sm font-semibold text-slate-900">
                Draft with Estimator
              </h3>
            </div>
            <p className="text-xs text-slate-500">
              Priced from your price book (your net cost + markup). Items not in the book come in at a Home Depot estimate, flagged to confirm.
            </p>
            <Textarea
              rows={3}
              placeholder="Describe the work — or, with a plan uploaded, what's already done / excluded. e.g. 'ADU upstairs only — garage & entryway done, panel & 2in conduit already in. 12 cans + 10 inserts + 2 gimbals.'"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
            {aiError && <p className="text-sm text-red-600">{aiError}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={onGenerate} disabled={generating || uploading}>
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
              {/* Say out loud that Generate will read the plans — Andrew expected exactly that
                  and the button gave no sign either way. */}
              {leadPlans.length > 0 && !generating && (
                <span className="text-xs text-slate-500">
                  reads the customer&apos;s plans ({leadPlans.map((p) => p.name).join(", ")})
                </span>
              )}
            </div>

            {/* …or take off a plan. Claude reads the PDF natively (legend, schedules, notes, and
                the drawing) into the same price-book-priced lines + review questions. */}
            <div className="flex items-center gap-3 pt-1">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-400">or</span>
              <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-brand/40 bg-white/60 px-3 py-2 text-sm font-medium text-brand hover:bg-brand-light/40 ${uploading ? "pointer-events-none opacity-60" : ""}`}>
                {uploading ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Reading plan…</>
                ) : (
                  <><FileUp className="h-4 w-4" /> Upload Plans</>
                )}
                <input
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  disabled={uploading || generating}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUploadPlan(f);
                    e.target.value = ""; // let the same file be re-picked after an undo
                  }}
                />
              </label>
              <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white/60 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 ${uploading ? "pointer-events-none opacity-60" : ""}`}>
                <FileUp className="h-4 w-4" /> Supplier quote
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
              {scope.trim() && !uploading && (
                <span className="text-xs text-slate-400">applies your note above to the plan</span>
              )}
            </div>

            {/* THE PLANS THE CUSTOMER ALREADY SENT — one tap, no re-upload (Andrew's estimate
                said "attached but I can't open it" while the PDF sat on the lead). */}
            {leadPlans.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <span className="text-xs font-medium text-slate-500">The customer&apos;s plans are already here:</span>
                {leadPlans.map((p) => (
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

        {/* ── THE PRICE-BOOK REVIEW — what this supplier quote knows that the book doesn't ─────
            Opt-in per row, ticks default OFF, and closing it loses nothing but the offer. */}
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
                      Not now
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {bookReview.updates.map((u, i) => (
                      <div key={u.itemId}>
                      <label className="flex min-h-[36px] cursor-pointer items-center gap-2 text-sm">
                        <input type="checkbox" className="h-4 w-4" checked={u.keep}
                               onChange={(e) => setBookReview((p) => p && { ...p, updates: p.updates.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)) })} />
                        <span className="min-w-0 truncate">{u.description}{u.code ? <span className="ml-1 font-mono text-xs text-slate-400">[{u.code}]</span> : null}</span>
                        <span className="ml-auto whitespace-nowrap font-mono text-xs tabular-nums">
                          {/* THE UNITS, ALWAYS (v800 audit). A supplier prints the COIL net for a
                              part the book prices per FOOT; "$0.75 → $187.50" with no units on
                              screen is how a 250x corruption of the price book gets ticked. */}
                          <span className="text-slate-400 line-through">
                            ${u.oldBuy.toFixed(2)}{u.oldUnit ? `/${u.oldUnit}` : ""}
                          </span>
                          {" → "}
                          <span className={u.newBuy > u.oldBuy ? "text-rose-700" : "text-emerald-700"}>
                            ${u.newBuy.toFixed(2)}{u.newUnit ? `/${u.newUnit}` : ""}
                          </span>
                        </span>
                      </label>
                      {u.unitMismatch && (
                        <p className="pl-6 text-xs font-medium text-amber-700">
                          Different units — the quote is per {u.newUnit}, your book is per {u.oldUnit}. Check before you
                          tick this, or the price is wrong by whatever a {u.newUnit} holds.
                        </p>
                      )}
                      </div>
                    ))}
                    {bookReview.additions.map((a, i) => (
                      <label key={`add-${i}`} className="flex min-h-[36px] cursor-pointer items-center gap-2 text-sm">
                        <input type="checkbox" className="h-4 w-4" checked={a.keep}
                               onChange={(e) => setBookReview((p) => p && { ...p, additions: p.additions.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)) })} />
                        <span className="min-w-0 truncate">{a.description}</span>
                        <span className="ml-auto whitespace-nowrap font-mono text-xs tabular-nums text-slate-600">new · ${a.newBuy.toFixed(2)}/{a.unit}</span>
                      </label>
                    ))}
                  </div>
                  <div className="mt-3">
                    <Button type="button" size="sm" onClick={applyBook}
                            disabled={applyingBook || !(bookReview.updates.some((u) => u.keep) || bookReview.additions.some((a) => a.keep))}>
                      {applyingBook ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      Apply {bookReview.updates.filter((u) => u.keep).length + bookReview.additions.filter((a) => a.keep).length} to the price book
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── THE READOUT: WHAT IT PROPOSED, AND NOTHING ELSE ──────────────────────────────────
            One card, one meaning: none of this is on your estimate. Tick what you want, fix a
            number where it is wrong, press the button once. What you leave unticked is dropped. */}
        {(proposed.length > 0 || questions.length > 0) && !generating && !uploading && (
          <Card className="border-brand/30">
            <CardContent className="py-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    {proposed.length ? `Proposed — ${proposed.length} line${proposed.length === 1 ? "" : "s"}` : "Worth checking"}
                  </h3>
                  {proposed.length > 0 && (
                    <p className="text-xs text-slate-500">Nothing here is on your estimate yet.</p>
                  )}
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
                    {proposed.every((p) => p.keep) ? "Untick all" : "Tick all"}
                  </button>
                ) : proposed.length === 0 && questions.length > 0 ? (
                  <button onClick={() => setQuestions([])} className="text-xs text-slate-400 hover:text-slate-900">
                    Clear
                  </button>
                ) : null}
              </div>

              <div className="space-y-2">
                {proposed.map((p) => (
                  <div
                    key={p.pid}
                    className={`grid grid-cols-12 items-start gap-2 rounded-lg border p-2 ${p.keep ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50/70 opacity-55"}`}
                  >
                    <div className="col-span-1 pt-2.5">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={p.keep}
                        onChange={(e) => editProposal(p.pid, { keep: e.target.checked })}
                        aria-label={`Add ${p.description}`}
                      />
                    </div>
                    <div className="col-span-11 sm:col-span-4">
                      <Input
                        placeholder="Description"
                        value={p.description}
                        onChange={(e) => editProposal(p.pid, { description: e.target.value })}
                      />
                      {p.flag && (
                        <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                          {p.flag}
                        </span>
                      )}
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
                      <button
                        type="button"
                        onClick={() => setProposed((prev) => prev.filter((x) => x.pid !== p.pid))}
                        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        aria-label="Drop this proposal"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {proposed.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button variant="primary" onClick={acceptProposals} disabled={!proposed.some((p) => p.keep)}>
                    <Check className="h-4 w-4" />
                    Add {proposed.filter((p) => p.keep).length} to the estimate
                  </Button>
                  <button
                    type="button"
                    onClick={() => setProposed([])}
                    className="text-sm text-slate-500 hover:text-slate-900"
                  >
                    Drop them all
                  </button>
                  <span className="text-sm text-slate-500">
                    {formatCurrency(
                      proposed.filter((p) => p.keep).reduce((t, p) => t + p.quantity * p.unit_price, 0),
                    )}
                  </span>
                </div>
              )}

              {/* Not line items — things it wants a decision on. Same card, because they belong to
                  the same moment: read them, then take what you want. */}
              {questions.length > 0 && (
                <div className={proposed.length ? "mt-4 border-t border-slate-200 pt-3" : ""}>
                  {/* The sub-heading only exists to separate these from the proposals ABOVE them.
                      With no proposals the card title is already "Worth checking", and printing it
                      twice is what shipped in cn-v716. */}
                  {proposed.length > 0 && (
                    <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Worth checking
                    </h4>
                  )}
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

        {/* Deck generator (catalog orgs) — dimensions in, priced deck lines dropped in. */}

        {/* Line items */}
        <Card>
          <CardContent className="py-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Line items</h3>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setItems((p) => [...p, blankItem()])}
              >
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>

            {/* ONE PICKER, THREE SURFACES. This was inline markup here and nowhere else, which is
                why the saved-estimate editor and the invoice editor each grew their own thinner
                copy — and why the browse-on-empty fix reached one of them and not the others. */}
            <AddLineItems
              priceItems={priceItems}
              kits={kits as never}
              markupFor={markupFor as never}
              measured={measured}
              onAdd={addGeneratedLines}
            />

            <div className="space-y-2">
              {grouped.map(({ group, entries }) => {
                const gSub = subtotalTaxTotal(entries.map(({ it }) => it.quantity * it.unit_price), 0).subtotal;
                const isCollapsed = collapsed.has(group);
                return (
                  <div key={group || "__ungrouped"} className={group ? "overflow-hidden rounded-lg border border-slate-200" : ""}>
                    {group && (
                      <button
                        type="button"
                        onClick={() => toggleGroup(group)}
                        className="flex w-full items-center gap-2 bg-slate-50 px-3 py-2 text-left hover:bg-slate-100"
                      >
                        {isCollapsed ? <ChevronRight className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                        <span className="text-sm font-semibold text-slate-800">{group}</span>
                        <span className="text-xs text-slate-400">· {entries.length} item{entries.length === 1 ? "" : "s"}</span>
                        <span className="ml-auto text-sm font-medium text-slate-600">{formatCurrency(gSub)}</span>
                      </button>
                    )}
                    {!(group && isCollapsed) && (
                      <div className={`space-y-2 ${group ? "p-2" : ""}`}>
                        {entries.map(({ it, idx }) => (
                          <div key={idx} className="grid grid-cols-12 items-start gap-2 rounded-lg border border-slate-100 p-2">
                            <div className="col-span-12 sm:col-span-5">
                              <LineDescInput
                                value={it.description}
                                onText={(v) => updateItem(idx, { description: v })}
                                onPick={(pi) =>
                                  updateItem(idx, {
                                    description: pi.code ? `${pi.code} — ${pi.description}` : pi.description,
                                    unit: pi.unit || "ea",
                                    unit_price: priced(pi),
                                  })
                                }
                                priceItems={priceItems}
                                priced={priced}
                              />
                              {it.flag && (
                                <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                                  {it.flag}
                                </span>
                              )}
                            </div>
                            <div className="col-span-3 sm:col-span-2">
                              <NumberInput placeholder="Qty" value={it.quantity} onValueChange={(n) => updateItem(idx, { quantity: n })} />
                            </div>
                            <div className="col-span-3 sm:col-span-1">
                              <Input placeholder="ea" value={it.unit} onChange={(e) => updateItem(idx, { unit: e.target.value })} />
                            </div>
                            <div className="col-span-4 sm:col-span-2">
                              <NumberInput placeholder="Unit $" value={it.unit_price} onValueChange={(n) => updateItem(idx, { unit_price: n })} />
                            </div>
                            <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-2">
                              <span className="text-sm font-medium text-slate-700">{formatCurrency(it.quantity * it.unit_price)}</span>
                              <button
                                onClick={() => {
                                  dirtyRef.current = true;
                                  setItems((p) => p.filter((_, i) => i !== idx));
                                }}
                                className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                                aria-label="Remove line"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

      </div>

      {/* Sidebar: details + totals */}
      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-4 py-5">
            {/* What the customer's document calls itself — same control as the saved-quote
                editor. Internal nav stays "Estimates"; this word is document-facing only. */}
            <div title="Quote = fixed price · Estimate = time & materials">
              <Label>Document</Label>
              <SegmentedControl
                stretch
                activeId={docType}
                onSelect={(id) => setDocType(id as QuoteDocType)}
                items={[
                  { id: "quote", label: "Quote (Fixed)" },
                  { id: "estimate", label: "Estimate (T&M)" },
                ]}
              />
            </div>
            <div>
              <Label htmlFor="customer">Customer</Label>
              <Select
                id="customer"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">
                  {allCustomers.length ? "— Select customer —" : "— No customers yet — add one below, or leave blank (a lead becomes the customer when you win the job) —"}
                </option>
                {allCustomers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.company_name ? ` (${c.company_name})` : ""}
                  </option>
                ))}
              </Select>
              <NewCustomerInline
                className="mt-1.5"
                onCreated={(c) => {
                  setAddedCustomers((prev) => [{ id: c.id, name: c.name, company_name: null }, ...prev]);
                  setCustomerId(c.id);
                }}
              />
            </div>
            <div>
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                placeholder="e.g. Panel upgrade"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="q-description">Description <span className="font-normal text-slate-400">(shows above the line items)</span></Label>
              <Textarea
                id="q-description"
                rows={3}
                placeholder="Scope summary the customer reads before the line items."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="tax">Tax rate</Label>
                {taxRates.length > 0 ? (
                  <Select
                    id="tax"
                    value={taxChoice}
                    onChange={(e) => {
                      const id = e.target.value;
                      setTaxChoice(id);
                      const r = taxRates.find((t) => t.id === id);
                      setTaxRate(r ? Number(r.rate) / 100 : 0);
                    }}
                  >
                    <option value="">No tax</option>
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
                    onChange={(e) => setTaxRate((Number(e.target.value) || 0) / 100)}
                  />
                )}
              </div>
              <div>
                <Label htmlFor="valid">Valid until</Label>
                <Input
                  id="valid"
                  type="date"
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2 py-5 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal</span>
              <span>{formatCurrency(subtotal)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Tax</span>
              <span>{formatCurrency(tax)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-2 text-base font-semibold text-slate-900">
              <span>Total</span>
              <span>{formatCurrency(total)}</span>
            </div>
            {saveError && (
              <p className="pt-2 text-sm text-red-600">{saveError}</p>
            )}
            {autoState === "saved" && quoteId && (
              <p className="pt-1 text-xs text-emerald-700">
                Draft {autoNumber ?? ""} autosaved — it&apos;s on the Estimates list even if you leave.
              </p>
            )}
            {autoState === "pending" && <p className="pt-1 text-xs text-slate-400">Unsaved changes…</p>}
            {autoState === "saving" && <p className="pt-1 text-xs text-slate-400">Autosaving…</p>}
            {autoState === "error" && (
              <div className="pt-1 text-xs text-amber-700">
                {autoError ?? "Autosave failed — recent edits aren't saved yet."}{" "}
                <button
                  type="button"
                  className="font-semibold underline"
                  onClick={() => {
                    // A sent/stale draft gets a fresh identity; a transient failure just retries.
                    if (autoError?.includes("sent")) {
                      quoteIdRef.current = null;
                      setQuoteId(null);
                      setAutoNumber(null);
                    }
                    setAutoError(null);
                    setAutoState("idle");
                    void runAutosaveRef.current();
                  }}
                >
                  {autoError?.includes("sent") ? "Continue as a new draft" : "Retry"}
                </button>
              </div>
            )}
            <Button className="mt-2 w-full" onClick={onSave} disabled={saving}>
              {saving ? "Saving…" : `Save ${docLabel({ doc_type: docType })}`}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
