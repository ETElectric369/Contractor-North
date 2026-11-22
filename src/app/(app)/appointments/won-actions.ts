"use server";
// cn-v1176: the Won sheet's read and the approve door (lane MONEY).
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { callerLang } from "@/lib/lang-of";
import { fillSlots } from "@/lib/lang-words";
import { translator } from "@/lib/i18n";
import { reportError } from "@/lib/observe";
import { dbError } from "@/lib/db-error";
import { getOrgSettings } from "@/lib/org-settings";
import { featureOn } from "@/lib/features";
import { readUsualBillingKind } from "@/lib/schedule-options";
import { todayStrInTz } from "@/lib/tz";
import { addDays } from "@/lib/come-back-days";
import { captureQuoteId } from "@/lib/inspections";
import { revisionOf } from "@/lib/estimate/revision";
import { readTaskKits } from "@/lib/estimate/task-kits";
import type { DraftLineItem } from "@/lib/estimate/line-map";
import {
  lineHole,
  readPriceBook,
  readPricingLevel,
  readVisitEstimateSeed,
  visitEstimateRows,
  type KeyedLine,
  type VisitEstimateSeedRead,
} from "@/lib/estimate/visit-lines";
import {
  applyWonOverrides,
  billingKindOfDocType,
  decideWonState,
  docTypeOfBillingKind,
  lineAmount,
  overrideProblem,
  wonStamp,
  wonTotals,
  type ApproveInput,
  type ApproveResult,
  type BillingKind,
  type WonDecision,
  type WonLine,
  type WonQuoteFact,
  type WonRef,
  type WonSheet,
} from "@/lib/appointments/won-sheet";
import { saveQuote, updateQuoteStatus } from "../quotes/actions";
import { setAppointmentStatus } from "./actions";

/**
 * WON · START THE JOB, THE SERVER'S HALF (cn-v1176, M3 + M4). The owner, 2026-11-21: "an instant create
 * and approve estimate button at the bottom which would run the proper cycle of things ... and pop into
 * the new job having a proper record and simplify our environment while safeguarding the data".
 *
 * readWonSheet decides what the sheet shows (lib/appointments/won-sheet decideWonState, the contract's
 * order). approveVisitEstimate decides it AGAIN before it writes anything, and trusts nothing the
 * client holds: it rebuilds the lines through THE one builder (lib/estimate/visit-lines), checks the
 * stamp, applies the overrides by key, refuses while any hole remains, and writes only through the
 * existing doors: saveQuote (the estimate, under the id the sheet minted once), updateQuoteStatus (the
 * acceptance, recorded in person by the signed-in office person, which makes the job and closes the
 * visits behind the estimate) and setAppointmentStatus (Mark Inspection Done's own door, for an
 * inspection still booked). Twice-safe: a second tap meets the job; a retry lands on the one id; an
 * estimate that already stands is the one approved, never a second.
 *
 * OFFICE ONLY (requireStaff): a tech or crew lead is refused in one sentence and is sent no price.
 * Every sentence is the caller's language (lib/words/quotes-server, qs_won…). A "use server" file
 * exports only async functions.
 */

type Say = (key: string, vars?: Record<string, string | number>) => Promise<string>;
function sayer(sb: unknown, userId?: string | null): Say {
  let lang: ReturnType<typeof callerLang> | null = null;
  return async (key, vars) => fillSlots(translator(await (lang ??= callerLang(sb as Parameters<typeof callerLang>[0], userId)))(key), vars);
}

/** The columns an estimate is decided on (projection law: every one the sheet or the door reads). */
const QUOTE_FACT_COLS = "id, quote_number, status, job_id, total, subtotal, tax, tax_rate, doc_type, customer_id, inquiry_id, created_at" as const;
type QuoteRow = {
  id: string;
  quote_number: string | null;
  status: string | null;
  job_id: string | null;
  total: number | string | null;
  subtotal: number | string | null;
  tax: number | string | null;
  tax_rate: number | string | null;
  doc_type: string | null;
  customer_id: string | null;
  inquiry_id: string | null;
  created_at: string | null;
};
const n = (v: unknown): number => Number(v ?? 0) || 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everything one decision read, for the door that acts on it. */
type Decided = {
  decision: WonDecision;
  sheet: WonSheet;
  seed: VisitEstimateSeedRead;
  /** The builder's lines, keyed (source "visit"); the estimate's own (source "existing"). */
  rows: KeyedLine[];
  quoteRows: Map<string, QuoteRow>;
  taxRate: number;
  settings: ReturnType<typeof getOrgSettings>;
  /** The visit's capture backlink as the decision read it (the estimate id it named, or null). */
  behindId: string | null;
};

async function jobRefs(sb: SupabaseClient, ids: string[]): Promise<Map<string, WonRef>> {
  const out = new Map<string, WonRef>();
  const want = Array.from(new Set(ids.filter(Boolean)));
  if (!want.length) return out;
  const { data, error } = await sb.from("jobs").select("id, job_number").in("id", want);
  if (error) throw new Error(dbError(error));
  for (const j of (data ?? []) as { id: string; job_number: string | null }[]) out.set(j.id, { id: j.id, number: j.job_number ?? null });
  for (const id of want) if (!out.has(id)) out.set(id, { id, number: null });
  return out;
}

const factOf = (q: QuoteRow, jobs: Map<string, WonRef>): WonQuoteFact => ({
  id: q.id,
  number: q.quote_number ?? null,
  status: q.status ?? null,
  job: q.job_id ? (jobs.get(q.job_id) ?? { id: q.job_id, number: null }) : null,
  total: n(q.total),
});

/** The builder's lines as the sheet shows them: each with its key, its stored-way amount and its hole. */
const wonLinesOf = (rows: KeyedLine[]): WonLine[] =>
  rows.map(({ key, line }) => ({
    key,
    description: line.description,
    quantity: Number(line.quantity) || 0,
    unit: line.unit ?? null,
    unitPrice: Number(line.unit_price) || 0,
    amount: lineAmount(line.quantity, line.unit_price),
    hole: lineHole(line),
  }));

/**
 * THE ONE DECISION both doors make. Reads the visit (and its answers, through the builder's reader), the
 * company's switches, the visit's job, the estimate behind the visit (by its capture backlink, read the
 * way lib/estimate/behind-visit reads it: a superseded one through its standing revision) and its lead's
 * estimates; builds the lines only when nothing earlier decided. A failed read throws (the callers say it).
 */
async function decide(sb: SupabaseClient, orgId: string | null, appointmentId: string): Promise<Decided | null> {
  const seed = await readVisitEstimateSeed(sb, appointmentId);
  if (!seed) return null;
  const visit = seed.visit;
  const { data: org, error: orgErr } = await sb.from("organizations").select("settings").limit(1).maybeSingle();
  if (orgErr) throw new Error(dbError(orgErr));
  const settings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const estimatesOn = featureOn(settings.features, "estimates");

  const quoteRows = new Map<string, QuoteRow>();
  // The estimate behind the visit (capture.quote_id): superseded reads through its standing revision.
  let behindRow: QuoteRow | null = null;
  const behindId = captureQuoteId(visit.capture);
  if (behindId) {
    const { data, error } = await sb.from("quotes").select(QUOTE_FACT_COLS).eq("id", behindId).maybeSingle();
    if (error) throw new Error(dbError(error));
    behindRow = (data as QuoteRow | null) ?? null;
    if (behindRow?.status === "superseded") {
      const rev = await revisionOf(sb, { quoteId: behindRow.id, orgId });
      if (rev) {
        const { data: r, error: rErr } = await sb.from("quotes").select(QUOTE_FACT_COLS).eq("id", rev.id).maybeSingle();
        if (rErr) throw new Error(dbError(rErr));
        behindRow = (r as QuoteRow | null) ?? null;
      }
    }
  }
  // The lead's estimates that can still decide anything: draft, sent, accepted. Newest first.
  let leadRows: QuoteRow[] = [];
  if (visit.inquiry_id) {
    const { data, error } = await sb
      .from("quotes")
      .select(QUOTE_FACT_COLS)
      .eq("inquiry_id", visit.inquiry_id)
      .in("status", ["draft", "sent", "accepted"])
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw new Error(dbError(error));
    leadRows = (data ?? []) as QuoteRow[];
  }
  for (const q of [behindRow, ...leadRows]) if (q) quoteRows.set(q.id, q);
  const jobs = await jobRefs(sb, [visit.job_id ?? "", ...[...quoteRows.values()].map((q) => q.job_id ?? "")]);

  const facts = {
    visit: { type: visit.type, status: visit.status, outcome: visit.outcome, job: visit.job_id ? (jobs.get(visit.job_id) ?? null) : null },
    behind: behindRow ? factOf(behindRow, jobs) : null,
    lead: leadRows.map((q) => ({ ...factOf(q, jobs), createdAt: q.created_at })),
    estimatesOn,
    visitLines: { priced: 1, holes: 0 },
  };
  let decision = decideWonState(facts);
  let rows: KeyedLine[] = [];
  if (decision.kind === "visit") {
    // Only now are the lines built: the price book, his task kits and the pricing customer's level.
    const [book, kitsRead, level] = await Promise.all([
      readPriceBook(sb),
      readTaskKits((sel) => sb.from("kits").select(sel).order("name"), "category"),
      readPricingLevel(sb, seed.pricingCustomerId),
    ]);
    if (book.error) throw new Error(dbError(book.error));
    if (kitsRead.state === "failed") reportError("won-actions:kits", kitsRead.error, { appointmentId });
    rows = visitEstimateRows({
      scopes: seed.scopes,
      tasks: seed.tasks,
      typedItems: seed.typed?.items,
      priceItems: (book.data ?? []) as never,
      kits: kitsRead.kits,
      level,
      settings: { default_markup_pct: settings.default_markup_pct, default_labor_rate: settings.default_labor_rate },
    });
    const lines = wonLinesOf(rows);
    decision = decideWonState({ ...facts, visitLines: { priced: lines.filter((l) => !l.hole).length, holes: lines.filter((l) => l.hole).length } });
  }

  const noCustomerOf = () =>
    !visit.customer_id && !seed.lead?.customer_id && !(seed.lead?.name?.trim() || seed.lead?.company_name?.trim());
  let taxRate = 0;
  let sheet: WonSheet;
  switch (decision.kind) {
    case "refuse":
      sheet = { ok: false, error: "" }; // the callers say the sentence
      break;
    case "has_job":
      sheet = { ok: true, state: "has_job", job: decision.job };
      break;
    case "finish":
      // The job's billing kind the accepted estimate's own word says, as for source "existing".
      sheet = {
        ok: true,
        state: "finish",
        quote: { id: decision.quote.id, number: decision.quote.number },
        total: decision.quote.total,
        billingKind: billingKindOfDocType(quoteRows.get(decision.quote.id)?.doc_type),
      };
      break;
    case "refer":
      sheet = { ok: true, state: "refer", quote: { id: decision.quote.id, number: decision.quote.number }, job: decision.job };
      break;
    case "plain":
      sheet = { ok: true, state: "plain", why: decision.why, billingKind: await readUsualBillingKind(sb), noCustomer: noCustomerOf() };
      break;
    case "existing": {
      // THE ESTIMATE'S OWN STORED LINES AND TOTALS, never rebuilt from the visit: it may have been edited
      // by hand, and it is the price the customer was told. A $0 line on it is a hole.
      const q = quoteRows.get(decision.quote.id)!;
      const { data: items, error } = await sb
        .from("quote_line_items")
        .select("id, description, quantity, unit, unit_price, line_total, sort_order")
        .eq("quote_id", q.id)
        .order("sort_order");
      if (error) throw new Error(dbError(error));
      const lines: WonLine[] = ((items ?? []) as { id: string; description: string | null; quantity: unknown; unit: string | null; unit_price: unknown; line_total: unknown }[]).map((r) => ({
        key: `line:${r.id}`,
        description: r.description ?? "",
        quantity: n(r.quantity),
        unit: r.unit ?? null,
        unitPrice: n(r.unit_price),
        amount: n(r.line_total),
        hole: n(r.unit_price) > 0 ? null : { kind: "zero", flag: null },
      }));
      taxRate = n(q.tax_rate);
      const totals = { subtotal: n(q.subtotal), tax: n(q.tax), total: n(q.total) };
      // WHAT THE JOB WILL HAVE (cn-v1176 fix U2): a job made from an estimate takes the ESTIMATE's
      // customer, else one made from the estimate's own lead (quotes/actions materializeQuoteCustomer),
      // never the visit's. So the line is said from the estimate's side, its lead read when it is not
      // the visit's own.
      let existingNoCustomer = false;
      if (!q.customer_id) {
        if (!q.inquiry_id) existingNoCustomer = true;
        else {
          let l: { customer_id: string | null; name: string | null; company_name: string | null } | null = null;
          if (q.inquiry_id === seed.lead?.id) l = seed.lead;
          else {
            const { data: ql, error: qlErr } = await sb.from("inquiries").select("id, customer_id, name, company_name").eq("id", q.inquiry_id).maybeSingle();
            if (qlErr) throw new Error(dbError(qlErr));
            l = (ql as typeof l) ?? null;
          }
          existingNoCustomer = !l?.customer_id && !(l?.name?.trim() || l?.company_name?.trim());
        }
      }
      sheet = {
        ok: true,
        state: "estimate",
        source: "existing",
        quote: { id: q.id, number: q.quote_number ?? null },
        stamp: wonStamp(lines, taxRate, totals),
        lines,
        taxRate,
        ...totals,
        billingKind: billingKindOfDocType(q.doc_type),
        noCustomer: existingNoCustomer,
      };
      break;
    }
    case "visit": {
      // The tax the editor's first save would carry: the company's default rate while Sales Tax is on.
      if (featureOn(settings.features, "sales_tax")) {
        const { data: tr, error } = await sb.from("tax_rates").select("id, rate, is_default").eq("is_default", true).order("created_at").limit(1).maybeSingle();
        if (error) throw new Error(dbError(error));
        taxRate = tr ? n((tr as { rate?: unknown }).rate) / 100 : 0;
      }
      const lines = wonLinesOf(rows);
      const totals = wonTotals(lines, taxRate);
      sheet = {
        ok: true,
        state: "estimate",
        source: "visit",
        quote: null,
        stamp: wonStamp(lines, taxRate, totals),
        lines,
        taxRate,
        ...totals,
        billingKind: await readUsualBillingKind(sb),
        noCustomer: noCustomerOf(),
      };
      break;
    }
  }
  return { decision, sheet, seed, rows, quoteRows, taxRate, settings, behindId };
}

/** The refusal's one sentence (the Not Sold one names its one way back). */
function refusalKey(why: "not_inspection" | "cancelled" | "not_sold"): string {
  return why === "not_sold" ? "qs_wonNotSold" : why === "cancelled" ? "qs_wonCancelled" : "qs_wonNotInspection";
}

/** THE SHEET'S READ (M3). Office only; the server decides the state. */
export async function readWonSheet(appointmentId: string): Promise<WonSheet> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: await sayer(await createClient())("qs_wonOfficeOnly") };
  const say = sayer(ctx.supabase, ctx.userId);
  if (typeof appointmentId !== "string" || !UUID.test(appointmentId)) return { ok: false, error: await say("qs_wonVisitNotFound") };
  let d: Decided | null;
  try {
    d = await decide(ctx.supabase as unknown as SupabaseClient, ctx.orgId, appointmentId);
  } catch (e) {
    reportError("readWonSheet", e, { appointmentId });
    return { ok: false, error: await say("qs_wonReadFailed") };
  }
  if (!d) return { ok: false, error: await say("qs_wonVisitNotFound") };
  if (d.decision.kind === "refuse") return { ok: false, error: await say(refusalKey(d.decision.why)) };
  return d.sheet;
}

/** THE APPROVE DOOR (M4). Re-decides first; never trusts the client's lines, prices or state. */
export async function approveVisitEstimate(input: ApproveInput): Promise<ApproveResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: await sayer(await createClient())("qs_wonOfficeOnly"), reread: false };
  const sb = ctx.supabase as unknown as SupabaseClient;
  const say = sayer(sb, ctx.userId);
  const appointmentId = String(input?.appointmentId ?? "");
  const quoteId = String(input?.quoteId ?? "");
  const billingType: BillingKind = input?.billingType === "fixed" ? "fixed" : "tm";
  const overrides = Array.isArray(input?.overrides) ? input.overrides : [];
  if (!UUID.test(appointmentId)) return { ok: false, error: await say("qs_wonVisitNotFound"), reread: false };
  if (input?.billingType !== "tm" && input?.billingType !== "fixed") return { ok: false, error: await say("qs_wonPickBilling"), reread: false };

  let d: Decided | null;
  try {
    d = await decide(sb, ctx.orgId, appointmentId);
  } catch (e) {
    reportError("approveVisitEstimate:decide", e, { appointmentId });
    return { ok: false, error: await say("qs_wonReadFailed"), reread: false };
  }
  if (!d) return { ok: false, error: await say("qs_wonVisitNotFound"), reread: false };
  const dec = d.decision;

  switch (dec.kind) {
    case "refuse":
      return { ok: false, error: await say(refusalKey(dec.why)), reread: false };
    case "refer":
      // The sentence names the refer state's one button by its exact words; the sheet reads again, so
      // that button is on the page (cn-v1176 fix F9).
      return {
        ok: false,
        error: await say("qs_wonRefer", {
          quote: dec.quote.number ?? "",
          job: dec.job.number ?? "",
          tie: dec.job.number ? await say("vi_btn_wonTieTo", { j: dec.job.number }) : await say("vi_btn_wonTieToTheJob"),
        }),
        reread: true,
      };
    case "plain":
      return { ok: false, error: await say("qs_wonNothingToApprove"), reread: true };
    case "has_job": {
      // A SECOND TAP IS HARMLESS: the estimate this sheet approved (behind the visit, or the id it minted)
      // answers with its job. A visit whose job was made with no estimate is said, and the sheet reads again.
      let q: WonQuoteFact | null = dec.quote;
      if (!q && UUID.test(quoteId)) {
        const { data } = await sb.from("quotes").select(QUOTE_FACT_COLS).eq("id", quoteId).maybeSingle();
        const row = data as QuoteRow | null;
        if (row?.status === "accepted" && row.job_id === dec.job.id) q = factOf(row, new Map([[dec.job.id, dec.job]]));
      }
      if (!q) return { ok: false, error: await say("qs_wonHasJob"), reread: true };
      return { ok: true, quote: { id: q.id, number: q.number }, total: q.total, job: dec.job, warnings: [] };
    }
    case "finish":
    case "existing": {
      if (quoteId !== dec.quote.id) return { ok: false, error: await say("qs_wonOtherEstimate"), reread: true };
      if (dec.kind === "existing" && d.sheet.ok && d.sheet.state === "estimate") {
        if (input.stamp !== d.sheet.stamp) return { ok: false, error: await say("qs_wonChanged"), reread: true };
        // A hole on an estimate that stands is answered on that estimate, never in this sheet. An estimate
        // with no lines at all is one too (cn-v1176 fix F7): nothing is approved at $0.
        if (!d.sheet.lines.length) return { ok: false, error: await say("qs_wonExistingEmpty", { quote: dec.quote.number ?? "" }), reread: false };
        if (d.sheet.lines.some((l) => l.hole)) return { ok: false, error: await say("qs_wonExistingHole", { quote: dec.quote.number ?? "" }), reread: false };
      }
      // THE PAPER'S WORD DECIDES (cn-v1178, the owner's decision 2): an estimate that already stands
      // makes a job that bills as its own word says (a Quote fixed, an Estimate time and material). The
      // sheet shows that word and offers no choice; a different kind sent for it is not taken.
      return accept(sb, say, d, dec.quote.id, billingKindOfDocType(d.quoteRows.get(dec.quote.id)?.doc_type), []);
    }
    case "visit": {
      if (!d.sheet.ok || d.sheet.state !== "estimate") return { ok: false, error: await say("qs_wonChanged"), reread: true };
      if (input.stamp !== d.sheet.stamp) return { ok: false, error: await say("qs_wonChanged"), reread: true };
      if (overrideProblem(overrides) !== null) return { ok: false, error: await say("qs_wonBadNumber"), reread: false };
      // ONLY A HOLE ROW IS ANSWERED HERE (cn-v1176 fix F5): a priced line is shown read-only, so an
      // override whose key is not a hole row of the lines just built is a sheet out of date (or a lie).
      const holeKeys = new Set(d.sheet.lines.filter((l) => l.hole).map((l) => l.key));
      if (overrides.some((o) => !holeKeys.has(String(o?.key ?? "")))) return { ok: false, error: await say("qs_wonChanged"), reread: true };
      const shown = applyWonOverrides(d.sheet.lines, overrides);
      if (shown.some((l) => l.hole)) return { ok: false, error: await say("qs_wonHoleLeft"), reread: false };
      if (!shown.length) return { ok: false, error: await say("qs_wonNoPricedLine"), reread: false };
      if (!UUID.test(quoteId)) return { ok: false, error: await say("qs_wonIdTaken"), reread: true };

      // THE ONE ID: a retry lands on the row the first try made. Read its status first: an accepted one
      // is not saved again (a save on it is refused, not_editable); a draft from a lost answer is updated
      // in place; any other row under this id is not this visit's and is never written over. A row that
      // stands under the id is THIS visit's only when the visit's own capture backlink names it (a first
      // save makes the row and the backlink together): a client that sends another estimate's id never
      // overwrites or accepts it (cn-v1176 fix F4).
      const { data: standing, error: standErr } = await sb.from("quotes").select("id, status, inquiry_id").eq("id", quoteId).maybeSingle();
      if (standErr) return { ok: false, error: dbError(standErr), reread: false };
      const st = standing as { id: string; status: string | null; inquiry_id: string | null } | null;
      const lead = d.seed.visit.inquiry_id ?? null;
      if (
        st &&
        (d.behindId !== st.id || (st.inquiry_id ?? null) !== lead || (st.status !== "draft" && st.status !== "accepted"))
      ) {
        return { ok: false, error: await say("qs_wonIdTaken"), reread: true };
      }
      const warnings: string[] = [];
      if (st?.status !== "accepted") {
        const byKey = new Map(d.rows.map((r) => [r.key, r.line]));
        const items: DraftLineItem[] = shown.map((l) => {
          const base = byKey.get(l.key)!;
          return { ...base, quantity: l.quantity, unit_price: l.unitPrice };
        });
        const today = todayStrInTz(d.settings.timezone || "America/Los_Angeles");
        const saved = await saveQuote({
          id: quoteId,
          customer_id: d.seed.pricingCustomerId,
          job_id: null,
          inquiry_id: lead,
          capture_appointment_id: d.seed.visit.id,
          title: "",
          description: null,
          notes: "",
          tax_rate: d.taxRate,
          valid_until: addDays(today, d.settings.quote_expiry_days || 30),
          doc_type: docTypeOfBillingKind(billingType),
          items,
        });
        if (!saved.ok) return { ok: false, error: saved.error ?? (await say("qs_wonReadFailed")), reread: false };
        if ("warning" in saved && saved.warning) warnings.push(saved.warning);
      }
      return accept(sb, say, d, quoteId, billingType, warnings, true);
    }
  }
}

/**
 * THE ACCEPTANCE, through the existing door: recorded in person by the signed-in office person (on a
 * fresh acceptance only), the job made with the kind the sheet asked for, the visits behind the
 * estimate closed Won and tied to the job (closeVisitsBehindQuote, inside the door). Then an inspection
 * still booked is marked Done through Mark Inspection Done's own door. Answers with the estimate's
 * number, its STORED total and the job.
 */
async function accept(
  sb: SupabaseClient,
  say: Say,
  d: Decided,
  quoteId: string,
  billingType: BillingKind,
  warnings: string[],
  savedHere = false,
): Promise<ApproveResult> {
  const visitId = d.seed.visit.id;
  // TWO OFFICE PEOPLE ON ONE VISIT (cn-v1176 fix U1): the visit is read again just before the acceptance.
  // It has a job now, or its capture backlink names an estimate that is neither this one nor the one the
  // decision read: stop, and the sheet reads again.
  const { data: now, error: nowErr } = await sb.from("appointments").select("id, job_id, capture").eq("id", visitId).maybeSingle();
  if (nowErr) return { ok: false, error: await say("qs_wonReadFailed"), reread: true };
  const nowRow = now as { job_id?: string | null; capture?: unknown } | null;
  if (!nowRow) return { ok: false, error: await say("qs_wonVisitNotFound"), reread: true };
  if (nowRow.job_id) return { ok: false, error: await say("qs_wonHasJob"), reread: true };
  const nowBehind = captureQuoteId(nowRow.capture);
  if (nowBehind && nowBehind !== quoteId && nowBehind !== d.behindId) {
    return { ok: false, error: await say("qs_wonOtherEstimate"), reread: true };
  }
  const res = await updateQuoteStatus(quoteId, "accepted", { billingType, inPerson: true });
  if (!res?.ok) {
    const why = (res as { error?: string })?.error ?? "";
    return { ok: false, error: savedHere ? await say("qs_wonSavedNotAccepted", { why }) : why || (await say("qs_wonReadFailed")), reread: true };
  }
  if ("warning" in res && res.warning) warnings.push(res.warning);

  // THE INSPECTION READS DONE. Won and the job are written by the acceptance (closeVisitsBehindQuote);
  // a visit still booked is completed by the door the header's Mark Inspection Done uses.
  const { data: after } = await sb.from("appointments").select("id, status, job_id, outcome").eq("id", visitId).maybeSingle();
  const v = after as { status?: string | null; job_id?: string | null } | null;
  if (v && (v.status === "scheduled" || v.status === "proposed")) {
    const done = await setAppointmentStatus(visitId, "completed");
    if (!done.ok) warnings.push(await say("qs_wonNotMarkedDone", { why: done.error ?? "" }));
  }

  const { data: qrow } = await sb.from("quotes").select("id, quote_number, total, job_id").eq("id", quoteId).maybeSingle();
  const q = qrow as { id: string; quote_number: string | null; total: unknown; job_id: string | null } | null;
  const jobId = ("jobId" in res && res.jobId ? String(res.jobId) : null) ?? q?.job_id ?? null;
  let job: WonRef | null = null;
  if (jobId) {
    const { data: j } = await sb.from("jobs").select("id, job_number").eq("id", jobId).maybeSingle();
    job = { id: jobId, number: (j as { job_number?: string | null } | null)?.job_number ?? null };
    if (v && v.job_id && v.job_id !== jobId) reportError("approveVisitEstimate:tie", new Error("the visit is on another job"), { visitId, jobId });
    else if (v && !v.job_id) warnings.push(await say("qs_wonNotTied"));
  }
  revalidatePath(`/appointments/${visitId}`);
  revalidatePath("/inspections");
  return { ok: true, quote: { id: quoteId, number: q?.quote_number ?? null }, total: n(q?.total), job, warnings };
}
