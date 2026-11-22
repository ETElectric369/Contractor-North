/**
 * MONEY ASKED FOR AHEAD OF THE WORK (cn-v1177): a deposit, a materials payment, any payment requested
 * before the bill it belongs on exists.
 *
 * Erik, 2026-11-21: "i think we do need to think about setting up a deposit schedule ability if desired
 * and to be able to have them pay the deposit with their card from the link"; and "im curious if we can
 * go into the job and request a materials payment via a link in the get paid box (like a quick payment
 * link that applies immediately to that job regardless of invoice status)".
 *
 * THE RECORD. A payment request is a small bill of its own kind (invoices.invoice_kind = "prepayment")
 * with ONE line (import_source "prepayment") and no tax. Because it is a bill, everything a bill already
 * has works on it with nothing new: its own number, its pay link, the card and Tap to Pay doors, the
 * review-before-send sheet, the portal, the refund door, every report that reads invoices. Because its
 * kind is its own, it is NOT a draw: it never locks a job out of a standard invoice (DRAW_KINDS does
 * not hold it), and a paid one never finishes a job (only a standard invoice does).
 *
 * HOW IT COMES OFF. The next bill made on the same job takes it off with one line per request
 * (import_source "prepaid_credit", invoice_items.prepaid_invoice_id naming the request), capped at that
 * bill's own lines; whatever does not fit carries to the bill after. The line takes off what was ASKED,
 * paid or not, the way a draw's "Less previous billings" line always has: an unpaid request stays its
 * own open bill, so the two together always add up to the work and nothing is asked for twice. The
 * credit is re-resolved while its bill is a draft and stands as written once that bill is sent.
 *
 * TWO POOLS, NEVER MIXED. Draw money (a deposit draw, a milestone, a fixed draw) is netted by
 * "draw_credit" lines, as before (lib/unbilled-work fixedBillingsToNet). Payment requests are netted by
 * "prepaid_credit" lines, here. Each pool counts only its own bills and its own credit lines.
 *
 * Pure: no catalog, no database, no clock. The reads live in lib/payment-request.
 */

export const PREPAYMENT_KIND = "prepayment";
/** import_source of a request's own line. */
export const PREPAYMENT_LINE = "prepayment";
/** import_source of the line that takes a request off a later bill. */
export const PREPAID_CREDIT = "prepaid_credit";
/** import_source of a draw's "Less previous billings" line (0063 and after). */
export const DRAW_CREDIT = "draw_credit";

export type PrepaymentPurpose = "deposit" | "materials" | "other";

const fin = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};
const cents = (n: number): number => Math.round(n * 100) / 100;

export function isPrepaymentKind(kind: string | null | undefined): boolean {
  return kind === PREPAYMENT_KIND;
}

/**
 * IS THIS LINE A CREDIT THAT TAKES EARLIER MONEY OFF A BILL: a draw's or a payment request's. Every
 * reader that used to compare a line to "draw_credit" asks this instead, so a credit line is never
 * counted as work billed, never as lump money, and is never edited by hand.
 */
export function isCreditSource(src: string | null | undefined): boolean {
  return src === DRAW_CREDIT || src === PREPAID_CREDIT;
}

/**
 * IS THIS LINE MONEY AHEAD, AND NOT WORK: a request's own line, or the line that takes a request off a
 * later bill. Neither came from an importer and neither bills an hour or a receipt, so there is no claim
 * it could have failed to record. The un-void guards ask this (the app's unvoidConflict, and
 * guard_invoice_unvoid as migration 0415 leaves it): both read "a line with an import source and no
 * recorded claim" as a line built before claims existed, which closes the way back from void beside any
 * other live bill, and on a job with a request there is always another live bill. A draw's
 * "Less previous billings" line is NOT here, on purpose: nothing re-resolves it, and the older rule
 * still decides it. Each of these two is held by 0414's own boundary.
 */
export function isMoneyAheadLine(src: string | null | undefined): boolean {
  return src === PREPAYMENT_LINE || src === PREPAID_CREDIT;
}

const BUILT_IN_LABEL: Record<Exclude<PrepaymentPurpose, "other">, string> = {
  deposit: "Deposit",
  materials: "Materials Payment",
};

/** The request's name, in English: it is printed on the customer's bill. A typed name is kept as typed. */
export function prepaymentLabel(purpose: PrepaymentPurpose, typed?: string | null): string {
  if (purpose === "deposit" || purpose === "materials") return BUILT_IN_LABEL[purpose];
  const t = (typed ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return t || "Payment";
}

/**
 * The words of the line that takes a request off a later bill, in English (customer-bound):
 * "Less deposit (INV-900)". It says what the money was and which bill holds it, and it does not say
 * "received", because an unpaid request comes off too and stays owed on its own bill.
 */
export function prepaidCreditDescription(label: string | null | undefined, invoiceNumber: string | null | undefined): string {
  const raw = (label ?? "").replace(/\s+/g, " ").trim();
  const builtIn = Object.values(BUILT_IN_LABEL).includes(raw);
  const what = raw ? (builtIn ? raw.toLowerCase() : raw) : "payment";
  const num = (invoiceNumber ?? "").trim();
  return num ? `Less ${what} (${num})` : `Less ${what}`;
}

/** One payment request, as its row and its lines say. */
export type PrepaymentBillRow = {
  id: string;
  invoice_number: string | null;
  status: string | null;
  title: string | null;
  created_at: string | null;
  /** The sum of the request's own lines: what it asks for. */
  amount: number;
  amount_paid: number;
  /** Refunds recorded against it (customer_credits, disposition "refund"), as a positive sum. */
  refunded: number;
};

/** One "prepaid_credit" line, with the status of the bill it sits on. */
export type PrepaidCreditRow = {
  invoice_id: string;
  invoice_status: string | null;
  prepaid_invoice_id: string | null;
  /** The line's stored total (negative) or its size: only the size is read. */
  amount: number;
};

export type PrepaymentState = {
  id: string;
  number: string | null;
  label: string;
  status: string;
  /** What it asks for. */
  amount: number;
  paid: number;
  refunded: number;
  /** The bills that already took some of it off, and how much each. */
  taken: { invoiceId: string; amount: number }[];
  takenTotal: number;
  /** What a later bill still takes off: asked, less refunded, less already taken. Never below 0. */
  left: number;
  /** Money in hand that no bill has used: paid, less refunded, less already taken. Never below 0. */
  moneyLeft: number;
};

const LIVE = (status: string | null | undefined): boolean => {
  const s = String(status ?? "");
  return s !== "void" && s !== "draft";
};

/**
 * WHERE EVERY REQUEST ON ONE JOB STANDS. `bills` are the job's payment requests; `credits` are every
 * "prepaid_credit" line on the job's bills. A void or draft request asks for nothing. A credit line on
 * a void bill took nothing; a credit line on a DRAFT bill counts (two open drafts must not both take
 * the same request), except on `exceptInvoiceId`, the bill being resolved right now. Oldest request first.
 */
export function prepaymentStates(
  bills: readonly PrepaymentBillRow[],
  credits: readonly PrepaidCreditRow[],
  exceptInvoiceId?: string | null,
): PrepaymentState[] {
  const taken = new Map<string, Map<string, number>>();
  for (const c of credits ?? []) {
    if (!c || !c.prepaid_invoice_id) continue;
    if (String(c.invoice_status ?? "") === "void") continue;
    if (exceptInvoiceId && c.invoice_id === exceptInvoiceId) continue;
    const size = Math.abs(fin(c.amount));
    if (size <= 0.005) continue;
    const byBill = taken.get(c.prepaid_invoice_id) ?? new Map<string, number>();
    byBill.set(c.invoice_id, cents((byBill.get(c.invoice_id) ?? 0) + size));
    taken.set(c.prepaid_invoice_id, byBill);
  }
  const when = (iso: string | null): number => {
    const t = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return (bills ?? [])
    .filter((b) => b && LIVE(b.status))
    .slice()
    .sort((a, b) => {
      const ta = when(a.created_at);
      const tb = when(b.created_at);
      if (ta !== tb) return ta < tb ? -1 : 1;
      return String(a.invoice_number ?? a.id).localeCompare(String(b.invoice_number ?? b.id));
    })
    .map((b) => {
      const amount = cents(Math.max(0, fin(b.amount)));
      const paid = cents(Math.max(0, fin(b.amount_paid)));
      const refunded = cents(Math.max(0, fin(b.refunded)));
      const rows = [...(taken.get(b.id) ?? new Map<string, number>()).entries()].map(([invoiceId, amt]) => ({ invoiceId, amount: amt }));
      const takenTotal = cents(rows.reduce((s, r) => s + r.amount, 0));
      return {
        id: b.id,
        number: b.invoice_number ?? null,
        label: (b.title ?? "").trim() || "Payment",
        status: String(b.status ?? ""),
        amount,
        paid,
        refunded,
        taken: rows,
        takenTotal,
        left: cents(Math.max(0, amount - refunded - takenTotal)),
        moneyLeft: cents(Math.max(0, paid - refunded - takenTotal)),
      };
    });
}

/** What the job's requests still have to come off a bill, all together. */
export function prepaymentsLeft(states: readonly PrepaymentState[]): number {
  return cents((states ?? []).reduce((s, x) => s + x.left, 0));
}

/**
 * WHAT ONE BILL TAKES OFF. `base` is the sum of the bill's lines other than its "prepaid_credit" lines
 * (a draw's own "Less previous billings" line is inside it, as a negative). The oldest request first,
 * each for as much as still fits; a bill with nothing on it takes nothing. The credit never exceeds
 * the base, so a bill's lines never sum below zero.
 */
export function allocatePrepaidCredit(
  states: readonly PrepaymentState[],
  base: number,
): { prepaidInvoiceId: string; number: string | null; label: string; amount: number }[] {
  let room = cents(Math.max(0, fin(base)));
  const out: { prepaidInvoiceId: string; number: string | null; label: string; amount: number }[] = [];
  for (const s of states ?? []) {
    if (room <= 0.005) break;
    const amount = cents(Math.min(s.left, room));
    if (amount <= 0.005) continue;
    out.push({ prepaidInvoiceId: s.id, number: s.number, label: s.label, amount });
    room = cents(room - amount);
  }
  return out;
}
