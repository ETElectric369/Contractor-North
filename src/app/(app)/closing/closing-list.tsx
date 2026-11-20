"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { useLang } from "@/components/lang-provider";
import { SendButton } from "@/components/send-sheet";
import { fillText, translator } from "@/lib/i18n";
import { dayWords } from "@/lib/action-items/dated-when";
import { formatCurrency } from "@/lib/utils";
import { updateQuoteStatus } from "@/app/(app)/quotes/actions";
import type { ClosingState } from "@/lib/estimate/closing";
import { ClosingClock } from "./closing-clock";

/**
 * THE CLOSING LIST (cn-v1172). Erik, 2026-11-19: "an inbox for estimates that havent been accepted
 * only for a sales person, once an estimate is accepted it will disappear from there and file with
 * the customer file". Each estimate out with no answer is a card of its own, the Leads and
 * Inspections lists' look: who (a door to their file), the estimate, how long it has waited, and
 * three doors: Accepted, Not Sold, Send Again.
 *
 * ACCEPTED AND NOT SOLD ARE TWO TAPS, INLINE (never the browser's dialog): the first swaps the doors
 * for one sentence and Yes / Cancel; Yes calls updateQuoteStatus, the door the estimate page's own
 * status control uses. A refusal stays on the row. What a success says (the job it made, a warning)
 * is ONE line above the list that OUTLIVES the row: this component draws its own empty state and
 * stays mounted when the last row leaves, so the line is still there to read.
 *
 * AMBER IS THE OFFER'S DAY AND NOTHING ELSE: an offer ending soon or ended is a real deadline (the
 * day printed on the estimate the customer holds). The wait, the quiet line and every refusal are slate.
 */

/** What the page hands each row: the reader's own rows, no tech ever (the page is office only). */
export type ClosingCardRow = {
  id: string;
  quoteNumber: string | null;
  title: string | null;
  total: number | null;
  customerName: string | null;
  customerCompany: string | null;
  /** The person's file (closingFileHref), or null: the name is plain words. */
  fileHref: string | null;
  validUntil: string | null;
  state: Pick<ClosingState, "sinceAt" | "sentLogged" | "daysWaiting" | "offer" | "why">;
};

type T = (key: string) => string;
type Ctx = { t: T; lang: string; todayStr: string; tz: string };

/** The row's three lines of words, pure so every state is pinned in both languages. */
export function closingRowWords(row: ClosingCardRow, ctx: Ctx): { sent: string | null; quiet: string | null; offer: { text: string; amber: boolean } | null } {
  const day = (v: string | null) => dayWords(v, ctx.todayStr, ctx.tz, ctx.lang) ?? "";
  const s = row.state;
  // "Sent" only for a send the app logged: an estimate marked Sent by hand has no send day to name.
  const sent = s.sentLogged ? fillText(ctx.t("cl_sentOn"), { day: day(s.sinceAt) }) : ctx.t("cl_noSendOnRecord");
  // No number of days (cn-v1172 fixer): the rule counts to midnight of the company's today and the
  // clock beside it counts real time, so a number here would lag the clock. "A week or more" is true
  // whenever the rule calls it quiet.
  const quiet = s.why === "quiet" ? ctx.t("cl_quiet") : null;
  const offerDay = row.validUntil ? day(row.validUntil) : "";
  const offer =
    s.offer === "ended"
      ? { text: fillText(ctx.t("cl_offerEnded"), { day: offerDay }), amber: true }
      : s.offer === "ends_soon"
        ? { text: fillText(ctx.t("cl_offerEnds"), { day: offerDay }), amber: true }
        : s.offer === "open"
          ? { text: fillText(ctx.t("cl_offerOpen"), { day: offerDay }), amber: false }
          : null;
  return { sent, quiet, offer };
}

/** The estimate's own name on the row: its number, then its title. */
export function estimateRef(row: Pick<ClosingCardRow, "quoteNumber" | "title">, t: T): string {
  return [row.quoteNumber, row.title].filter((x) => !!x && String(x).trim()).join(" · ") || t("cl_anEstimate");
}

/** The line a success leaves above the list (it outlives the row). */
export type ClosingNotice = { status: "accepted" | "declined"; ref: string; quoteId?: string | null; jobId?: string | null; warning?: string | null; said?: string | null };

type StatusAnswer = { ok: boolean; error?: string; warning?: string; said?: string; jobId?: string } | null | undefined;

/**
 * WHAT ONE ANSWER FROM updateQuoteStatus DOES TO THE LIST, pure: a refusal stays on the row in the
 * server's own words; a success takes the row off and leaves its line. Nothing silent: an answer
 * that is no answer at all is the dropped-connection sentence.
 */
export function afterAnswer(res: StatusAnswer, status: "accepted" | "declined", ref: string, t: T, quoteId: string | null = null): { error: string } | { notice: ClosingNotice } {
  if (!res) return { error: t("cl_dropped") };
  if (!res.ok) return { error: res.error || t("cl_dropped") };
  return { notice: { status, ref, quoteId, jobId: res.jobId ?? null, warning: res.warning ?? null, said: res.said ?? null } };
}

/** The house's boxed primary and outline buttons, on a 44px target (the Inspections list's look). */
const PRIMARY =
  "btn-gloss inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[rgb(var(--glass-ink))] px-4 text-sm font-medium text-white shadow-sm hover:bg-[rgb(var(--glass-ink))]/90 disabled:opacity-60";
const OUTLINE =
  "btn-gloss inline-flex h-11 items-center justify-center whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:border-brand hover:text-brand disabled:opacity-60";

export function ClosingList({
  rows,
  nowMs,
  todayStr,
  tz,
  textReady,
  initialNotice = null,
  initialGone = [],
}: {
  rows: readonly ClosingCardRow[];
  nowMs: number;
  todayStr: string;
  tz: string;
  textReady: boolean;
  /** For a static render of the line after a success (tests); null in the app. */
  initialNotice?: ClosingNotice | null;
  initialGone?: readonly string[];
}) {
  const lang = useLang();
  const t = translator(lang);
  const router = useRouter();
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set(initialGone));
  const [notice, setNotice] = useState<ClosingNotice | null>(initialNotice);
  const shown = rows.filter((r) => !gone.has(r.id));
  const ctx: Ctx = { t, lang, todayStr, tz };

  return (
    <div>
      {notice && <NoticeLine notice={notice} t={t} onDismiss={() => setNotice(null)} />}
      {shown.length === 0 ? (
        // ITS OWN EMPTY STATE, so the line above outlives the last row (no dead end: a door).
        <div data-closing-empty="" className="rounded-xl border-2 border-dashed border-slate-200 bg-white px-4 py-8 text-center">
          <FileText className="mx-auto h-8 w-8 text-slate-300" aria-hidden />
          <p className="mt-2 font-semibold text-slate-800">{t("cl_empty")}</p>
          <p className="mt-1 text-sm text-slate-500">{t("cl_emptyDesc")}</p>
          <Link href="/quotes" className={`${OUTLINE} mt-4`}>
            {t("cl_btn_goToEstimates")}
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {shown.map((row) => (
            <ClosingCard
              key={row.id}
              row={row}
              ctx={ctx}
              nowMs={nowMs}
              textReady={textReady}
              onDone={(n) => {
                setGone((g) => new Set([...g, row.id]));
                setNotice(n);
                router.refresh();
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoticeLine({ notice, t, onDismiss }: { notice: ClosingNotice; t: T; onDismiss: () => void }) {
  const done = fillText(t(notice.status === "accepted" ? "cl_doneAccepted" : "cl_doneNotSold"), { ref: notice.ref });
  return (
    <div role="status" data-closing-notice="" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-slate-300 bg-slate-50 px-4 py-2 text-sm text-slate-800">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{[done, notice.said, notice.warning].filter(Boolean).join(" ")}</span>
      {notice.jobId && (
        <Link href={`/jobs/${notice.jobId}`} className={OUTLINE}>
          {t("cl_btn_openJob")}
        </Link>
      )}
      {/* A SECOND DOOR, TO THE ESTIMATE (cn-v1172 fixer): what the line says can send the person back
          to it (Keep Both after a revision is accepted, a warning about its job), so the line is never
          a dead end. The row it came from is gone. */}
      {notice.quoteId && (
        <Link href={`/quotes/${notice.quoteId}`} className={OUTLINE} data-open-estimate="">
          {t("cl_btn_openEstimate")}
        </Link>
      )}
      <button type="button" onClick={onDismiss} className={OUTLINE}>
        {t("cl_btn_dismiss")}
      </button>
    </div>
  );
}

export function ClosingCard({
  row,
  ctx,
  nowMs,
  textReady,
  onDone,
  initialAsk = null,
  initialError = null,
}: {
  row: ClosingCardRow;
  ctx: Ctx;
  nowMs: number;
  textReady: boolean;
  onDone: (n: ClosingNotice) => void;
  /** For a static render of the second tap (tests); null in the app. */
  initialAsk?: "accepted" | "declined" | null;
  initialError?: string | null;
}) {
  const { t, lang } = ctx;
  const [ask, setAsk] = useState<"accepted" | "declined" | null>(initialAsk);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, start] = useTransition();
  const words = closingRowWords(row, ctx);
  const ref = estimateRef(row, t);
  const shortRef = row.quoteNumber || t("cl_anEstimate");
  const who = row.customerName?.trim() || t("cl_noName");
  const name = "inline-flex min-h-11 min-w-0 items-center font-semibold text-slate-900 [overflow-wrap:anywhere]";

  const answer = (status: "accepted" | "declined") =>
    start(async () => {
      setError(null);
      let res: StatusAnswer;
      try {
        res = (await updateQuoteStatus(row.id, status)) as StatusAnswer;
      } catch {
        res = null;
      }
      const after = afterAnswer(res, status, shortRef, t, row.id);
      if ("error" in after) {
        setError(after.error);
        setAsk(null);
        return;
      }
      onDone(after.notice);
    });

  return (
    <li data-row={row.id} data-why={row.state.why ?? ""} className="flex flex-col gap-1.5 rounded-xl border-2 border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-center gap-x-3">
        {row.fileHref ? (
          <Link href={row.fileHref} className={`${name} hover:text-brand hover:underline`} data-who="">
            {who}
          </Link>
        ) : (
          <span className={name} data-who="">
            {who}
          </span>
        )}
        {row.customerCompany && <span className="min-w-0 truncate text-sm text-slate-500">{row.customerCompany}</span>}
        {row.total != null && <span className="ml-auto whitespace-nowrap font-semibold tabular-nums text-slate-900">{formatCurrency(row.total, lang)}</span>}
      </div>
      <Link href={`/quotes/${row.id}`} className="inline-flex min-h-11 items-center text-sm text-slate-700 hover:text-brand hover:underline [overflow-wrap:anywhere]" data-estimate="">
        {ref}
      </Link>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
        <span data-sent="">{words.sent}</span>
        {row.state.sentLogged && row.state.sinceAt && <ClosingClock since={row.state.sinceAt} nowMs={nowMs} />}
        {words.quiet && <span data-quiet="">{words.quiet}</span>}
        {words.offer && (
          <span data-offer={words.offer.amber ? "amber" : "slate"} className={words.offer.amber ? "font-medium text-amber-700" : "text-slate-600"}>
            {words.offer.text}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" data-refusal="" className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900">
          {error}
        </p>
      )}
      {ask ? (
        <div data-ask={ask} className="flex flex-wrap items-center justify-end gap-2">
          <p className="mr-auto min-w-0 text-sm text-slate-800 [overflow-wrap:anywhere]">
            {fillText(t(ask === "accepted" ? "cl_askAccepted" : "cl_askNotSold"), { ref: shortRef })}
          </p>
          <button type="button" disabled={busy} onClick={() => answer(ask)} className={PRIMARY}>
            {t("cl_btn_yes")}
          </button>
          <button type="button" disabled={busy} onClick={() => setAsk(null)} className={OUTLINE}>
            {t("cl_btn_cancel")}
          </button>
        </div>
      ) : (
        <div data-doors="" className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={() => {
              setError(null);
              setAsk("accepted");
            }} className={PRIMARY}>
            {t("cl_btn_accepted")}
          </button>
          <button type="button" onClick={() => {
              setError(null);
              setAsk("declined");
            }} className={OUTLINE}>
            {t("cl_btn_notSold")}
          </button>
          <SendButton
            kind="quote"
            id={row.id}
            number={row.quoteNumber}
            customerName={row.customerName}
            amount={row.total}
            textReady={textReady}
            openHref={`/quotes/${row.id}`}
            label={t("cl_btn_sendAgain")}
            variant="outline"
            className="h-11"
          />
        </div>
      )}
    </li>
  );
}
