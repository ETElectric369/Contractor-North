/**
 * WON'T HAPPEN (W2-11): ONE WORD FOR "THIS VISIT ISN'T GOING AHEAD", AND THE APP DECIDES WHAT IT MEANS.
 *
 * The visit page used to offer both a bare ✗ (Cancel) and a Delete, and a person had to know which
 * one kept his notes. Erik cancelled a visit at 01:08 and made another at 01:10 because the ✗ said
 * "Cancel" and left the row on his screen; a Delete that looked like the same verb destroyed the
 * capture, cut an invoice's link to its visit (invoices.appointment_id is ON DELETE SET NULL), killed
 * the customer's pick-a-time link silently (schedule_proposals cascade) and lost the estimate the
 * inspection was written up into (capture.quote_id).
 *
 * So there is one door, and the rule behind it: the visit is DELETED only when there is nothing to
 * lose, all four at once —
 *   1. nothing captured: no notes, measurements, materials or photos, no items or measures, and no
 *      answer on the inspection sheet;
 *   2. no estimate was written from it (capture.quote_id);
 *   3. no invoice points at it;
 *   4. no pick-a-time link is waiting on the customer.
 * Anything else is CANCELLED: the record and everything on it stay on file, and Undo puts it back.
 * A fact that couldn't be read counts as "something is there" — never delete on a guess.
 *
 * The page asks the same four facts to word its confirm; the server asks them again at the write, so
 * a capture saved in between wins (and the delete itself only lands on the row as it was read).
 *
 * Pure: no database, no React. THE WORDS FOLLOW THE READER (the visit-page-in-Spanish wave): each
 * sentence keeps its English inline as the default — byte for byte what it always said — and takes
 * the caller's `lang` plus translator (`words`, lib/i18n translator(lang)) for the Spanish in
 * lib/words/visit-page (vp_), through lib/lang-words say. This file imports no catalog.
 */
import { captureQuoteId, hasCaptureData } from "@/lib/inspections";
import { parseInspectorCapture } from "@/lib/inspection/capture";
import { say, type Words } from "@/lib/lang-words";
import type { Lang } from "@/lib/locale";

/** The four facts. `null` for a count means it couldn't be read; `answersUnread` likewise. */
export type WontHappenFacts = {
  capture: unknown;
  answers: unknown;
  answersUnread?: boolean;
  invoiceCount: number | null;
  pendingLinks: number | null;
};

/** An answer that says something: not null, not blank, not an empty list. */
const said = (v: unknown) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);

/** True when the inspection sheet holds at least one real answer. */
export function hasAnswers(answers: unknown): boolean {
  if (!answers || typeof answers !== "object") return false;
  return Object.values(answers as Record<string, unknown>).some(said);
}

/** True when anything at all was captured on the visit: the prose, the photos, the items and
 *  measures (hasCaptureData predates those two), or an answer on the sheet. */
export function somethingCaptured(capture: unknown, answers: unknown): boolean {
  if (hasCaptureData(capture)) return true;
  const c = parseInspectorCapture(capture);
  if ((c.items?.length ?? 0) > 0 || (c.measures?.length ?? 0) > 0) return true;
  return hasAnswers(answers);
}

/** Delete, or cancel: the one rule, for the page's confirm and the server's write alike. */
export function wontHappenVerdict(f: WontHappenFacts): "delete" | "cancel" {
  if (f.answersUnread) return "cancel";
  if (f.invoiceCount === null || f.pendingLinks === null) return "cancel";
  if (somethingCaptured(f.capture, f.answers)) return "cancel";
  if (captureQuoteId(f.capture)) return "cancel";
  if (f.invoiceCount > 0) return "cancel";
  if (f.pendingLinks > 0) return "cancel";
  return "delete";
}

/** The confirm, saying which will happen before it does. */
export function wontHappenConfirm(verdict: "delete" | "cancel", lang: Lang | string | null = "en", words?: Words): string {
  return verdict === "delete"
    ? say(lang, words, "vp_wontHappenDeleteAsk", "This visit won't happen? Nothing was captured on it, so it will be deleted.")
    : say(lang, words, "vp_wontHappenCancelAsk", "This visit won't happen? Its notes, photos and answers stay on file, marked Cancelled.");
}

/** What the result toast says: the server's verdict, in plain words, with any withdrawn-link note
 *  (the server's own sentence, in the caller's language already, said as received). */
export function wontHappenToast(did: "deleted" | "cancelled", note?: string | null, lang: Lang | string | null = "en", words?: Words): string {
  if (did === "deleted") return say(lang, words, "vp_deletedNothingOnIt", "Deleted. Nothing was on it.");
  return `${say(lang, words, "vp_markedCancelledStays", "Marked Cancelled. Everything on it stays on file.")}${note ? ` ${note}` : ""}`;
}

/**
 * WHERE UNDO PUTS IT. Back to what it was, except a visit that was waiting on the customer's pick
 * (proposed): cancelling withdrew that link for good, so it comes back Scheduled, and the Undo says
 * the link stays withdrawn rather than pretending to restore it.
 */
export function wontHappenUndo(previousStatus: string | null | undefined, lang: Lang | string | null = "en", words?: Words): { status: string; note: string | null } {
  if (previousStatus === "proposed") {
    return { status: "scheduled", note: say(lang, words, "vp_pickLinkStaysWithdrawn", "The pick-a-time link stays withdrawn — send a new one.") };
  }
  return { status: previousStatus || "scheduled", note: null };
}

/** "Tue Oct 1": a calendar day the way a person says it, the same in every timezone. A Spanish reader's
 *  "mar 1 oct" (Intl es-US, the agenda's spelling). */
export function visitDayWords(ymd: string, lang: Lang | string | null = "en"): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
    .format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)))
    .replace(",", "");
}

/**
 * PUT IT BACK ON THE SCHEDULE: a cancelled visit comes back Scheduled. A day still ahead (today
 * counts) keeps its day; a day that has passed, or none, comes back waiting for a day (0368), on the
 * rail instead of sitting on a past day nobody will look at.
 */
export function putBackPlan(
  startDay: string | null,
  todayStr: string,
  lang: Lang | string | null = "en",
  words?: Words,
): { keepDay: true; message: string } | { keepDay: false; message: string } {
  if (startDay && startDay >= todayStr) {
    const day = visitDayWords(startDay, lang);
    return { keepDay: true, message: say(lang, words, "vp_backOnScheduleFor", `Back on the schedule for ${day}.`, { day }) };
  }
  if (startDay) {
    const day = visitDayWords(startDay, lang);
    return { keepDay: false, message: say(lang, words, "vp_backWaitingDayPassed", `Back on the schedule, waiting for a day: ${day} had passed.`, { day }) };
  }
  return { keepDay: false, message: say(lang, words, "vp_backWaitingForADay", "Back on the schedule, waiting for a day.") };
}
