/**
 * EXTRA USAGE, CREDITED FROM THE WEBHOOK (cn-v1140, migration 0401).
 *
 * Erik's design (2026-10-30): ONE meter called Usage. "Add Usage" buys ONE Stripe one-time product,
 * "Extra usage" ($15; the product's metadata usage_usd says what it adds, 10), and the purchase tops
 * up THIS month's usage window. The Checkout session that sells it (settings/billing-actions
 * buyExtraUsage) is made on OUR Stripe account in mode "payment" and carries EXACTLY
 *
 *   { kind: "extra_usage", org_id: <uuid>, month: "YYYY-MM", usage_usd: "<number string>" }
 *
 * and this module is the one road from that session to the one write (add_usage_topup, 0401):
 *
 *   parseTopupMetadata   the shape, pure — every bad shape is refused in words, no client needed;
 *   creditExtraUsage     the credit: a session that is not PAID answers {credited: false, why: "not
 *                        paid"} and nothing is written (Stripe sends completed(unpaid) for a delayed
 *                        method and the later checkout.session.async_payment_succeeded carries the
 *                        same session, paid — the webhook hands both here); a paid session with a bad
 *                        shape THROWS (money taken, nothing to give: the webhook files a blocker);
 *                        the rpc lands the top-up once per session (inserted: true), and a second
 *                        delivery of the same checkout answers inserted: false with nothing written;
 *                        a refused rpc or a read that failed throws with the rpc's own words so the
 *                        webhook can page and Stripe can retry;
 *   findTopupSession     the way back from a charge (charge.refunded) to the Checkout session that
 *                        sold it, asked of Stripe by the charge's PaymentIntent: null when the charge
 *                        was not a top-up.
 *
 * Order inside creditExtraUsage: PAID FIRST, then the shape. A session nobody has paid for yet is
 * not a blocker whatever its metadata says; the page comes the moment money is taken and cannot be
 * credited. The rpc re-checks the month, the amount and the company on the database (0401), so a
 * refusal in its words is the last line, never the first.
 *
 * THE CREDIT MONTH is the LATER of the month the session was sold for (metadata.month, stamped on
 * the company's calendar when Checkout opened) and the company's current month when the webhook
 * lands: a Checkout opened at 11 PM Pacific on Oct 31 and paid Nov 1 lands in November, where the
 * person can use it; one paid the same evening lands in October. The company's timezone comes from
 * the caller when it has it (`tz`), else from the company's row through the client; a read that
 * fails is filed and the sold month stands — never a guess at a zone. That is the one clock read
 * here. A tenant never sees a dollar (the ring reads the total through usage_topup_total), and
 * nothing is exported as a route or an action.
 */
import { reportError } from "@/lib/observe";
import { getOrgSettings } from "@/lib/org-settings";
import { monthKeyFor } from "@/lib/usage-window";

/** The service client's two doors this module uses. Structural, so a test hands in a fake; `from` is
 *  only reached when the caller hands no `tz`. */
type Sb = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
  from?: (table: string) => any;
};

export type CreditOpts = {
  /** The company's IANA timezone, when the caller already has it; else it is read from the company's row. */
  tz?: string | null;
  /** The webhook's "now" (tests); the clock otherwise. */
  now?: Date;
};

/** The Checkout session as this module reads it — Stripe.Checkout.Session fits, so does a test's literal. */
export type TopupSession = {
  id: string;
  payment_status?: string | null;
  metadata?: Record<string, string> | null;
};

export type TopupMetadata = { orgId: string; month: string; usageUsd: number };
export type ParsedTopup = { ok: true; value: TopupMetadata } | { ok: false; why: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** YYYY-MM with a real month — the same shape 0401's check constraint and add_usage_topup refuse otherwise. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The session's metadata, read as a top-up: ok with the typed values, or the one thing wrong with it, in words. */
export function parseTopupMetadata(meta: unknown): ParsedTopup {
  if (!meta || typeof meta !== "object") return { ok: false, why: "the session carries no metadata" };
  const m = meta as Record<string, unknown>;
  if (m.kind !== "extra_usage") return { ok: false, why: "the session's kind is not extra_usage" };
  if (typeof m.org_id !== "string" || !UUID_RE.test(m.org_id)) return { ok: false, why: "org_id is not a company id" };
  if (typeof m.month !== "string" || !MONTH_RE.test(m.month)) return { ok: false, why: "month is not YYYY-MM" };
  const raw = m.usage_usd;
  const usd = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(usd) || usd <= 0) return { ok: false, why: "usage_usd is not a positive number" };
  return { ok: true, value: { orgId: m.org_id, month: m.month, usageUsd: usd } };
}

/**
 * The month a paid top-up lands in: the LATER of the month it was sold for and the company's current
 * month (YYYY-MM compares as text). The timezone is `opts.tz` when given, else the company's own
 * (organizations.settings through the client); a failed read is filed and the sold month stands.
 */
export async function creditMonth(sb: Sb, orgId: string, soldMonth: string, opts: CreditOpts = {}): Promise<string> {
  let tz = opts.tz ?? null;
  if (!tz) {
    if (typeof sb.from !== "function") return soldMonth;
    try {
      const { data, error } = await sb.from("organizations").select("settings").eq("id", orgId).maybeSingle();
      if (error) throw error;
      tz = getOrgSettings((data as { settings?: unknown } | null)?.settings).timezone;
    } catch (e) {
      reportError("stripe-topup:timezone", e, { orgId, month: soldMonth });
      return soldMonth;
    }
  }
  const current = monthKeyFor(opts.now ?? new Date(), tz);
  return current > soldMonth ? current : soldMonth;
}

/**
 * Credit a paid "Extra usage" Checkout session to its company's month, once per session.
 *   { credited: false, why: "not paid" }    nothing taken yet; nothing written; the async event will come
 *   { credited: true, inserted: true }      the top-up landed
 *   { credited: true, inserted: false }     a replay: the session's top-up was already there
 * Throws — with the rpc's words when the rpc refused or the read failed — only once money was taken.
 * The month it lands in is creditMonth's (the later of the sold month and the company's current one).
 */
export async function creditExtraUsage(sb: Sb, session: TopupSession, opts: CreditOpts = {}): Promise<{ credited: boolean; inserted?: boolean; why?: string }> {
  if (session.payment_status !== "paid") return { credited: false, why: "not paid" };
  const parsed = parseTopupMetadata(session.metadata);
  if (!parsed.ok) throw new Error(`the paid session cannot be credited: ${parsed.why}`);
  const sessionId = typeof session.id === "string" ? session.id.trim() : "";
  if (!sessionId) throw new Error("the paid session cannot be credited: it has no id");
  const { orgId, month: soldMonth, usageUsd } = parsed.value;
  const month = await creditMonth(sb, orgId, soldMonth, opts);
  const { data, error } = await sb.rpc("add_usage_topup", { p_org: orgId, p_month: month, p_usd: usageUsd, p_session: sessionId });
  if (error) throw new Error(`add_usage_topup refused: ${error.message || "no words"}`);
  const inserted = (data as { inserted?: unknown } | null)?.inserted;
  if (typeof inserted !== "boolean") throw new Error("add_usage_topup answered nothing");
  return { credited: true, inserted };
}

/** The Stripe client's one door this module uses: the Checkout sessions list, filtered by PaymentIntent. */
type StripeSessions = {
  checkout: {
    sessions: {
      list: (params: { payment_intent: string; limit: number }) => PromiseLike<{ data: Array<TopupSession & { mode?: string | null }> }>;
    };
  };
};

/**
 * The "Extra usage" Checkout session a charge paid for, or null when the charge was not a top-up
 * (a subscription's charge, a session of another kind). A charge carries no mode and no session;
 * its PaymentIntent is the way back, and Stripe lists Checkout sessions by it.
 */
export async function findTopupSession(stripe: StripeSessions, paymentIntent: string): Promise<(TopupSession & { mode?: string | null }) | null> {
  if (!paymentIntent) return null;
  const { data } = await stripe.checkout.sessions.list({ payment_intent: paymentIntent, limit: 1 });
  const s = data[0];
  return s && s.mode === "payment" && s.metadata?.kind === "extra_usage" ? s : null;
}
