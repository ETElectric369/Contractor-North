/**
 * A DRAW BUILT FROM ACTUALS IS REFRESHED LIKE AN INVOICE (Erik, J-011 13897 Herringbone,
 * 2026-09-24).
 *
 * INV-078 is a progress draw that "Progress Payment → Actual T&M" built: every hour at its bill
 * rate and every receipt at Andrew's markup, itemized. Twelve new hours and a $323.71 CED bill
 * later, the job card offered "Add to INV-078 ($1,572.27)" and the server answered "Draft INV-078
 * is still open on this job — send or delete that draw instead of billing on a standard invoice."
 * The invoice page offered no way in either: its Import row hid itself for EVERY draw kind. Both
 * doors treated "a draw" as "a slice of a contract", which is what a %-of-estimate, a fixed-$ or a
 * milestone draw is — and what a time-and-materials progress report is not. That one is the job's
 * actuals, itemized; bringing it up to date is exactly what New Invoice does to a standard draft.
 *
 * ONE RULE, HERE, read by the job card, the invoice page and every server importer:
 *
 *   standard invoice                               → refreshes from actuals (as it always has)
 *   draw on a job with a payment schedule          → NO  (milestones partition the contract)
 *   draw carrying a milestone line                 → NO  (it is a scheduled slice)
 *   draw whose lines (or deleted-line tombstones)
 *     came from the labor / materials importers    → YES (it was built from actuals)
 *   any other draw (a % of the estimate, a fixed $,
 *     a deposit, or an empty one)                  → NO  (H4: actuals on top of a contract slice
 *                                                        bill the same work twice)
 *
 * The test is the DRAW'S OWN PROVENANCE, not the job's billing type: "Request Next Payment" on a
 * fixed-price job without a schedule also builds an actuals report (requestNextPayment), and a T&M
 * job can carry a fixed deposit draw. What the document is made of is what it is.
 *
 * A tombstone counts because deleting every imported line of a report must not turn it into a
 * contract draw behind the office's back (0175 records the keys the office deleted).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isDrawKind, resolveDrawCredit, DRAW_KINDS } from "./invoice-math";
import { isLiveQuote, nextInvoiceImportsActuals } from "./invoice-import-rule";

/** Line sources only the actuals importers (and the report's own prior-billings credit) write. */
const ACTUALS_SOURCES = new Set(["labor", "costs", "draw_credit"]);
/** The import keys those importers mint: labor per person, bills, receipt lines, orders. */
const ACTUALS_KEY = /^(labor|bill|bli|po):/;

export type DraftShape = {
  invoiceKind: string | null | undefined;
  /** The job carries a payment schedule (any payment_milestones row). */
  scheduleActive: boolean;
  /** import_source of every line on the invoice (null = typed by hand). */
  lineSources: readonly (string | null | undefined)[];
  /** invoices.dismissed_import_keys — the importer lines the office deleted. */
  dismissedKeys?: readonly (string | null | undefined)[] | null;
};

/** Is this a DRAW that was built from the job's actuals (a T&M progress report)? */
export function isActualsDraw(d: DraftShape): boolean {
  if (!isDrawKind(d.invoiceKind)) return false;
  if (d.scheduleActive) return false;
  if (d.lineSources.some((s) => s === "milestone")) return false;
  if (d.lineSources.some((s) => !!s && ACTUALS_SOURCES.has(s))) return true;
  return (d.dismissedKeys ?? []).some((k) => !!k && ACTUALS_KEY.test(k));
}

/** May the job's unclaimed hours and bills be pulled onto this invoice? Standard: yes, as today
 *  (the H4 guard against a standard invoice on a draw job stays where it is). A draw: only an
 *  actuals draw. */
export function refreshesFromActuals(d: DraftShape): boolean {
  return isDrawKind(d.invoiceKind) ? isActualsDraw(d) : true;
}

/** The server's refusal when an importer is pointed at a draw that bills a slice of the contract.
 *  Names the document and the way forward, never a bare "not allowed". */
export function contractDrawRefusal(invoiceNumber: string | null | undefined, what: string): string {
  const doc = invoiceNumber || "This draw";
  return `${doc} bills a set part of the contract, not hours and receipts, so ${what} can't be added to it - that would bill the same work twice. Send it as it is, then bill new work on the next progress payment.`;
}

// ── The job's open draft ───────────────────────────────────────────────────────────────────

export type OpenDraft = {
  id: string;
  number: string | null;
  kind: string;
  /** refreshesFromActuals: "Add to" lands here; false means the only honest door is "Open". */
  refreshable: boolean;
};

/**
 * THE JOB'S OPEN DRAFT, WHATEVER ITS KIND, and whether new work can go on it. One draft is the
 * rule on a job (the card and New Invoice land on it; a second would race it for the same rows).
 * When both a draw and a standard draft are open, the draw wins: a job with a draw refuses content
 * on a standard invoice (H4), so the standard draft is not a door that works.
 *
 * Throws on a failed read — "no draft" invented from a lost query would mint a second one.
 */
export async function openDraftOnJob(supabase: SupabaseClient, jobId: string): Promise<OpenDraft | null> {
  const { data, error } = await supabase
    .from("invoices")
    .select("id, invoice_number, invoice_kind, dismissed_import_keys, created_at, quote_id")
    .eq("job_id", jobId)
    .eq("status", "draft")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as { id: string; invoice_number: string | null; invoice_kind: string | null; dismissed_import_keys: string[] | null; quote_id?: string | null }[];
  const pick = rows.find((r) => isDrawKind(r.invoice_kind)) ?? rows[0];
  if (!pick) return null;
  const kind = pick.invoice_kind ?? "standard";
  if (!isDrawKind(kind)) {
    // A STANDARD DRAFT BESIDE A LIVE DRAW IS NOT A DOOR (review, 2026-09-24). Every importer refuses
    // content on a standard invoice once the job carries a non-void draw (H4, standardInvoiceOnDrawJob),
    // so "Add to INV-0xx" onto it would come back "couldn't be pulled in". The state is reachable: an
    // EMPTY standard draft never blocks a draw from being made. Such a job's next bill is a progress
    // report (createInvoiceForJob routes it there), so this reports no open draft - the card then
    // offers "Create Invoice", which is the door that works.
    const { data: draws, error: drawErr } = await supabase
      .from("invoices")
      .select("id")
      .eq("job_id", jobId)
      .neq("status", "void")
      .in("invoice_kind", [...DRAW_KINDS])
      .limit(1);
    if (drawErr) throw drawErr;
    if ((draws ?? []).length) return null;
    // AN ESTIMATE COPIED ONTO A T&M JOB'S DRAFT IS NOT A PLACE FOR THE HOURS (review, 2026-09-26).
    // On Time & Material the estimate is a guide (estimateIsTheContract), but /billing's "from
    // quote" and Nort's invoice.fromQuote can still copy its lines onto a standard draft. Adding the
    // actuals to that draft would bill the estimate AND the work on one bill, so it takes no new
    // work: the card offers "Open INV-0xx", and Finish won't build on it.
    if (pick.quote_id) {
      const { data: job, error: jobErr } = await supabase.from("jobs").select("billing_type").eq("id", jobId).maybeSingle();
      if (jobErr) throw jobErr;
      if ((job as { billing_type?: string | null } | null)?.billing_type === "tm") {
        return { id: pick.id, number: pick.invoice_number, kind, refreshable: false };
      }
    }
    return { id: pick.id, number: pick.invoice_number, kind, refreshable: true };
  }
  const shape = await readDraftShape(supabase, { id: pick.id, jobId, kind, dismissedKeys: pick.dismissed_import_keys });
  return { id: pick.id, number: pick.invoice_number, kind, refreshable: isActualsDraw(shape) };
}

/** The reads isActualsDraw needs for one invoice: its lines' sources and the job's schedule.
 *  `dismissedKeys` may be passed when the caller already has the row. Throws on a failed read. */
export async function readDraftShape(
  supabase: SupabaseClient,
  inv: { id: string; jobId: string; kind: string | null; dismissedKeys?: string[] | null },
): Promise<DraftShape> {
  const [lines, sched, keys] = await Promise.all([
    supabase.from("invoice_items").select("import_source").eq("invoice_id", inv.id),
    supabase.from("payment_milestones").select("id").eq("job_id", inv.jobId).limit(1),
    inv.dismissedKeys !== undefined
      ? Promise.resolve({ data: { dismissed_import_keys: inv.dismissedKeys }, error: null })
      : supabase.from("invoices").select("dismissed_import_keys").eq("id", inv.id).maybeSingle(),
  ]);
  if (lines.error) throw lines.error;
  if (sched.error) throw sched.error;
  if (keys.error) throw keys.error;
  return {
    invoiceKind: inv.kind,
    scheduleActive: ((sched.data ?? []) as unknown[]).length > 0,
    lineSources: ((lines.data ?? []) as { import_source: string | null }[]).map((l) => l.import_source),
    dismissedKeys: ((keys.data as { dismissed_import_keys?: string[] | null } | null)?.dismissed_import_keys ?? []) as string[],
  };
}

// ── What the job card's button does ─────────────────────────────────────────────────────────

export type CardDoor =
  /** `amount` is what the click adds: the card's "Open" figure. */
  | { kind: "add"; label: string; amount: number }
  | { kind: "open"; label: string; href: string }
  /** A standard invoice (a plain T&M job's New Invoice). `note` names a deposit the new bill takes
   *  off, so the figure on the button is explained. `amount` is what the click bills. */
  | { kind: "create"; label: string; amount: number; note?: string }
  /** A progress payment built from the actuals (createProgressReportInvoice, the Progress Payment →
   *  Actual T&M door). The job already bills with draws, so its next bill is one too, and it nets
   *  any deposit not yet taken off a bill (resolveDrawCredit). `amount` is what it bills. */
  | { kind: "draw"; label: string; amount: number; note?: string }
  /** No button: a deposit (or a set-amount draw) not yet taken off a bill still covers the work.
   *  `note` is the sentence the card shows instead. */
  | { kind: "covered"; note: string }
  | null;

/**
 * THE CARD NEVER OFFERS A DOOR THE SERVER REFUSES. An open draft that takes new work → "Add to
 * INV-078 ($X)". An open draft that doesn't (a fixed or % draw) → "Open INV-0xx", which goes there:
 * the work waits for the next bill and the card says why. No draft on a job that already bills with
 * draws → "Create Progress Payment for $X": the draw door, which nets the deposit and never reopens
 * a paid one (Tao J-002, where the standard New Invoice opened his paid deposit). No draft
 * otherwise → "Create Invoice for $X". Nothing pending → no button (the card's sentences carry the
 * door).
 */
export function unbilledCardDoor(input: {
  openDraft: Pick<OpenDraft, "id" | "number" | "refreshable"> | null;
  /** Hours or bills not on any invoice. */
  workPending: boolean;
  /** Pending supplier returns. */
  returns: number;
  /** The net the card shows. */
  total: number;
  /** Hours + bills alone, before a return comes off. */
  newWork: number;
  /** Deposit / set-amount draw money no bill has taken off yet (fixedBillingsNotYetNetted). The
   *  next progress report nets it (resolveDrawCredit), so a figure that ignored it would promise
   *  more than the click bills - or a click that bills nothing. */
  lumpToNet?: number;
  /** The job carries a live draw (a deposit, a progress payment): its next bill is a progress
   *  payment, never a standard invoice (H4 refuses one there). */
  drawBilled?: boolean;
  money: (n: number) => string;
}): CardDoor {
  const { openDraft, workPending, returns, total, newWork, money } = input;
  const lump = Math.max(0, Number(input.lumpToNet) || 0);
  if (openDraft) {
    const name = openDraft.number ?? "the Open Draft";
    if (!openDraft.refreshable) {
      return workPending || returns > 0 ? { kind: "open", label: `Open ${name}`, href: `/billing/${openDraft.id}` } : null;
    }
    if (!(workPending || returns > 0)) return null;
    // What the click adds: the work, net of a pending return - but never below zero. A return worth
    // more than the new work waits on its own sentence (owedBack); the hours still go on the draft.
    const amount = total > 0.005 ? total : Math.max(0, newWork);
    return { kind: "add", label: amount > 0.005 ? `Add to ${name} (${money(amount)})` : `Add to ${name}`, amount };
  }
  if (!workPending) return null;
  const figure = total > 0.005 ? total : newWork;
  const kind = input.drawBilled ? ("draw" as const) : ("create" as const);
  const verb = kind === "draw" ? "Create Progress Payment" : "Create Invoice";
  if (lump > 0.005) {
    // The server's own decision (createProgressReportInvoice → resolveDrawCredit), made here first.
    const d = resolveDrawCredit(figure, lump);
    if (!d.ok) {
      return {
        kind: "covered",
        note: `The ${money(lump)} deposit not yet taken off a bill still covers this, so there is nothing new to bill yet.`,
      };
    }
    if (d.credit > 0.005) {
      const net = Math.round((figure - d.credit) * 100) / 100;
      return {
        kind,
        label: `${verb} for ${money(net)}`,
        amount: net,
        note: `That is ${money(figure)} of work less the ${money(d.credit)} deposit not yet taken off a bill.`,
      };
    }
  }
  return { kind, label: `${verb} for ${money(figure)}`, amount: figure };
}

/**
 * THE ONE NUMBER (Erik, 2026-09-26: "the only thing i was looking for was the amount open"). The
 * card leads with "Open: $X", and $X is exactly what its button bills: the figure on "Add to" or
 * "Create ...", $0 when a deposit still covers the work, and otherwise the work not on a bill (a
 * contract draft that can't take it, or nothing pending at all).
 */
export function openFigure(door: CardDoor, total: number): number {
  // Never a negative "Open": a return worth more than the work is a credit, said on its own line.
  if (!door || door.kind === "open") return Math.max(0, total);
  if (door.kind === "covered") return 0;
  return door.amount;
}

// ── What a refresh says ──────────────────────────────────────────────────────────────────────

const hoursWord = (h: number) => {
  const r = Math.round(h * 100) / 100;
  return `${r} ${r === 1 ? "hour" : "hours"}`;
};

/**
 * "Pulled 12 hours and 1 bill into INV-078." The office's nouns, measured from the job's own
 * unbilled picture before and after (so an hour a deleted line holds back is never counted as
 * pulled). A supplier return the refresh credited is counted too - "Nothing new" after a click
 * that wrote a credit onto the draw would be false. `left` names what is still not on it and
 * WHERE THE REASON IS SAID: the invoice's one Bring In New Work button (W1-27) runs every import
 * and says, part by part, what landed and what held back - so the sentence names that button,
 * never "the Import row says why" and never a button that no longer exists.
 */
export function pulledIntoSentence(
  number: string,
  pulled: { hours: number; bills: number; returns?: number; returnsCredit?: number; stock?: number },
  left?: { hours: number; bills: number; returns?: number; stock?: number } | null,
  money?: (n: number) => string,
): string {
  const takes = (n: number) => (n === 1 ? "1 take from stock" : `${n} takes from stock`);
  const parts: string[] = [];
  if (pulled.hours > 0.005) parts.push(hoursWord(pulled.hours));
  if (pulled.bills > 0) parts.push(`${pulled.bills} ${pulled.bills === 1 ? "bill" : "bills"}`);
  if ((pulled.stock ?? 0) > 0) parts.push(takes(pulled.stock ?? 0));
  const r = pulled.returns ?? 0;
  if (r > 0) {
    const amt = money && (pulled.returnsCredit ?? 0) > 0.005 ? ` (${money(pulled.returnsCredit ?? 0)} back to the customer)` : "";
    parts.push(`${r === 1 ? "a supplier return credit" : `${r} supplier return credits`}${amt}`);
  }
  const head = parts.length ? `Pulled ${joinParts(parts)} into ${number}.` : `Nothing new to pull into ${number}.`;
  const rest: string[] = [];
  if (left && left.hours > 0.005) rest.push(hoursWord(left.hours));
  if (left && left.bills > 0) rest.push(`${left.bills} ${left.bills === 1 ? "bill" : "bills"}`);
  if (left && (left.stock ?? 0) > 0) rest.push(takes(left.stock ?? 0));
  if (left && (left.returns ?? 0) > 0) {
    const n = left.returns ?? 0;
    rest.push(n === 1 ? "a supplier return" : `${n} supplier returns`);
  }
  return rest.length
    ? `${head} Still not on it: ${joinParts(rest)} - open ${number} and tap ${BRING_IN_NEW_WORK} to see what is holding ${rest.length === 1 && !/s$/.test(rest[0]) && !/^\d+ takes /.test(rest[0]) ? "it" : "them"} back.`
    : head;
}

/** The invoice page's one import button (W1-27): every sentence that sends a person to pull new
 *  hours, bills or change orders onto an invoice names it by this, so none points at a button
 *  that is gone ("Labor from Timecards" and "Materials from Costs" were folded into it). */
export const BRING_IN_NEW_WORK = "Bring In New Work";

// ── Bring In New Work (W1-27) ──────────────────────────────────────────────────────────────────

export type BringInStep = "labor" | "materials" | "change_orders" | "quote";

/**
 * WHAT BRING IN NEW WORK RUNS, DECIDED ONCE. The invoice's Import row had four buttons (From
 * Estimate, Labor from Timecards, Materials from Costs, Approved Change Orders), and the right ones
 * to press depended on what kind of bill it was - knowledge the button can hold instead:
 *
 *   an actuals draw (INV-078), a Time & Material job,  → Labor, then Materials, then Approved
 *   or a job with no estimate that is its contract        Change Orders
 *   an invoice made from an estimate (quote_id)         → the estimate's lines (only while it holds
 *                                                         none), then Approved Change Orders - never
 *                                                         T&M labor or materials on top of a price
 *   a fixed-price job's estimate is its contract, and   → Approved Change Orders only: the contract
 *   this invoice isn't the estimate's copy                is billed on its own bill
 *   a draw for set amounts                              → nothing (the row isn't drawn)
 *
 * `estimateIsContract`: undefined = the page didn't ask (the rule before this wave - the job's work
 * comes in); null = the job couldn't be read, so only what can't bill a contract twice comes in and
 * the page says why.
 */
export function bringInNewWorkSteps(f: {
  importMode: "standard" | "actuals" | "none";
  hasJob: boolean;
  quoteId: string | null | undefined;
  /** Lines already on the invoice that came from the estimate (import_source "quote"). */
  quoteLinesOnInvoice: number;
  estimateIsContract?: boolean | null;
}): BringInStep[] {
  if (f.importMode === "none") return [];
  const changeOrders: BringInStep[] = f.hasJob ? ["change_orders"] : [];
  if (f.importMode === "actuals") return f.hasJob ? ["labor", "materials", ...changeOrders] : [];
  if (f.quoteId) return [...(f.quoteLinesOnInvoice === 0 ? (["quote"] as BringInStep[]) : []), ...changeOrders];
  if (!f.hasJob) return [];
  if (f.estimateIsContract === true || f.estimateIsContract === null) return changeOrders;
  return ["labor", "materials", ...changeOrders];
}

/** What one importer answered (billing/actions' ImportResult, as much as the sentence needs). */
export type BringInOutcome = {
  step: BringInStep;
  ok: boolean;
  empty?: boolean;
  error?: string;
  emptyNote?: string;
  stats?: {
    inserted?: number;
    updated?: number;
    kept_edited?: number;
    removed?: number;
    pulled_in?: number;
    stock_pulled_in?: number;
    skipped_claimed?: number;
    claimed_on?: string[];
    warnings?: string[];
  };
};

const STEP_NAME: Record<BringInStep, string> = {
  labor: "Labor",
  materials: "Materials",
  change_orders: "Approved change orders",
  quote: "The estimate's lines",
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** An importer's plain "there's nothing on the job yet": the head's "Nothing new to bring in." says it. */
const PLAIN_NOTHING = /^(No (billable hours|approved change orders|change orders|purchase orders)\b[^.]*|Nothing here to bill yet)\./;

/**
 * WHY AN EMPTY PART BROUGHT NOTHING. An importer that finds every row already billed answers
 * EMPTY, with the reason only in `error`: "Every hour on this job is already on INV-061 - nothing new
 * to bill." That sentence is the only place the office learns the work is on another invoice (and
 * so must not be typed in again by hand), and a receipt whose every line is marked as the company's
 * own cost says where the switch is the same way. So an empty part keeps its reason - unless it is
 * the plain "No billable hours on this job yet." kind, which the head already says; then only its
 * `emptyNote` (a stock or return note an empty run still passes on) rides along.
 */
function emptyReason(o: BringInOutcome): string {
  const err = (o.error ?? "").trim();
  if (err && !PLAIN_NOTHING.test(/\.$/.test(err) ? err : `${err}.`)) return err;
  return (o.emptyNote ?? "").trim();
}

/**
 * ONE RESULT SENTENCE FOR THE WHOLE PRESS: "Brought in: 5 time entries · 2 bills · 1 change order ·
 * 3 of your edits kept". What each importer left on another invoice is said too ("9 time entries
 * already on INV-061"), and a part that FAILED is named with its own reason beside what did land -
 * never one "failed" for the lot. `stuck` names the parts that had rows to place and could place
 * none (every line edited or deleted): Start It Over is offered for those. `warnings` are the money
 * sentences a person must read before sending (INV-074's edited tax row).
 */
export function bringInSentence(outcomes: readonly BringInOutcome[]): { sentence: string; partial: boolean; warnings: string[]; stuck: BringInStep[] } {
  const parts: string[] = [];
  const held: string[] = [];
  const failed: string[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  const stuck: BringInStep[] = [];
  let kept = 0;
  let removed = 0;
  for (const o of outcomes) {
    if (!o.ok) {
      if (o.empty) {
        const why = emptyReason(o);
        if (why) notes.push(why.replace(/\.$/, ""));
      } else {
        failed.push(`${STEP_NAME[o.step]} didn't come in: ${(o.error ?? "try again").replace(/\.$/, "")}`);
      }
      continue;
    }
    const st = o.stats ?? {};
    const n = Number(st.pulled_in ?? 0);
    if (n > 0) {
      if (o.step === "labor") parts.push(count(n, "time entry", "time entries"));
      else if (o.step === "materials") parts.push(count(n, "bill", "bills"));
      else if (o.step === "change_orders") parts.push(count(n, "change order", "change orders"));
      else parts.push(count(n, "estimate line", "estimate lines"));
    }
    const takes = Number(st.stock_pulled_in ?? 0);
    if (takes > 0) parts.push(count(takes, "take from stock", "takes from stock"));
    kept += Number(st.kept_edited ?? 0);
    removed += Number(st.removed ?? 0);
    const skipped = Number(st.skipped_claimed ?? 0);
    if (skipped > 0 && (st.claimed_on ?? []).length) {
      const noun = o.step === "labor" ? ["time entry", "time entries"] : o.step === "materials" ? ["bill", "bills"] : o.step === "change_orders" ? ["change order", "change orders"] : ["estimate line", "estimate lines"];
      held.push(`${count(skipped, noun[0], noun[1])} already on ${joinParts(st.claimed_on ?? [])}`);
    }
    warnings.push(...(st.warnings ?? []));
    const didNothing = !Number(st.inserted ?? 0) && !Number(st.updated ?? 0) && !Number(st.removed ?? 0);
    if (didNothing && (st.pulled_in == null || n > 0)) stuck.push(o.step);
  }
  if (kept > 0) parts.push(`${kept} of your ${kept === 1 ? "edit" : "edits"} kept`);
  if (removed > 0) parts.push(`${removed} taken off`);
  const head = parts.length ? `Brought in: ${parts.join(" · ")}.` : failed.length ? "" : "Nothing new to bring in.";
  const tail = [...held, ...notes, ...failed].map((x) => `${x.charAt(0).toUpperCase()}${x.slice(1)}.`);
  return { sentence: [head, ...tail].filter(Boolean).join(" "), partial: failed.length > 0 || warnings.length > 0, warnings, stuck };
}

// ── What the job's New Invoice does (W1-24) ────────────────────────────────────────────────────

/**
 * ONE NEW INVOICE ON THE JOB (W1-24, 2026-09-27). The Invoices tab had two billing buttons, New
 * Invoice and Progress Payment, and the second opened a hub with a Record a Payment mode, a draw
 * type, a billing mode and a figure - four decisions before a bill existed. It is one button now.
 * What one tap does is decided HERE, from the facts the page already reads, in the server's own
 * order (createInvoiceForJob), so the button never offers a door the server refuses:
 *
 *   an open draft on the job    → no sheet: the button goes where the server goes. A draft that
 *                                 takes new work is brought up to date ("Pulled 6 hours and 1 bill
 *                                 into INV-078"); a draft for set amounts is opened and named,
 *                                 because nothing new can go on it.
 *   a payment schedule          → no sheet: "This job bills on its payment schedule", and the
 *                                 schedule's own Request Next Payment.
 *   no estimate and no draw yet → no sheet: createInvoiceForJob, exactly as the old button did.
 *   anything else               → the New Invoice sheet (newInvoiceChoices).
 *
 * A preset from another door (?invoice=deposit|part, Take A Deposit Instead) opens the sheet with
 * that choice made - except where the sheet could only be refused (an open draft, a schedule).
 */
export type NewInvoiceFacts = {
  /** The job's open draft and whether new work goes on it (openDraftOnJob, read by the page). */
  openDraft: Pick<OpenDraft, "id" | "number" | "refreshable"> | null;
  /** payment_milestones rows exist on the job. */
  scheduleActive: boolean;
  /** An estimate that still stands (not declined, not expired) and bills more than $0. */
  hasEstimate: boolean;
  /** A live draw (a deposit, a progress payment, a final) is on the job. */
  drawBilled: boolean;
};

export type NewInvoicePreset = "deposit" | "part";

export type NewInvoiceRoute =
  /** Lands on the open draft: `adds` = new work goes on it (createInvoiceForJob brings it up to
   *  date); otherwise the draft is opened and named. */
  | { kind: "draft"; adds: boolean }
  | { kind: "schedule" }
  /** createInvoiceForJob, one tap, exactly as before (its toast and any door it returns). */
  | { kind: "direct" }
  | { kind: "sheet" };

export function newInvoiceRoute(f: NewInvoiceFacts, preset?: NewInvoicePreset | null): NewInvoiceRoute {
  if (f.openDraft) return { kind: "draft", adds: !!f.openDraft.refreshable };
  if (f.scheduleActive) return { kind: "schedule" };
  if (preset) return { kind: "sheet" };
  if (!f.hasEstimate && !f.drawBilled) return { kind: "direct" };
  return { kind: "sheet" };
}

/** ?invoice=part|deposit, read once: anything else is no preset (never a guess). */
export function invoicePresetFromParam(value: string | null | undefined): NewInvoicePreset | null {
  return value === "deposit" || value === "part" ? value : null;
}

/**
 * THE SHEET'S CHOICES (2 or 3 buttons), each one a door the server takes:
 *
 *   Deposit                 always (createProgressInvoice, kind deposit, a fixed amount).
 *   Part Of The Estimate    when there is an estimate to take a part of (a %, or an amount typed
 *                           instead; createProgressInvoice kind progress, or final).
 *   Bill The Work So Far    only on a job that bills its actuals, and only when there is work to
 *                           bill: its figure is the Overview card's own door (workSoFarDoor), so
 *                           the sheet and the card can never show two numbers. The default there.
 *   The Whole Estimate      on a fixed-price job whose estimate isn't on a bill yet and that has
 *                           no draws (createInvoiceForJob copies the estimate's lines).
 *   Bill The Change Orders  on a fixed-price job whose estimate already went out on a bill, with
 *                           no draws, once a change order is approved: createInvoiceForJob makes
 *                           the second invoice with each approved change order as its own line
 *                           (one already on a bill is skipped). Without it the sheet had only a
 *                           typed amount for an extra, a draw that locks the job into draws and
 *                           never bills the change order as itself. The default there.
 */
export type NewInvoiceChoice = "deposit" | "part" | "work" | "whole" | "changes";

export type NewInvoiceSheetFacts = {
  billingType: string | null | undefined;
  /** The figure the draw doors bill a part of (the page's contract estimate); 0 = none. */
  estimate: number;
  hasEstimate: boolean;
  /** The next New Invoice pulls the job's hours and receipts (nextInvoiceImportsActuals). */
  billsActuals: boolean;
  /** workSoFarDoor's answer: null where there is nothing (or nothing readable) to bill. */
  workDoor: CardDoor;
  /** The estimate a New Invoice would copy, when it is not on a bill yet (fixed price, no draws);
   *  null otherwise. Its total is the figure on The Whole Estimate. */
  wholeEstimate: number | null;
  /** Approved change orders New Invoice would bring onto a new invoice (newInvoicePageFacts): only
   *  counted where that is the server's door, 0 anywhere else. */
  changeOrdersToBill?: number;
};

export function newInvoiceChoices(
  f: NewInvoiceSheetFacts,
  preset?: NewInvoicePreset | null,
): { choices: NewInvoiceChoice[]; initial: NewInvoiceChoice } {
  const choices: NewInvoiceChoice[] = ["deposit"];
  if (f.hasEstimate && f.estimate > 0.005) choices.push("part");
  const work = f.billsActuals && !!f.workDoor && (f.workDoor.kind === "create" || f.workDoor.kind === "draw");
  const changes = !work && f.billingType !== "tm" && f.wholeEstimate == null && (f.changeOrdersToBill ?? 0) > 0;
  if (work) choices.push("work");
  else if (f.billingType !== "tm" && f.wholeEstimate != null && f.wholeEstimate > 0.005) choices.push("whole");
  else if (changes) choices.push("changes");
  const initial: NewInvoiceChoice =
    preset && choices.includes(preset) ? preset : work ? "work" : changes ? "changes" : choices.includes("part") ? "part" : choices[0];
  return { choices, initial };
}

/**
 * WHAT THE SHEET SAYS ABOUT THE WORK SO FAR on a job that bills its actuals, when Bill The Work So
 * Far isn't a choice - never a choice that just isn't there. `unbilledRead` false: the page couldn't
 * read the hours and bills not on a bill yet (its read failed, so it passed none), which is not the
 * same as nothing to bill; the sheet says so and how to get the choice back. null: nothing to say
 * (the choice is there, or the job doesn't bill its actuals).
 */
export const WORK_SO_FAR_UNREAD =
  "The hours and bills not on a bill yet couldn't be read just now, so Bill The Work So Far isn't here. Reload the page to bill the work so far.";

export function workSoFarNote(f: { billsActuals: boolean; unbilledRead: boolean; workDoor: CardDoor }): string | null {
  if (!f.billsActuals) return null;
  if (!f.unbilledRead) return WORK_SO_FAR_UNREAD;
  if (f.workDoor?.kind === "covered") return f.workDoor.note ?? null;
  if (!f.workDoor) return "Every hour and bill so far is on a bill - nothing new to bill.";
  return null;
}

/**
 * PART OF THE ESTIMATE WITH NOTHING LEFT OF IT. An extra is not a part of the estimate: on a job
 * with no draws, a typed amount here would make the job's first draw (and from then on it bills only
 * in draws, so a change order could never be billed as its own lines). So the words point at the
 * change order's own door; only a job already billed in draws is told to type an amount.
 */
export function estimateBilledInFullWords(f: { changesOffered: boolean; drawBilled: boolean; billingType: string | null | undefined }): string {
  if (f.changesOffered) return "The estimate is billed in full. Approved change orders go on their own bill: Bill The Change Orders.";
  if (!f.drawBilled && f.billingType !== "tm")
    return "The estimate is billed in full. Put extra work on a change order: once it's approved, Bill The Change Orders bills it here.";
  return "The estimate is billed in full. For an extra, type an amount instead.";
}

/** The Overview card's unbilled work, as much of it as the door needs (lib/unbilled-work). */
export type WorkSoFar = {
  hours: number;
  billsCount: number;
  stockCount?: number;
  returnsCount?: number;
  total: number;
  laborAmount: number;
  billsBilled: number;
  stockBilled?: number;
};

/**
 * BILL THE WORK SO FAR IS THE OVERVIEW CARD'S DOOR, WITH NO DRAFT OPEN (the sheet only exists
 * when none is). The same inputs the card hands unbilledCardDoor (unbilled-card.tsx cardDoorFor),
 * so the sheet's figure and the card's "Open: $X" are one number: "create" is a standard invoice
 * (createInvoiceForJob), "draw" the progress report that nets a deposit not yet taken off a bill,
 * "covered" no bill at all, null nothing to bill.
 */
export function workSoFarDoor(
  w: WorkSoFar | null | undefined,
  lumpToNet: number,
  drawBilled: boolean,
  money: (n: number) => string,
): CardDoor {
  if (!w) return null;
  const takes = w.stockCount ?? 0;
  const newWork = Math.round((w.laborAmount + w.billsBilled + (w.stockBilled ?? 0)) * 100) / 100;
  return unbilledCardDoor({
    openDraft: null,
    workPending: w.hours > 0 || w.billsCount > 0 || takes > 0,
    returns: w.returnsCount ?? 0,
    total: w.total,
    newWork,
    lumpToNet,
    drawBilled,
    money,
  });
}

/**
 * THE ESTIMATE A NEW INVOICE COPIES: createInvoiceForJob's own pick - of the quotes that still
 * stand (not declined, not expired), the accepted one, else the newest. Its total is the figure
 * on The Whole Estimate. null when none bills above $0.
 */
export function estimateANewInvoiceCopies(
  quotes: readonly { total?: number | string | null; status?: string | null; created_at?: string | null }[],
): number | null {
  const live = quotes
    .filter((q) => isLiveQuote(q.status))
    .slice()
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  const pick = live.find((q) => q.status === "accepted") ?? live[0];
  const total = Number(pick?.total);
  return pick && Number.isFinite(total) && total > 0.005 ? Math.round(total * 100) / 100 : null;
}

/**
 * THE JOB PAGE'S FACTS FOR NEW INVOICE, derived once from what the page already read (its quotes,
 * its invoices, its milestones and its contract estimate), so the page and the tests that pin the
 * routing compute them the same way:
 *
 *   hasEstimate    an estimate still stands (not declined, not expired) and the contract is > $0
 *   drawBilled     a live deposit / progress / final is on the job
 *   scheduleActive payment_milestones rows exist
 *   billsActuals   the next New Invoice pulls the hours and receipts (nextInvoiceImportsActuals:
 *                  no schedule, no estimate that is the contract)
 *   wholeEstimate  the estimate New Invoice would copy, while nothing bills it yet: a fixed-price
 *                  job with no draw and no bill that went out (a sent bill may already be it)
 *   changeOrdersToBill  the job's approved change orders with an amount, counted only where New
 *                  Invoice brings them onto a new invoice (createInvoiceForJob's wantChangeOrders: a
 *                  fixed-price job whose estimate is the contract, a standard bill already out, no
 *                  draws); 0 anywhere else. One already on a bill is skipped by the server, which
 *                  says "nothing new" when that is all of them.
 */
export function newInvoicePageFacts(input: {
  billingType: string | null | undefined;
  estimate: number;
  quotes: readonly { total?: number | string | null; status?: string | null; created_at?: string | null }[];
  invoices: readonly { status?: string | null; invoice_kind?: string | null }[];
  milestoneCount: number;
  changeOrders?: readonly { status?: string | null; amount?: number | string | null }[];
}): { hasEstimate: boolean; drawBilled: boolean; scheduleActive: boolean; billsActuals: boolean; wholeEstimate: number | null; changeOrdersToBill: number } {
  const live = input.quotes.filter((q) => isLiveQuote(q.status));
  const hasEstimate = Number(input.estimate) > 0.005 && live.some((q) => Number(q.total) > 0.005);
  const drawBilled = input.invoices.some((i) => isDrawKind(i.invoice_kind) && i.status !== "void");
  const scheduleActive = input.milestoneCount > 0;
  const billsActuals = nextInvoiceImportsActuals(input.billingType, input.milestoneCount, live.length > 0);
  const wentOut = input.invoices.some((i) => i.status !== "void" && i.status !== "draft");
  const wholeEstimate = input.billingType !== "tm" && !drawBilled && !wentOut ? estimateANewInvoiceCopies(input.quotes) : null;
  const standardOut = input.invoices.some((i) => i.status !== "void" && i.status !== "draft" && !isDrawKind(i.invoice_kind));
  const changeOrdersToBill =
    input.billingType !== "tm" && live.length > 0 && !drawBilled && !scheduleActive && standardOut
      ? // The server's own rule (change-order-billing billableChangeOrders): approved (or unstated), not $0.
        (input.changeOrders ?? []).filter((c) => (c.status == null || c.status === "approved") && Math.abs(Number(c.amount ?? 0)) > 0.005).length
      : 0;
  return { hasEstimate, drawBilled, scheduleActive, billsActuals, wholeEstimate, changeOrdersToBill };
}

/** What Save says it makes: "Create Deposit $500.00", "Create Invoice $1,572.27", "Create Final
 *  Invoice $2,400.00". No figure while there is none to name (an empty amount box). */
export function newInvoiceSaveLabel(
  choice: NewInvoiceChoice,
  last: boolean,
  amount: number | null,
  money: (n: number) => string,
): string {
  const verb = choice === "deposit" ? "Create Deposit" : last ? "Create Final Invoice" : "Create Invoice";
  return amount != null && amount > 0.005 ? `${verb} ${money(amount)}` : verb;
}

/** "a, b and c" - the office's list phrasing. */
function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
