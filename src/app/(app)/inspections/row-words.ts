import { todayStrInTz } from "@/lib/tz";
import type { Lang } from "@/lib/locale";
import { appointmentTypeLabel, isDecidableVisitType, visitTitle } from "@/lib/statuses";
import { inspectionFileHref, inspectionRowWords, rowTagWords, type FiledUnder, type InspectionListState } from "@/lib/inspections";
import { dayWords, relativeWhen } from "@/lib/action-items/dated-when";
import { happenedSaidKey, primaryOf, rowDoors, stateWordKey, type ListRow } from "./list-rows";
import type { VisitOffer } from "@/lib/appointments/visit-offer";
import { wonStartShown } from "@/lib/appointments/won-sheet";

/**
 * ONE INSPECTION ROW, WORDED ON THE SERVER (cn-v1172: lifted out of the Inspections page). Erik,
 * 2026-11-19: "lets break the Estimate page into 2 parts consisting of completed inspections in its
 * own new list called Inspections To Estimate". That list is the Inspections list's own write_up row,
 * so both pages build their rows HERE and draw them with the same card (inspection-list): who in bold
 * opening the person's file, what and where, how long ago, the one boxed button and the same ⋯.
 *
 * Everything a row says is finished here, in the reader's language and the company's timezone, and
 * the rows are handed finished strings: nothing on the phone formats a date, so the server's render
 * and the phone's cannot differ.
 */

type Words = (key: string) => string;

export type RowContext = {
  t: Words;
  lang: Lang;
  /** The company's timezone. */
  tz: string;
  /** The page's ONE now, the same the buckets were made with. */
  now: Date;
  /** The Estimates switch: whether a priced-nothing row says Create Estimate or Open Inspection. */
  estimatesOn: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Visit = any;

/** Open Inspection first behind the ⋯, when the boxed button is not the visit's own page (an offer). */
function withOpen(doors: ListRow["doors"], add: boolean): ListRow["doors"] {
  return add && !doors.includes("open") ? ["open", ...doors] : doors;
}

export function inspectionRowBuilder(ctx: RowContext) {
  const { t, lang, tz, now, estimatesOn } = ctx;
  const todayStr = todayStrInTz(tz, now);
  const said = { lang, words: t };

  /**
   * THE ROW'S RIGHT EDGE. A Coming Up visit says when it is: its time alone today (one earlier today
   * that nobody closed out says its time too), its day and its time after. A write-up and a missed
   * visit say how long ago their day was, and a visit with no day how long ago it was made: an age, so
   * the DAY alone is handed over (the company's day) and no time of day rides along ("9d ago", never
   * "9d ago · 10:00 AM"). The day a thing happened is never "overdue". An age whose day is still ahead
   * (a visit marked done before its day) says that day, never "Tomorrow", which would read as when it
   * is due.
   */
  const dayOf = (iso: string | null | undefined): string | null => {
    const at = iso ? new Date(iso) : null;
    return at && !Number.isNaN(at.getTime()) ? todayStrInTz(tz, at) : null;
  };
  const ageOf = (iso: string | null | undefined): string | null => {
    const day = dayOf(iso);
    return day && day > todayStr ? dayWords(day, todayStr, tz, lang) : relativeWhen(day, todayStr, tz, false, said);
  };
  const edgeOf = (a: Visit, state: InspectionListState): string | null => {
    if (state === "coming_up") return relativeWhen(a.starts_at, todayStr, tz, false, said);
    if (state === "needs_day") return ageOf(a.created_at);
    return ageOf(a.starts_at); // write_up, missed: how long ago its day was
  };

  /**
   * WHO AND WHAT, every word finished (lib/inspections inspectionRowWords): who in bold, then what it
   * is. visitTitle: a title stamped during the three days the visit was a Walk-Through still says
   * today's word. The words the old pills said ride in the phrase (rowTagWords, handed the row's state,
   * or for the fold how it ended), never as a pill. stampLabels: a stored title was stamped with the
   * type's ENGLISH label, whoever reads it now.
   */
  const wordsOf = (a: Visit, tile: InspectionListState | FiledUnder) =>
    inspectionRowWords({
      title: visitTitle(a.title),
      typeLabel: appointmentTypeLabel(a.type, lang, t),
      stampLabels: [appointmentTypeLabel(a.type, "en")],
      customer: a.customers?.name ?? a.inquiries?.name ?? null,
      street: a.location ?? null,
      tags: rowTagWords(a, tile, lang, t),
      lang,
    });

  /** One visit on a list, every word finished, its buttons decided (list-rows). */
  const rowOf = (a: Visit, state: InspectionListState, offer: VisitOffer | null = null): ListRow => {
    const words = wordsOf(a, state);
    const decidable = isDecidableVisitType(a.type);
    const wonNoJob = a.outcome === "won" && !a.job_id;
    // cn-v1176 fix F2: the Won sheet's button only where the sheet takes the visit (won-sheet
    // wonStartShown, ONE rule); any other Won visit with no job keeps the button that opens the visit.
    const kind = primaryOf(state, { decidable, estimatesOn, wonNoJob: wonStartShown({ type: a.type, outcome: a.outcome, hasJob: !!a.job_id }) });
    const visitHref = `/appointments/${a.id}`;
    // THE BOXED BUTTON. Create Estimate: the capture prefills the estimator scope; the inquiry keeps
    // the lead threading (quotes/new also recovers it from the capture appointment when absent).
    // Start Inspection and Open Inspection both open the visit, where the inspection is done.
    const primary =
      kind === "estimate"
        ? { label: t("ip_btn_createEstimate"), href: `/quotes/new?capture=${a.id}${a.inquiry_id ? `&inquiry=${a.inquiry_id}` : ""}` }
        : kind === "wonStart"
          ? // A win with no job opens the Won sheet on the visit (cn-v1176: the job comes FROM the sale).
            { label: t("vi_btn_wonStartTheJob"), href: `${visitHref}?won=1` }
          : { label: t(kind === "start" ? "ip_btn_startInspection" : "ip_btn_openInspection"), href: visitHref };
    const wordKey = stateWordKey(state, estimatesOn);
    return {
      id: a.id,
      state,
      who: words.who,
      whoHref: inspectionFileHref(a),
      what: words.what,
      edge: edgeOf(a, state),
      stateWord: wonNoJob ? t("ip_wonNoJob") : wordKey ? t(wordKey) : null,
      primary,
      visitHref,
      // A win with no job has one move behind its button: Not Sold, if the work went away after all.
      // A row with an offer keeps Open Inspection behind the ⋯ (the offer took the boxed button's place).
      doors: withOpen(wonNoJob ? (decidable ? ["lost"] : []) : rowDoors(state, { primary: kind, decidable, hasStart: !!a.starts_at }), !!offer),
      startsAt: a.starts_at ?? null,
      endsAt: a.ends_at ?? null,
      happenedSaid: t(happenedSaidKey(estimatesOn)),
      // THE OFFER (cn-v1175, R5), on a won row too (cn-v1176: restored): a job made for this customer
      // after the visit is the likeliest answer to a win with no job, asked in place.
      offer: offer && offer.kind === "job" ? { id: offer.id, label: offer.label } : null,
      offerOthers: offer && offer.kind === "job" ? offer.others.filter((o) => o.kind === "job").map(({ id, label }) => ({ id, label })) : [],
    };
  };

  return { todayStr, wordsOf, rowOf };
}
