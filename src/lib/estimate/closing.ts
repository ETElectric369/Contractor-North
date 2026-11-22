import type { SupabaseClient } from "@supabase/supabase-js";
import { QUOTE_EXPIRY_SOON_DAYS } from "@/lib/action-items/needs-you-rule";
import { quoteSettled, type SettledInvoice } from "@/lib/action-items/quote-settled";

/**
 * CLOSING: WHICH ESTIMATES ARE STILL WAITING ON THE CUSTOMER'S ANSWER (cn-v1172).
 *
 * Erik, 2026-11-19, after the second meeting: "once an estimate is written up and sent it will not
 * only file with the all estimates list with status but we want it to appear in a new sub-nav tab
 * right below Estimates called Closing as an inbox for estimates that havent been accepted [...] once
 * an estimate is accepted it will disappear from there and file with the customer file". And, asked
 * whether that list replaces the follow-up day on an estimate: "Closing is the reminder yes".
 *
 * So Closing is not a status of its own and nothing is stamped. An estimate is ON THE CLOSING LIST
 * while it is SENT and NOT SETTLED (quoteSettled, the one rule Needs You already asks: an invoice
 * names it, its job is billed or closed, or a revision replaced it). Accepted, Declined, Expired and
 * Superseded are answers: the estimate leaves by itself the moment its status says so.
 *
 * THE LIST IS THE REMINDER, so there is no follow-up day (quotes.follow_up_at is no longer read or
 * written; the column stays). What the app adds is a CLOCK and one question, "does this one need a
 * person now?":
 *   offer_ended   the customer's offer window (valid_until, printed on the estimate) is past;
 *   offer_ends    it ends within QUOTE_EXPIRY_SOON_DAYS days (today counts);
 *   quiet         CLOSING_QUIET_DAYS or more have gone by since it was last sent.
 * Those are the ones the Sales badge counts and Needs You lists. The rest sit on the list, quietly:
 * the customer has had it a few days and nothing is due.
 *
 * "SINCE IT WAS SENT" is the last send the app logged for it (sent_messages, 0407). An estimate
 * marked Sent by hand, or sent before that log existed, has no such row: its wait is measured from
 * the day it was written, which is what Needs You measured for every estimate before this, and
 * `sentLogged` is false so a screen never calls that day a send.
 *
 * THE DAY MATH IS THE DATABASE FILTER'S (action-items/due-filters quoteNoAnswerFilter), on purpose:
 * days are counted from midnight UTC of the company's own today. A last send is never earlier than
 * the estimate's creation, so every estimate this rule calls quiet is one that filter already reads.
 *
 * ONE RULE, EVERY READER: the Closing page, the Sales badge and Needs You's No Answer Yet rows.
 * Pure rule + one reader. No catalog (a lib never imports one).
 */

/** Days without an answer, counted from the last send, before an estimate asks for a person. */
export const CLOSING_QUIET_DAYS = 7;

const DAY_MS = 86_400_000;

export type ClosingQuote = {
  id: string;
  status?: string | null;
  created_at?: string | null;
  /** The customer's offer window: a day (YYYY-MM-DD), printed on the estimate they hold. */
  valid_until?: string | null;
};

export type ClosingWhy = "offer_ended" | "offer_ends" | "quiet";

export type ClosingState = {
  /** On the Closing list: sent, and not settled. */
  closing: boolean;
  /** The instant the wait is measured from: the last logged send, else the day it was written. */
  sinceAt: string | null;
  /** True when `sinceAt` is a send the app logged. False: no send on record. */
  sentLogged: boolean;
  /** Whole days from `sinceAt` to the start of the company's today. null: no readable day. */
  daysWaiting: number | null;
  offer: "none" | "open" | "ends_soon" | "ended";
  /** Days from today to the offer's last day (0 = today, negative = past). null: no offer day. */
  daysToOfferEnd: number | null;
  /** The Sales badge and Needs You count this one. */
  needsAttention: boolean;
  why: ClosingWhy | null;
};

const ms = (iso: string | null | undefined): number => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : NaN;
};

/**
 * ONE ESTIMATE, ASKED ONCE. `settled` is quoteSettled's answer for it; `lastSentAt` the newest
 * sent_messages row for it (null: none); `todayStr` the company's own day (YYYY-MM-DD).
 */
export function closingState(
  q: ClosingQuote,
  opts: { settled: boolean; lastSentAt?: string | null; todayStr: string },
): ClosingState {
  const closing = q.status === "sent" && !opts.settled;
  const todayMs = Date.parse(`${opts.todayStr}T00:00:00Z`);

  const sentMs = ms(opts.lastSentAt);
  const sentLogged = Number.isFinite(sentMs);
  const sinceAt = sentLogged ? (opts.lastSentAt as string) : Number.isFinite(ms(q.created_at)) ? (q.created_at as string) : null;
  const sinceMs = ms(sinceAt);
  const daysWaiting = Number.isFinite(sinceMs) && Number.isFinite(todayMs) ? Math.max(0, Math.floor((todayMs - sinceMs) / DAY_MS)) : null;

  const offerDay = String(q.valid_until ?? "").slice(0, 10);
  const offerMs = /^\d{4}-\d{2}-\d{2}$/.test(offerDay) ? Date.parse(`${offerDay}T00:00:00Z`) : NaN;
  const daysToOfferEnd = Number.isFinite(offerMs) && Number.isFinite(todayMs) ? Math.round((offerMs - todayMs) / DAY_MS) : null;
  const offer: ClosingState["offer"] =
    daysToOfferEnd == null ? "none" : daysToOfferEnd < 0 ? "ended" : daysToOfferEnd <= QUOTE_EXPIRY_SOON_DAYS ? "ends_soon" : "open";

  // The quiet test is the filter's own: the wait began on or before midnight UTC, CLOSING_QUIET_DAYS ago.
  const quiet = Number.isFinite(sinceMs) && Number.isFinite(todayMs) && sinceMs <= todayMs - CLOSING_QUIET_DAYS * DAY_MS;
  const why: ClosingWhy | null = !closing ? null : offer === "ended" ? "offer_ended" : offer === "ends_soon" ? "offer_ends" : quiet ? "quiet" : null;

  return { closing, sinceAt, sentLogged, daysWaiting, offer, daysToOfferEnd, needsAttention: why != null, why };
}

/**
 * THE ORDER THE LIST IS WORKED IN: the ones that need a person first, then the one that has waited
 * longest. An estimate with no readable day keeps its place at the end of its group.
 */
export function sortClosing<T extends { state: ClosingState }>(rows: readonly T[]): T[] {
  const since = (r: T) => {
    const at = ms(r.state.sinceAt);
    return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
  };
  return [...rows].sort((a, b) => Number(b.state.needsAttention) - Number(a.state.needsAttention) || since(a) - since(b));
}

/**
 * WHERE A ROW'S NAME LEADS: the person's file. An estimate's person is a customer record by the time
 * it is sent, so the customer's page first (it holds their estimates, inspections and requests);
 * else the lead's file. null: nobody to open, the name is plain words.
 */
export function closingFileHref(r: { customer_id?: string | null; inquiry_id?: string | null }): string | null {
  if (r.customer_id) return `/crm/${r.customer_id}`;
  if (r.inquiry_id) return `/leads/${r.inquiry_id}`;
  return null;
}

/* ── THE ONE READER ─────────────────────────────────────────────────────────────────────────────── */

/** What the reader asks of `quotes`. `total` is here: Closing is an office page (never a tech's). */
export const CLOSING_COLUMNS =
  "id, quote_number, doc_type, title, status, total, valid_until, created_at, job_id, customer_id, inquiry_id, customers(name, company_name), inquiry:inquiry_id(name, company_name, status), jobs:job_id(status)";
/** What quoteSettled reads of an invoice. */
export const CLOSING_INVOICE_COLUMNS = "id, quote_id, job_id, status, created_at, invoice_kind";
/** The most sent estimates the list holds; past it the page says it was cut (the ones WRITTEN FIRST are
 *  kept: the read is ordered by created_at, which is not the wait when an estimate was sent again). */
export const CLOSING_CAP = 100;
/** Ids per request: a longer `in (...)` list is a longer address than the API takes. */
const CHUNK = 50;

export type ClosingRow = {
  id: string;
  quote_number: string | null;
  doc_type: string | null;
  title: string | null;
  total: number | null;
  valid_until: string | null;
  created_at: string | null;
  job_id: string | null;
  customer_id: string | null;
  inquiry_id: string | null;
  customerName: string | null;
  customerCompany: string | null;
  state: ClosingState;
};

export type ClosingRead = {
  rows: ClosingRow[];
  /** More than CLOSING_CAP estimates are out; the CLOSING_CAP written first are the ones listed. */
  cut: boolean;
  /** The list itself could not be read: nothing is known, and a caller must say so. */
  error: unknown | null;
  /**
   * A read BEHIND the list failed (a job's bills, the bills that name an estimate, its revisions,
   * the send log). The rows are still listed: a failed read settles nothing and logs no send, so an
   * estimate is offered, never hidden on a guess. The caller reports these.
   */
  softErrors: unknown[];
};

type Res = { data: unknown[] | null; error: unknown | null };
const one = <T,>(rel: unknown): T | null => ((Array.isArray(rel) ? rel[0] : rel) ?? null) as T | null;

/**
 * EVERY ESTIMATE ON THE CLOSING LIST, in the order it is worked. One read of the sent estimates;
 * only when there is one, the four reads the rule needs (in chunks of CHUNK ids). `orgId` is for a
 * caller whose client is not the person's own session (row security scopes a session by itself).
 */
export async function loadClosing(supabase: SupabaseClient, opts: { todayStr: string; orgId?: string | null }): Promise<ClosingRead> {
  // Untyped on purpose: the API's typed builder, carried through a generic, is deeper than tsc reads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope = (b: any): any => (opts.orgId ? b.eq("org_id", opts.orgId) : b);

  const sent = (await scope(supabase.from("quotes").select(CLOSING_COLUMNS).eq("status", "sent"))
    .order("created_at", { ascending: true })
    .limit(CLOSING_CAP + 1)) as Res;
  if (sent.error) return { rows: [], cut: false, error: sent.error, softErrors: [] };
  const all = (sent.data ?? []) as Record<string, unknown>[];
  const cut = all.length > CLOSING_CAP;
  const list = all.slice(0, CLOSING_CAP);
  if (!list.length) return { rows: [], cut: false, error: null, softErrors: [] };

  const ids = list.map((q) => String(q.id));
  const jobIds = [...new Set(list.map((q) => (q.job_id ? String(q.job_id) : "")).filter(Boolean))];
  const softErrors: unknown[] = [];
  /** One `in (...)` read, CHUNK ids at a time. A chunk that fails is reported and reads as no rows. */
  const inChunks = async (values: string[], read: (chunk: string[]) => PromiseLike<unknown>): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = [];
    const chunks: string[][] = [];
    for (let i = 0; i < values.length; i += CHUNK) chunks.push(values.slice(i, i + CHUNK));
    const answers = (await Promise.all(chunks.map((c) => Promise.resolve(read(c)).catch((e) => ({ data: null, error: e }))))) as Res[];
    for (const a of answers) {
      if (a.error) softErrors.push(a.error);
      else out.push(...((a.data ?? []) as Record<string, unknown>[]));
    }
    return out;
  };

  const [jobInvoiceRows, namingRows, revisionRows, sendRows] = await Promise.all([
    inChunks(jobIds, (c) => scope(supabase.from("invoices").select(CLOSING_INVOICE_COLUMNS).in("job_id", c)).limit(2000)),
    inChunks(ids, (c) => scope(supabase.from("invoices").select(CLOSING_INVOICE_COLUMNS).in("quote_id", c)).limit(500)),
    inChunks(ids, (c) => scope(supabase.from("quotes").select("id, revises_quote_id, status").in("revises_quote_id", c)).limit(500)),
    inChunks(ids, (c) =>
      scope(supabase.from("sent_messages").select("doc_id, sent_at").eq("doc_kind", "quote").in("doc_id", c))
        .order("sent_at", { ascending: false })
        .limit(2000),
    ),
  ]);

  const group = <T,>(rows: Record<string, unknown>[], key: string): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = r[key] ? String(r[key]) : "";
      if (k) m.set(k, [...(m.get(k) ?? []), r as T]);
    }
    return m;
  };
  const jobInvoicesOf = group<SettledInvoice>(jobInvoiceRows, "job_id");
  const namingOf = group<SettledInvoice>(namingRows, "quote_id");
  const revisionsOf = group<{ status?: string | null }>(revisionRows, "revises_quote_id");
  const lastSentOf = new Map<string, string>();
  for (const r of sendRows) {
    const k = r.doc_id ? String(r.doc_id) : "";
    const at = typeof r.sent_at === "string" ? r.sent_at : "";
    if (!k || !Number.isFinite(ms(at))) continue;
    const had = lastSentOf.get(k);
    if (!had || ms(at) > ms(had)) lastSentOf.set(k, at);
  }

  const rows: ClosingRow[] = [];
  for (const q of list) {
    const id = String(q.id);
    const jobId = q.job_id ? String(q.job_id) : null;
    const job = one<{ status?: string | null }>(q.jobs);
    // An estimate written for a lead may carry no customer until it is won: the lead's name says who
    // (the Estimates list's own fallback), so a row never reads as nobody's (cn-v1172, builder's fix).
    const customer = one<{ name?: string | null; company_name?: string | null }>(q.customers) ?? one<{ name?: string | null; company_name?: string | null }>(q.inquiry);
    const created_at = (q.created_at as string | null) ?? null;
    const valid_until = (q.valid_until as string | null) ?? null;
    const status = (q.status as string | null) ?? null;
    const leadId = q.inquiry_id ? String(q.inquiry_id) : null;
    const settled = quoteSettled({
      quote: { id, status, created_at, revisions: revisionsOf.get(id) ?? [] },
      job: jobId && job ? { id: jobId, status: job.status ?? null } : null,
      jobInvoices: jobId ? (jobInvoicesOf.get(jobId) ?? []) : [],
      quoteInvoices: namingOf.get(id) ?? [],
      // Its lead's answer (cn-v1175): a lead marked Not Sold settles the estimate still out for it. No
      // sibling rule: an estimate Keep Both put back to sent, or one for extra work, stays on Closing.
      lead: leadId ? one<{ status?: string | null }>(q.inquiry) : null,
    }).settled;
    const state = closingState({ id, status, created_at, valid_until }, { settled, lastSentAt: lastSentOf.get(id) ?? null, todayStr: opts.todayStr });
    if (!state.closing) continue;
    rows.push({
      id,
      quote_number: (q.quote_number as string | null) ?? null,
      doc_type: (q.doc_type as string | null) ?? null,
      title: (q.title as string | null) ?? null,
      total: q.total == null ? null : Number(q.total),
      valid_until,
      created_at,
      job_id: jobId,
      customer_id: q.customer_id ? String(q.customer_id) : null,
      inquiry_id: q.inquiry_id ? String(q.inquiry_id) : null,
      customerName: customer?.name ?? null,
      customerCompany: customer?.company_name ?? null,
      state,
    });
  }
  return { rows: sortClosing(rows), cut, error: null, softErrors };
}

/**
 * THE SALES BADGE'S SHARE OF CLOSING: the estimates that need a person now. It throws when the list
 * could not be read (the layout turns that into no badge and reports it), never a made-up zero.
 */
export async function countClosingAttention(supabase: SupabaseClient, opts: { todayStr: string; orgId?: string | null }): Promise<number> {
  const res = await loadClosing(supabase, opts);
  if (res.error) throw res.error;
  return res.rows.filter((r) => r.state.needsAttention).length;
}
