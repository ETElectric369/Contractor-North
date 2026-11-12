import { fillSlots, type Words } from "@/lib/lang-words";
import { appointmentTypeLabel } from "@/lib/statuses";
import { formatCurrency } from "@/lib/utils";
import { DATED_EN, datedWhen, dayWords, relativeWhen } from "./dated-when";
import { pileTitle } from "./piles";
import { WHEN_IS_A_DEADLINE, type ActionItem, type PileInfo, type PileName, type Say } from "./types";

/**
 * WHAT A NEEDS YOU ROW SAYS (the redraw, cn-v1161). The box draws three things per row: WHO it is
 * about (bold), WHAT is open (plain), and one thing at the right edge (the money, else its age).
 * The server never writes a sentence: a feeder hands over a key and its slots (`Say`), and this
 * file says them in the reader's language. Pure, and it imports no catalog: English is inline (NY_EN,
 * the one table, pinned key by key to lib/words/needs-you by row-words.test), and a Spanish reader's
 * caller hands in its translator, the way lib/lang-words say() works.
 *
 * HYDRATION LAW: the company's today and timezone come in through the context; nothing here reads
 * the runtime's clock or locale, so the server's render and the browser's are the same text.
 */
export type RowWordsCtx = {
  /** "es" reads `words`; anything else is English. */
  lang?: string | null;
  /** The caller's translator, lib/i18n translator(lang). */
  words?: Words;
  /** False: never an amount, whatever the row carries. */
  isStaff: boolean;
  /** The company's today (YYYY-MM-DD) and timezone: the server's, never the runtime's. */
  todayStr: string;
  tz: string;
};

export type RowWords = {
  /** Bold, first: the row's `who`, else its `whoSay` said, else its title. */
  who: string;
  /** Plain, under it: the row's `what` said (with its tail; with the age when the money holds the
   *  right edge and the phrase names no day of its own), else its subtitle, else "". */
  what: string;
  /** The right edge: the amount as currency (staff, above zero), else the age or due words. */
  right: string | null;
  rightKind: "money" | "age" | null;
};

/** What saying a key needs: the language and its translator, and the company's today and zone for a {day}. */
export type SayCtx = Pick<RowWordsCtx, "lang" | "words" | "todayStr" | "tz">;

/**
 * THE ENGLISH OF EVERY ny_ KEY THE PURE LIBRARIES SAY (row-words, row-buttons, dated-when): the
 * default, byte for byte what the box said before it had a catalog. The screens' own words (the
 * header counts, the tiles, the form) are read by the components through t() and are not here.
 * row-words.test pins each value to dict("en"), so this table and the catalog cannot drift.
 */
export const NY_EN: Readonly<Record<string, string>> = {
  ...DATED_EN,
  ny_who_someone: "Someone",
  ny_who_hoursNoJob: "Hours on No Job · {n}",
  ny_who_supplierBills: "Supplier Bills · {n}",
  ny_who_bankDownload: "Bank Download",
  ny_who_receipt: "Receipt",
  ny_who_note: "Note",
  ny_who_document: "Document",
  ny_who_paper: "Paper",
  ny_who_unread: "{label} · Couldn't Check",
  ny_who_hoursNotAllListed: "Hours on No Job · Couldn't List Them All",
  ny_lbl_holds: "Holds",
  ny_lbl_receipts: "Receipts",
  ny_lbl_supplierBills: "Supplier Bills",
  ny_lbl_hoursNoJob: "Hours on No Job",
  ny_w_invoice: "Invoice {ref}",
  ny_w_invoiceNotSent: "Invoice {ref} · not sent",
  ny_w_invoiceBackFromSetAside: "Invoice {ref} · not sent · set aside until {day}",
  ny_w_jobFinishedSend: "Job finished · send {ref}",
  ny_w_jobCancelledSend: "Job cancelled · send {ref}",
  ny_w_visitNotBilled: "{text} · done, not billed",
  ny_w_workNotBilled: "Work done, not billed",
  ny_w_visitBilledNotPaid: "{text} · billed, not paid",
  ny_w_workBilledNotPaid: "Billed, not paid",
  ny_w_jobNotBilled: "Finished, not billed",
  ny_w_noCostsYet: "Worked, no costs on it yet",
  ny_w_lienPrelim: "Preliminary notice due",
  ny_w_lienPrelimPast: "Preliminary notice past due",
  ny_w_lienRecord: "Lien to record",
  ny_w_lienRecordPast: "Lien recording past due",
  ny_w_leadNew: "New lead · call them",
  ny_w_leadFollowUp: "Lead · follow up",
  ny_w_requestNew: "New request · call them back",
  ny_w_requestFollowUp: "Request · follow up",
  ny_w_toWriteUp: "{type} · to write up",
  ny_w_toWriteUpTitled: "{text} · {type} · to write up",
  ny_docEstimate: "Estimate",
  ny_docQuote: "Quote",
  ny_w_docNotSent: "{doc} {ref} · not sent",
  ny_w_docNoAnswer: "{doc} {ref} · no answer yet",
  ny_w_docFollowUp: "{doc} {ref} · follow up today",
  ny_w_docOfferEnds: "{doc} {ref} · offer ends {day}",
  ny_w_docOfferEnded: "{doc} {ref} · offer ended {day}",
  ny_w_contractNotSigned: "Contract {ref} · not signed",
  ny_w_saidYes: "Said yes to {ref} · needs a day",
  ny_w_saidYesNoRef: "Said yes · needs a day",
  ny_w_neverHadADay: "Never had a day",
  ny_w_datedNeverWorked: "Dated {day}, never worked",
  ny_w_lastDay: "Last day {day}",
  ny_w_workedNothingNext: "Worked {day}, nothing next",
  ny_w_quietSince: "Quiet since {day}",
  ny_w_nToBuy: "{n} to buy",
  ny_w_holdBack: "Hold is back · {text}",
  ny_w_holdNoDay: "On hold, no day set · {text}",
  ny_w_noReason: "no reason saved",
  ny_w_visitNotClosed: "{type} · not closed out",
  ny_w_visitNotClosedTitled: "{text} · {type} · not closed out",
  ny_w_toBuy: "{n} to buy · {text}",
  ny_w_plusMore: "+{n} more",
  ny_w_permitToBook: "{name} inspection to book",
  ny_w_permitNotWrittenUp: "{name} was booked {day} · say how it went",
  ny_w_permitFailed: "{name} failed {day} · book another visit",
  ny_w_permitCancelled: "{name} cancelled {day} · book another visit",
  ny_w_permitFailedNoDay: "{name} failed · book another visit",
  ny_w_permitCancelledNoDay: "{name} cancelled · book another visit",
  ny_w_clockRunning: "Clock left running",
  ny_w_shiftNoJob: "Closed shift on no job",
  ny_w_hoursSpan: "{hours} h, {day} to {day2}",
  ny_w_hoursOn: "{hours} h on {day}",
  ny_w_receiptFrom: "Receipt from {name} · not recorded yet",
  ny_w_receipt: "Receipt · not recorded yet",
  ny_w_billFrom: "Bill from {name} · not recorded yet",
  ny_w_bill: "Bill · not recorded yet",
  ny_w_fromSupplier: "From {name}, not in your books yet",
  ny_w_fromSuppliers: "From your suppliers, not in your books yet",
  ny_w_payBySavesOne: "Pay by {day} · saves {money} on 1 invoice",
  ny_w_payBySavesMany: "Pay by {day} · saves {money} on {n} invoices",
  ny_w_alreadySent: "{money2} already sent",
  ny_w_takenPastStock: "{name} took {text} past stock",
  ny_w_takenPastStockNoName: "{text} taken past stock",
  ny_w_paperToSort: "Paper to sort",
  ny_w_noteToReview: "Note to review",
  ny_w_toFile: "To file in Organize",
  ny_w_bankToSort: "To sort on Reconcile",
  ny_w_unreadJobsDay: "Couldn't read which jobs have nothing ahead of them just now. Open Schedule to see them.",
  ny_w_unreadHolds: "Couldn't read the jobs on hold just now, so one whose day has come may be missing here. Open Jobs to see them.",
  ny_w_unreadReceipts: "Couldn't tell which receipts on your jobs are on a bill just now. Open Bills to see them.",
  ny_w_unreadDone: "Couldn't read which finished work has no bill just now. Open Invoices to see finished jobs.",
  ny_w_unreadPermits: "Couldn't read which permits are still waiting on an inspection just now. Open a job's Permits tab to see them.",
  ny_w_unreadSupplierPapers: "Couldn't read your supplier papers just now, so any bill or discount waiting on you isn't here. Open Bills to see them.",
  ny_w_unreadSupplierPay: "Couldn't check what's due to your suppliers just now, so a discount deadline may be missing here. Open Bills to see it.",
  ny_w_unreadHours: "Couldn't read the shifts that are on no job just now. Open Timecards to see them.",
  ny_w_hoursNotAllListed: "The newest {n} shifts on no job are all billed, empty or today's, so older ones weren't checked.",
  ny_btn_seeAllOnEstimates: "See All on Estimates",
  ny_btn_seeAllOnInvoices: "See All on Invoices",
  ny_btn_seeAllOnLeads: "See All on Leads",
  ny_btn_seeAllInspections: "See All Inspections",
  ny_btn_seeAllOnSchedule: "See All on Schedule",
  ny_btn_seeAllOnJobs: "See All on Jobs",
  ny_btn_seeAllOnBills: "See All on Bills",
  ny_btn_seeAllInOrganize: "See All in Organize",
  ny_btn_seeAllOnShopStock: "See All on Shop Stock",
  ny_btn_seeAllMaterials: "See All Materials",
  ny_btn_pile_estimatesNotSent: "Estimates Not Sent",
  ny_btn_pile_noAnswerYet: "No Answer Yet",
  ny_btn_pile_wonNeedsADay: "Won, Needs a Day",
  ny_btn_pile_lateInvoices: "Late Invoices",
  ny_btn_pile_invoicesNotSent: "Invoices Not Sent",
  ny_btn_pile_doneNotBilled: "Done, Not Billed",
  ny_btn_pile_leadsToCall: "Leads to Call",
  ny_btn_pile_requestsToCallBack: "Requests to Call Back",
  ny_btn_pile_visitsToCloseOut: "Visits to Close Out",
  ny_btn_pile_inspectionsToWriteUp: "Inspections to Write Up",
  ny_btn_pile_jobsNeedingADay: "Jobs Needing a Day",
  ny_btn_pile_holdsBack: "Holds Back",
  ny_btn_pile_papersToSort: "Papers to Sort",
  ny_btn_pile_notesToReview: "Notes to Review",
  ny_btn_pile_toFileInOrganize: "To File in Organize",
  ny_btn_pile_receiptsNotOnABill: "Receipts Not on a Bill",
  ny_btn_pile_stockToSettle: "Stock to Settle",
  ny_btn_pile_materialsToBuy: "Materials to Buy",
  ny_btn_pile_contractsNotSigned: "Contracts Not Signed",
  ny_btn_pile_lienDeadlines: "Lien Deadlines",
  ny_btn_pile_permitInspections: "Permit Inspections",
  ny_btn_payName: "Pay {name}",
  ny_btn_paySupplier: "Pay Supplier",
  ny_btn_fixTheClock: "Fix the Clock",
  ny_btn_putOnAJob: "Put on a Job",
  ny_btn_getPaid: "Get Paid",
  ny_btn_billIt: "Bill It",
  ny_btn_sendEstimate: "Send It",
  ny_btn_sendInvoice: "Send It",
  ny_btn_stillWaiting: "Still Waiting",
  ny_btn_pickADay: "Pick a Day",
  ny_btn_call: "Call",
  ny_btn_callBack: "Call Back",
  ny_btn_called: "Called",
  ny_btn_closeOut: "Close Out",
  ny_btn_buyMaterialsOpen: "Buy Materials · {n} Open",
  ny_btn_buyMaterialsOpenOne: "Buy Materials · {n} Open",
  ny_btn_buyMaterials: "Buy Materials",
  ny_btn_addCosts: "Add Costs",
  ny_btn_snooze: "Snooze",
  ny_btn_takeOffHold: "Take Off Hold",
  ny_btn_recordIt: "Record It",
  ny_btn_bookIt: "Book It",
  ny_btn_recordInspectionStatus: "Record Inspection Status",
  ny_btn_bookAnotherVisit: "Book Another Visit",
  ny_btn_seeThePermit: "See the Permit",
  ny_btn_fileIt: "File It",
  ny_btn_sortIt: "Sort It",
  ny_btn_settleIt: "Settle It",
  ny_btn_seeDeadline: "See Deadline",
  ny_btn_seeContract: "See Contract",
  ny_btn_openThem: "Open Them",
  ny_btn_seeThem: "See Them",
  ny_btn_alreadyInvoiced: "Already Invoiced",
  ny_btn_cancel: "Cancel",
  ny_btn_notNeeded: "Not Needed",
  ny_btn_wonIt: "Won It",
  ny_btn_lost: "Lost",
  ny_btn_lostVisit: "Lost",
  ny_btn_assign: "Assign",
  ny_btn_finish: "Finish",
  ny_btn_didntHappen: "Didn't Happen",
  ny_btn_setAsideUntil: "Set Aside Until…",
  ny_btn_setAside: "Set Aside",
  ny_btn_notACost: "Not a Cost",
  ny_btn_signedOnPaper: "Signed on Paper",
  // Another catalog's key a row's door reuses (never re-added under ny_): the visit's own door.
  ld_btn_openTheInspection: "Open the Inspection",
};

const spanish = (c: Pick<SayCtx, "lang" | "words">): c is { lang: "es"; words: Words } => c.lang === "es" && !!c.words;

/**
 * A key's words with no slot said: the catalog's for a Spanish reader whose caller handed its
 * translator; else the inline English; a key that is not in the table (another catalog's, named by a
 * feeder) reads through the translator when there is one, and never comes back as nothing.
 */
function template(key: string, c: Pick<SayCtx, "lang" | "words">): string {
  if (spanish(c)) return c.words(key);
  return NY_EN[key] ?? (c.words ? c.words(key) : key);
}

/** One ny_ key (or a reused one) in the reader's language, its {slots} filled as they are: no day,
 *  money or type is said here (sayIt does that for a feeder's Say). */
export function nyWord(key: string, c: Pick<SayCtx, "lang" | "words">, vars?: Record<string, string | number>): string {
  return fillSlots(template(key, c), vars);
}

/** The slots a day is said in, and the ones money is (types.ts Say). */
const DAY_SLOTS = new Set(["day", "day2"]);
const MONEY_SLOTS = new Set(["money", "money2"]);

/**
 * A FEEDER'S Say, SAID (types.ts Say): its key in the reader's language, each slot by its name's
 * convention. `day` / `day2` are days ("Jun 12"; "12 jun"), `money` / `money2` currency, `type` the
 * visit type's label (lib/statuses appointmentTypeLabel), and a slot ending in `Key` is another key,
 * said and filled under the name without it (`docKey: "ny_docEstimate"` fills {doc}). One is not a
 * slot but a SECOND PHRASE: `andKey` is said with the same slots (its {n} read from `andN` when the
 * feeder gave one) and drawn after the first, " · " between ("3 to buy · +2 more", "Pay by Dec 10 ·
 * saves $35.50 on 1 invoice · $200.00 already sent"). A null slot is an empty one. The tail is data,
 * drawn after " · " as it came. Never a raw key, never a "{slot}" left open when the feeder named it.
 */
export function sayIt(s: Say, c: SayCtx): string {
  const lang = spanish(c) ? "es" : "en";
  const vars: Record<string, string> = {};
  let and: string | null = null;
  for (const [name, raw] of Object.entries(s.vars ?? {})) {
    if (raw === null || raw === undefined) {
      vars[name] = "";
      continue;
    }
    if (name === "andKey") {
      and = String(raw);
    } else if (name.endsWith("Key") && name.length > 3) {
      const w = nyWord(String(raw), c);
      vars[name.slice(0, -3)] = w;
      vars[name] = w;
    } else if (DAY_SLOTS.has(name)) {
      vars[name] = dayWords(String(raw), c.todayStr, c.tz, lang) ?? String(raw);
    } else if (MONEY_SLOTS.has(name)) {
      vars[name] = formatCurrency(Number(raw), lang);
    } else if (name === "type") {
      vars[name] = appointmentTypeLabel(String(raw), lang, c.words);
    } else {
      vars[name] = String(raw);
    }
  }
  let said = fillSlots(template(s.key, c), vars);
  if (and) {
    const second = fillSlots(template(and, c), "andN" in vars ? { ...vars, n: vars.andN } : vars);
    if (second.trim()) said = `${said} · ${second}`;
  }
  const tail = String(s.tail ?? "").trim();
  return tail ? `${said} · ${tail}` : said;
}

const isUnread = (item: Pick<ActionItem, "id">) => item.id.endsWith("-unread");

/** The row's own day said as its age: the dated word ("Sent Jun 12") read from `since` first (the
 *  sent day; `when` is the follow-up day, defect D1), else the relative age of `when`, else of `since`
 *  (a day a thing happened, never a deadline). Null when the row has no day. */
export function ageWords(item: Pick<ActionItem, "kind" | "id" | "when" | "since" | "dated">, c: SayCtx): string | null {
  if (isUnread(item)) return null;
  const o = { lang: c.lang, words: c.words };
  if (item.dated) return datedWhen(item.dated, item.since ?? item.when, c.todayStr, c.tz, o);
  if (item.when) return relativeWhen(item.when, c.todayStr, c.tz, WHEN_IS_A_DEADLINE[item.kind], o);
  if (item.since) return relativeWhen(item.since, c.todayStr, c.tz, false, o);
  return null;
}

export function rowWords(item: ActionItem, ctx: RowWordsCtx): RowWords {
  // A pile: its own line ("Estimates Not Sent · 6") and the children's sum. Its old "$X across N"
  // subtitle is not said: the sum stands at the right edge.
  if (item.pile) {
    const money = ctx.isStaff && typeof item.amount === "number" && item.amount > 0 ? formatCurrency(item.amount, spanish(ctx) ? "es" : "en") : null;
    return { who: pileTitleWords(item.pile, ctx), what: "", right: money, rightKind: money ? "money" : null };
  }

  const ownWho = String(item.who ?? "").trim();
  const who = ownWho || (item.whoSay ? sayIt(item.whoSay, ctx) : item.title);

  const money = ctx.isStaff && typeof item.amount === "number" && Number.isFinite(item.amount) && item.amount > 0 ? formatCurrency(item.amount, spanish(ctx) ? "es" : "en") : null;
  const age = ageWords(item, ctx);

  let what = item.what ? sayIt(item.what, ctx) : String(item.subtitle ?? "");
  // The money holds the right edge, so the age rides the WHAT line, unless the phrase names its own day.
  const namesADay = !!item.what && /\{day2?\}/.test(template(item.what.key, ctx));
  if (money && age && !namesADay) what = what ? `${what} · ${age}` : age;

  if (money) return { who, what, right: money, rightKind: "money" };
  return { who, what, right: age, rightKind: age ? "age" : null };
}

/** The pile names as their key's suffix: estimates_not_sent → estimatesNotSent. */
const camel = (name: string) => name.replace(/_([a-z])/g, (_m, x: string) => x.toUpperCase());

/** Every pile label's key by its English, so the Leads-off and the mixed-papers names (Requests to
 *  Call Back, To File in Organize) are said by the words piles.ts chose, not only by the pile's name. */
const PILE_KEY_BY_LABEL: ReadonlyMap<string, string> = new Map(
  Object.entries(NY_EN)
    .filter(([k]) => k.startsWith("ny_btn_pile_"))
    .map(([k, v]) => [v, k]),
);

/** The key a pile's label is said by: its English label's, else its name's. */
export function pileLabelKey(pile: Pick<PileInfo, "name" | "label">): string {
  return PILE_KEY_BY_LABEL.get(pile.label) ?? `ny_btn_pile_${camel(pile.name as PileName)}`;
}

/** A pile's own line, "Label · N": the label said by the pile's name in the reader's language. */
export function pileTitleWords(pile: Pick<PileInfo, "name" | "label" | "count" | "capped">, ctx: Pick<RowWordsCtx, "lang" | "words">): string {
  if (!spanish(ctx)) return pileTitle(pile);
  return pileTitle({ ...pile, label: ctx.words(pileLabelKey(pile)) });
}

/** "See All on Estimates": a pile's list link in the reader's language (piles.ts keeps the English). */
const LIST_KEY_BY_LABEL: ReadonlyMap<string, string> = new Map(
  Object.entries(NY_EN)
    .filter(([k]) => k.startsWith("ny_btn_seeAll"))
    .map(([k, v]) => [v, k]),
);

export function pileListLabelWords(pile: Pick<PileInfo, "listLabel">, ctx: Pick<RowWordsCtx, "lang" | "words">): string | null {
  if (!pile.listLabel) return null;
  const key = LIST_KEY_BY_LABEL.get(pile.listLabel);
  return key && spanish(ctx) ? ctx.words(key) : pile.listLabel;
}
