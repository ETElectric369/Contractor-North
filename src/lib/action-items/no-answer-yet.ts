import { closingState } from "@/lib/estimate/closing";
import { formatCurrency } from "@/lib/utils";
import { dueClock } from "./needs-you-rule";
import { AFFORDANCES, type ActionItem } from "./types";

/**
 * NO ANSWER YET IS THE CLOSING LIST'S "NEEDS A PERSON NOW" (cn-v1172).
 *
 * Erik, 2026-11-19, asked whether the new Closing list replaces the follow-up day on an estimate:
 * "Closing is the reminder yes". So an estimate has no follow-up day any more, and Needs You's No
 * Answer Yet rows are exactly the estimates the Closing page marks as needing a person and the Sales
 * dot counts: one rule (lib/estimate/closing closingState), asked here once per estimate the feeder
 * read. Nothing waits in the fold with a day (there is no day to wait for), and there is no Still
 * Waiting: the list is the reminder.
 *
 * `settled` is quoteSettled's answer (Needs You's settledOf), `lastSentAt` the newest logged send
 * (sent_messages, null when none or when that read failed: then the wait is measured from the day it
 * was written, as before). Pure, so the agreement with the page is tested on one table.
 */
export type NoAnswerQuote = {
  id: string;
  quote_number?: string | null;
  doc_type?: string | null;
  status?: string | null;
  total?: number | string | null;
  valid_until?: string | null;
  created_at?: string | null;
  customerName?: string | null;
};

export function noAnswerYetItem(
  q: NoAnswerQuote,
  ctx: { settled: boolean; lastSentAt: string | null; todayStr: string; tz?: string },
): Omit<ActionItem, "group"> | null {
  const state = closingState(q, { settled: ctx.settled, lastSentAt: ctx.lastSentAt, todayStr: ctx.todayStr });
  if (!state.closing || !state.needsAttention) return null;
  const who = q.customerName ?? null;
  const doc = (q.doc_type ?? "quote") === "estimate" ? "Estimate" : "Quote";
  const total = Number(q.total ?? 0);
  return {
    id: q.id,
    kind: "quote_awaiting",
    title: `${doc} ${q.quote_number ?? ""} awaiting reply`.replace(/\s+/g, " ").trim(),
    subtitle: who ?? formatCurrency(total),
    // The customer in bold; why it is here as a key, from the rule's own reason: the offer ended or
    // ends (its day a slot), else no answer since it was sent.
    who: who || null,
    what: {
      key: state.why === "offer_ended" ? "ny_w_docOfferEnded" : state.why === "offer_ends" ? "ny_w_docOfferEnds" : "ny_w_docNoAnswer",
      vars: {
        docKey: doc === "Estimate" ? "ny_docEstimate" : "ny_docQuote",
        ref: q.quote_number ?? null,
        ...(state.why === "offer_ended" || state.why === "offer_ends" ? { day: q.valid_until ?? null } : {}),
      },
    },
    // The offer's last day is a real deadline, so it is the row's `when` (said "3d overdue" once past).
    // With no offer day there is NO `when` (cn-v1172 fixer): the day it was written is not a deadline,
    // and as a `when` this kind says it as one ("17d overdue"). The age is said from `since` the
    // plain way ("17d ago"), and the order reads `since` first, so it still sorts by age.
    when: q.valid_until ?? null,
    since: state.sinceAt,
    // ITS CLOCK (cn-v1162): the offer's last day. Quiet a week is why it is listed, never a clock.
    clock: dueClock("quote_awaiting", [q.valid_until], { todayStr: ctx.todayStr, tz: ctx.tz }),
    // Past its valid-until the offer is dying: above the routine chase.
    urgency: state.offer === "ended" ? 2 : 1,
    done: false,
    href: `/quotes/${q.id}`,
    affordances: AFFORDANCES.quote_awaiting,
    amount: total,
    // "Sent Jun 12" only for a send the app logged; an estimate marked Sent by hand has no send day to
    // name, so its age is said the plain way (closing.ts: a screen never calls that day a send).
    dated: state.sentLogged ? "Sent" : null,
    // Send Again, the Closing page's own third door: the Send sheet, which logs the send.
    send: {
      kind: "quote",
      id: q.id,
      number: q.quote_number ?? null,
      customerName: who,
      amount: total,
      lineCount: null,
      openHref: `/quotes/${q.id}`,
    },
  };
}
