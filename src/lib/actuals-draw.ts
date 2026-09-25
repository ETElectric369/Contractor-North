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
    .select("id, invoice_number, invoice_kind, dismissed_import_keys, created_at")
    .eq("job_id", jobId)
    .eq("status", "draft")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as { id: string; invoice_number: string | null; invoice_kind: string | null; dismissed_import_keys: string[] | null }[];
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
  | { kind: "add"; label: string }
  | { kind: "open"; label: string; href: string }
  /** `note` names a deposit the new bill takes off, so the figure on the button is explained. */
  | { kind: "create"; label: string; note?: string }
  /** No button: a deposit (or a set-amount draw) not yet taken off a bill still covers the work.
   *  `note` is the sentence the card shows instead. */
  | { kind: "covered"; note: string }
  | null;

/**
 * THE CARD NEVER OFFERS A DOOR THE SERVER REFUSES. An open draft that takes new work → "Add to
 * INV-078 ($X)". An open draft that doesn't (a fixed or % draw) → "Open INV-0xx", which goes there:
 * the work waits for the next bill and the card says why. No draft → "Create Invoice for $X".
 * Nothing pending → no button (the card's sentences carry the door).
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
   *  next progress report nets it (resolveDrawCredit), so a "Create Invoice" figure that ignored it
   *  would promise more than the click bills - or a click that bills nothing. */
  lumpToNet?: number;
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
    return { kind: "add", label: total > 0.005 ? `Add to ${name} (${money(total)})` : `Add to ${name}` };
  }
  if (!workPending) return null;
  const figure = total > 0.005 ? total : newWork;
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
      return {
        kind: "create",
        label: `Create Invoice for ${money(Math.round((figure - d.credit) * 100) / 100)}`,
        note: `That is ${money(figure)} of work less the ${money(d.credit)} deposit not yet taken off a bill.`,
      };
    }
  }
  return { kind: "create", label: `Create Invoice for ${money(figure)}` };
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
 * WHERE THE REASON IS SAID: the Import row is blank until one of its buttons is tapped, so the
 * sentence names the button, never "the Import row says why".
 */
export function pulledIntoSentence(
  number: string,
  pulled: { hours: number; bills: number; returns?: number; returnsCredit?: number },
  left?: { hours: number; bills: number; returns?: number } | null,
  money?: (n: number) => string,
): string {
  const parts: string[] = [];
  if (pulled.hours > 0.005) parts.push(hoursWord(pulled.hours));
  if (pulled.bills > 0) parts.push(`${pulled.bills} ${pulled.bills === 1 ? "bill" : "bills"}`);
  const r = pulled.returns ?? 0;
  if (r > 0) {
    const amt = money && (pulled.returnsCredit ?? 0) > 0.005 ? ` (${money(pulled.returnsCredit ?? 0)} back to the customer)` : "";
    parts.push(`${r === 1 ? "a supplier return credit" : `${r} supplier return credits`}${amt}`);
  }
  const head = parts.length ? `Pulled ${joinParts(parts)} into ${number}.` : `Nothing new to pull into ${number}.`;
  const rest: string[] = [];
  const doors: string[] = [];
  if (left && left.hours > 0.005) {
    rest.push(hoursWord(left.hours));
    doors.push("Labor from Timecards");
  }
  if (left && left.bills > 0) {
    rest.push(`${left.bills} ${left.bills === 1 ? "bill" : "bills"}`);
    doors.push("Materials from Costs");
  }
  if (left && (left.returns ?? 0) > 0) {
    const n = left.returns ?? 0;
    rest.push(n === 1 ? "a supplier return" : `${n} supplier returns`);
    if (!doors.includes("Materials from Costs")) doors.push("Materials from Costs");
  }
  return rest.length
    ? `${head} Still not on it: ${joinParts(rest)} - open ${number} and tap ${doors.join(" or ")} to see what is holding ${rest.length === 1 && !/s$/.test(rest[0]) ? "it" : "them"} back.`
    : head;
}

/** "a, b and c" - the office's list phrasing. */
function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
