"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Check, ChevronDown, ChevronUp, Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { sayDollars } from "@/lib/supplier-open-list";
import type { BankRowView, BankSortedLine, BankView, FlowSegment } from "@/lib/bank-download";
import type { MoneyInChannels } from "@/lib/bank-money-in";
// Which answers a counted line may be changed TO: the same pure test the server refuses by.
import { reanswerOffers } from "@/lib/bank-reanswer";
import { applyBankDownload, forgetBankRule, reanswerBankLine, setBankAccount, swapBankDownload, undoBankDownload } from "@/app/(app)/bills/bank-actions";
// Putting the paper away goes through NotNowOrDelete, which owns both that write and Delete's confirm:
// this card no longer calls keepPaperwork itself, so there is one put-away door per state and not two.
import { NotNowOrDelete } from "@/components/not-now-or-delete";

/**
 * A BANK DOWNLOAD, AS ONE CARD IN SORT THESE (Erik, 2026-09-27: "yes go for those").
 *
 *   Bank ••1234 · Aug 26–Sep 25 · 96 sorted · 17 already in North · 5 need you, in 3 rows
 *   [one bar: where the money went]
 *   SHELL 123 ANYTOWN · 3 charges · $288.45   [Fuel] [Auto] [Owner's Draw] [Other…]
 *   Deposit Sep 4 · $1,275.00        [On INV-1001] [Other Income] [Already Counted Or Not Income] [Other…]
 *       Card: $17,751.63 paid this period, $17,228.55 to reach here after $523.08 of fees.
 *   Check 1043 · $640.00             [Pay Pat] [Other…]
 *   [Apply] [Set Aside]
 *
 * ONE WORD, ONE MEANING: a picked answer is cleared by tapping it again (the Other… list's empty
 * choice is "Choose…"); Set Aside puts the WHOLE download away.
 *
 * THE APP'S GUESS IS MARKED "Guess" AND NEVER PICKED FOR YOU (fill-vs-execute): a row counts only
 * once a person taps an answer. A row with no guess says so; the usual answers beside it are never
 * called one. A row left alone is left for later: Apply writes the rest and the
 * card keeps it, named as not counted. The detail (what it sorted, lines that didn't read) is
 * folded. Undo takes the whole download back.
 */

/** A row's answer button: a name can be long ("Pay Westfield Electrical Supply Company (Anytown Branch)"), so it
 *  wraps inside the card at 375px instead of running off it, and is never shorter than a thumb. */
const ANSWER = "h-auto min-h-11 max-w-full whitespace-normal py-2 text-left";

type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, filedSentence?: string, gone?: string) => void;

/** Each segment its own colour. Where Money by Month (money-chart.ts) has the same money, the same
 *  colour: Fuel pink-800 (the Fuel bucket, as on the chart and the Fuel card), Overhead
 *  pink-500, Materials & Bills indigo-500, Crew Pay amber-600, Owner's Draw green-600. The bank's
 *  own segments take colours that chart
 *  doesn't use, so no colour means two things. Identity is never colour alone: every segment is
 *  named with its figure in the legend under the bar. */
const TONES: Record<string, string> = {
  fuel: "bg-pink-800",
  business: "bg-pink-500",
  materials: "bg-indigo-500",
  suppliers: "bg-violet-700",
  crew: "bg-amber-600",
  draw: "bg-green-600",
  cash_out: "bg-orange-400",
  not_cost: "bg-cyan-800",
  books: "bg-stone-300",
  need: "bg-yellow-200",
};
export function toneOf(key: string): string {
  return TONES[key] ?? "bg-slate-300";
}

function FlowBar({ flow, outCents }: { flow: FlowSegment[]; outCents: number }) {
  if (!outCents || !flow.length) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-slate-600">Where {sayDollars(outCents / 100)} Went</p>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded" role="img" aria-label={flow.map((s) => `${s.label} ${sayDollars(s.cents / 100)}`).join(", ")}>
        {flow.map((s) => (
          <span key={s.key} className={`${toneOf(s.key)} h-full first:rounded-l last:rounded-r`} style={{ width: `${(s.cents / outCents) * 100}%`, minWidth: 2 }} title={`${s.label} ${sayDollars(s.cents / 100)}`} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600">
        {flow.map((s) => (
          <li key={s.key} className="flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-sm ${toneOf(s.key)}`} aria-hidden="true" />
            {s.label} <span className="tabular-nums text-slate-800">{sayDollars(s.cents / 100)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * WHERE YOUR MONEY CAME IN - one short block, above the rows, because it is what makes most of the rows
 * stop mattering.
 *
 *   How You Were Paid                     Paid     Should Reach Here
 *   Check                           $25,367.11            $25,367.11   Expect all of it here, a few days after it was paid.
 *   Card                            $17,751.63            $17,228.55   A payout lands days later: $17,228.55 after $523.08 of fees.
 *   Venmo                           $16,384.11            $16,384.11   Sits in Venmo until somebody moves it to the bank.
 *   Cash                             $6,451.35                 $0.00   Cash never reaches the bank. Its receipts are already costs.
 *   Should Reach Here $69,735.55 · Reached It $34,239.56
 *   $35,496.00 of what you were paid hasn't reached this account. $26,384.11 of it is Venmo and Zelle …
 *
 * EVERY FIGURE IS THE PURE FUNCTION'S (bank-money-in.ts). This component adds no arithmetic of its own:
 * a dash is what a figure that could not be worked out LOOKS like, never a 0 this file substituted.
 */
function MoneyInBlock({ channels }: { channels: MoneyInChannels }) {
  const dash = <span className="text-slate-400">—</span>;
  return (
    <div className="space-y-1.5 rounded-lg border border-slate-200 px-3 py-2">
      {/* THE TWO COLUMNS, NAMED - the headings the sketch above has always shown and the markup never
          drew. Two bare figures a row read "Check $25,367.11 $25,367.11" with nothing saying which was
          paid and which should reach here, and only the footer total let a reader work the second one out.
          A heading row, not per-row labels: the figures stay in their columns. */}
      <div className="flex flex-wrap items-baseline gap-x-3 text-xs font-medium text-slate-600">
        <span>How You Were Paid</span>
        <span className="ml-auto font-normal text-slate-500">Paid</span>
        <span className="w-28 text-right font-normal text-slate-500">Should Reach Here</span>
      </div>
      <ul className="space-y-1">
        {channels.rows.map((r) => (
          <li key={r.key} className="space-y-0.5">
            <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
              <span className="min-w-0 break-words text-slate-800">{r.label}</span>
              <span className="ml-auto tabular-nums text-slate-700">{sayDollars(r.recordedCents / 100)}</span>
              {/* WHAT SHOULD REACH THIS ACCOUNT. A channel nobody has worked out a fate for shows a dash,
                  with its reason beside it: it is in no total on this card either. */}
              <span className="w-28 text-right tabular-nums text-slate-900">{r.expectedCents == null ? dash : sayDollars(r.expectedCents / 100)}</span>
            </div>
            <p className="text-xs text-slate-500">{r.why}</p>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-baseline gap-x-3 border-t border-slate-100 pt-1 text-xs text-slate-600">
        <span>
          Should Reach Here <span className="tabular-nums text-slate-900">{sayDollars(channels.expectedCents / 100)}</span>
        </span>
        <span>
          Reached It <span className="tabular-nums text-slate-900">{sayDollars(channels.reachedCents / 100)}</span>
        </span>
        {/* MONEY IN WITH NOTHING ELSE TO SAY: deposits whose words name no way of being paid. Said, and
            never quietly attached to a channel to make the arithmetic look finished. */}
        {channels.unnamedCents > 0 && <span>Deposits That Don&apos;t Say Which {sayDollars(channels.unnamedCents / 100)}</span>}
      </div>
      {/* THE ONE SENTENCE, leading with the figure he can act on. */}
      <p className="text-sm text-slate-800">{channels.say}</p>
    </div>
  );
}

/**
 * THE ANSWER BUTTONS one row, or one line of an opened row, draws: the quick answers (the guess
 * first), a pick off the list shown pressed, and Other… with the longer list.
 */
function Answers({
  title,
  guess,
  buttons,
  others,
  picked,
  onPick,
  working,
  after,
}: {
  title: string;
  guess: string | null;
  buttons: { id: string; label: string }[];
  others: { id: string; label: string }[];
  picked: string | undefined;
  onPick: (id: string | undefined) => void;
  working: boolean;
  after?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pickedLabel = picked ? (buttons.find((b) => b.id === picked)?.label ?? others.find((o) => o.id === picked)?.label ?? picked) : null;
  const offList = picked && !buttons.some((b) => b.id === picked);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {buttons.map((b) => (
          <Button
            key={b.id}
            className={ANSWER}
            variant={picked === b.id ? "primary" : "outline"}
            aria-pressed={picked === b.id}
            onClick={() => onPick(picked === b.id ? undefined : b.id)}
            disabled={working}
            title={b.id === guess ? "The app's guess. Tap it if it's right." : undefined}
          >
            {picked === b.id && <Check />} {b.label}
            {b.id === guess && (
              <span className="rounded bg-amber-100 px-1 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                Guess
              </span>
            )}
          </Button>
        ))}
        {offList && (
          <Button className={ANSWER} variant="primary" aria-pressed onClick={() => onPick(undefined)} disabled={working}>
            <Check /> {pickedLabel}
          </Button>
        )}
        <Button variant="outline" onClick={() => setOpen((o) => !o)} disabled={working} aria-expanded={open}>
          Other…
        </Button>
        {after}
      </div>
      {open && (
        <Select
          className="h-11 w-full sm:w-80"
          value={picked ?? ""}
          aria-label={`Where ${title} goes`}
          onChange={(e) => {
            onPick(e.target.value || undefined);
            setOpen(false);
          }}
          disabled={working}
        >
          <option value="">Choose…</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </>
  );
}

/**
 * ONE QUESTION ROW. A merchant's row holding several lines OPENS (2026-10-07): "3 Charges" lists
 * each line with its day and money and its own answer buttons, with the longer Other… list (a job
 * on money out, an invoice on money in) because each line is one line. A line's own answer wins
 * over the row's, and both may stand: the row answered Fuel with one line put on a job is one
 * Apply, "the rest are Fuel, this one goes on the job". The row stays open while any line holds an
 * answer, so nothing picked is ever out of sight.
 */
function Row({
  row,
  picks,
  onPick,
  others,
  lineOthers,
  working,
}: {
  row: BankRowView;
  picks: Record<string, string>;
  onPick: (id: string, choice: string | undefined) => void;
  others: { id: string; label: string }[];
  lineOthers: { id: string; label: string }[];
  working: boolean;
}) {
  const [linesOpen, setLinesOpen] = useState(false);
  const lines = row.lines ?? [];
  const linePicked = lines.filter((l) => picks[l.id]).length;
  const open = lines.length > 0 && (linesOpen || linePicked > 0);
  const word = row.direction === "in" ? "Deposits" : "Charges";
  return (
    <li className="space-y-2 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="min-w-0 break-words font-medium text-slate-900">{row.title}</span>
        <span className="tabular-nums text-slate-700">{row.money}</span>
        <span className="text-xs text-slate-500">{row.dates}</span>
        {row.direction === "in" && <span className="text-xs text-green-700">Money In</span>}
        {!row.guess && <span className="text-xs text-slate-500">No guess</span>}
      </div>
      {row.hint && <p className="text-xs text-slate-600">{row.hint}</p>}
      <Answers
        title={row.title}
        guess={row.guess}
        buttons={row.buttons}
        others={others}
        picked={picks[row.id]}
        onPick={(id) => onPick(row.id, id)}
        working={working}
        after={
          lines.length > 0 ? (
            <Button variant="outline" onClick={() => setLinesOpen(!open)} disabled={working} aria-expanded={open} title="Answer each line on its own">
              {lines.length} {word} {open ? <ChevronUp /> : <ChevronDown />}
            </Button>
          ) : null
        }
      />
      {open && (
        <ul className="ml-2 divide-y divide-slate-100 border-l-2 border-slate-200 pl-3" aria-label={`The ${lines.length} ${word.toLowerCase()} of ${row.title}`}>
          {lines.map((l) => (
            <li key={l.id} className="space-y-2 py-2">
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="text-xs text-slate-500">{l.day}</span>
                <span className="min-w-0 break-words text-slate-900">{l.title}</span>
                <span className="tabular-nums text-slate-700">{l.money}</span>
              </div>
              <Answers
                title={`${l.title} of ${l.day}`}
                guess={row.guess}
                buttons={row.buttons}
                others={lineOthers}
                picked={picks[l.id]}
                onPick={(id) => onPick(l.id, id)}
                working={working}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * THE Other… LIST A ROW GETS. A row that is ONE line gets the longer list: the answers that go on one
 * thing — an invoice coming in, a job going out (0375) — are offered only where there is one line to
 * put on it. A row holding several of a merchant's lines gets the shared list, with neither in it. A
 * deposit brings its own list (the invoices open for at least its money, said in full, and never a
 * job: a credit on a job with no lines would credit the customer the whole amount).
 */
export function othersFor(
  row: Pick<BankRowView, "direction" | "single" | "others">,
  view: Pick<BankView, "otherOut" | "otherOutSingle" | "otherIn" | "otherInSingle">,
): { id: string; label: string }[] {
  if (row.others) return row.others;
  if (row.direction === "in") return row.single ? view.otherInSingle : view.otherIn;
  return row.single ? view.otherOutSingle : view.otherOut;
}

/**
 * CHANGE ANSWER'S LIST FOR ONE COUNTED LINE: the card's own Other… list for a line of that direction
 * (every bucket, Owner's Draw, a job on money out; the money-in words and a bucket's refund on money in),
 * less the payment answers (a supplier, crew pay, an invoice: Undo and Apply again for those) and less
 * the answer it already has.
 */
export function changeChoicesFor(
  line: Pick<BankSortedLine, "direction" | "current">,
  view: Pick<BankView, "otherOutSingle" | "otherInSingle">,
): { id: string; label: string }[] {
  const list = line.direction === "in" ? view.otherInSingle : view.otherOutSingle;
  return list.filter((o) => reanswerOffers(o.id) && o.id !== line.current);
}

/** One line Apply already counted: what it says, the answer it holds, and Change Answer. */
function SortedLineRow({ line, view, run, busy, working }: { line: BankSortedLine; view: BankView; run: Run; busy: string | null; working: boolean }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState("");
  const key = `reanswer:${line.id}`;
  const choices = changeChoicesFor(line, view);
  return (
    <li className="space-y-2 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-xs text-slate-500">{line.day}</span>
        <span className="min-w-0 break-words font-medium text-slate-900">{line.title}</span>
        <span className="tabular-nums text-slate-700">{line.money}</span>
        {line.direction === "in" && <span className="text-xs text-green-700">Money In</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words text-sm text-slate-800">{line.answer}</span>
        <span className="text-xs text-slate-500">{line.by}</span>
        <Button
          variant="outline"
          className="ml-auto"
          onClick={() => {
            setOpen((o) => !o);
            setPick("");
          }}
          disabled={working}
          aria-expanded={open}
        >
          Change Answer
        </Button>
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-2">
          <Select className="h-11 w-full sm:w-80" value={pick} aria-label={`The new answer for ${line.title}`} onChange={(e) => setPick(e.target.value)} disabled={working}>
            <option value="">Choose…</option>
            {choices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
          <Button
            onClick={() =>
              run(key, async () => {
                const res = await reanswerBankLine({ lineId: line.id, choice: pick });
                if (res.ok) {
                  setOpen(false);
                  setPick("");
                }
                return res;
              })
            }
            disabled={working || !pick}
          >
            {busy === key ? <Loader2 className="animate-spin" /> : <Check />} Save Answer
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * SORTED LINES (2026-10-07): every line this download already counted, under the applied pass, each
 * with Change Answer — one line answered again without Undo taking the whole download back. Folded:
 * a month is a hundred lines and the rows still asking come first. A read that failed says so.
 */
function SortedLines({ view, run, busy, working }: { view: BankView; run: Run; busy: string | null; working: boolean }) {
  if (view.sortedProblem) return <p className="text-xs text-amber-800">{view.sortedProblem}</p>;
  // A view built before this list existed (older callers, test fixtures) simply has no lines to show.
  const lines = view.sortedLines ?? [];
  if (!lines.length) return null;
  return (
    <details className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
      <summary className="flex min-h-11 cursor-pointer items-center font-medium text-slate-700">Sorted Lines</summary>
      <p className="mt-1 text-xs text-slate-500">
        Each line as it was counted. Change Answer moves one line to another answer: what its old answer wrote comes off, the new answer&apos;s is written, and what the old answer taught for next time is narrowed to match. Every other line stays as it is.
      </p>
      <ul className="divide-y divide-slate-100">
        {lines.map((l) => (
          <SortedLineRow key={l.id} line={l} view={view} run={run} busy={busy} working={working} />
        ))}
      </ul>
      {view.sortedMore > 0 && <p className="text-xs text-slate-500">And {view.sortedMore} more not listed here.</p>}
    </details>
  );
}

/** The picks for rows still on the card (and the lines of those rows): a row the books took away
 *  since keeps no answer. */
export function livePicks(picks: Record<string, string>, rows: readonly { id: string; lines?: readonly { id: string }[] }[]): Record<string, string> {
  const here = new Set(rows.flatMap((r) => [r.id, ...(r.lines ?? []).map((l) => l.id)]));
  return Object.fromEntries(Object.entries(picks).filter(([id]) => here.has(id)));
}

/**
 * HOW MANY ROWS ARE ANSWERED, by the rule Apply counts with: a row is answered when it holds an
 * answer itself or every one of its lines does; a row with some lines answered is PARTLY answered -
 * Apply has something to write, and the row still waits on the card for the rest.
 */
export function rowsAnswered(live: Record<string, string>, rows: readonly { id: string; lines?: readonly { id: string }[] }[]): { answered: number; partly: number } {
  let answered = 0;
  let partly = 0;
  for (const r of rows) {
    const lines = r.lines ?? [];
    if (live[r.id] || (lines.length > 0 && lines.every((l) => live[l.id]))) answered++;
    else if (lines.some((l) => live[l.id])) partly++;
  }
  return { answered, partly };
}

export function BankCard({ itemId, view, run, busy, working }: { itemId: string; view: BankView | null | undefined; run: Run; busy: string | null; working: boolean }) {
  const router = useRouter();
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [four, setFour] = useState("");

  // PUT IT AWAY OR BIN IT, with where it goes said on the card (NotNowOrDelete, 2026-10-03): the same
  // pair, the same words and the same destination as a supplier's open list, from one place.
  //
  // AND DELETE SAYS WHAT COMES OFF THE BOOKS (review, 2026-10-03). Delete runs `undoBankCore` first, so
  // on a PART-APPLIED download it deletes the bills and the invoice payments Apply wrote and voids the
  // supplier and crew payments — while the one fixed confirm said "nothing it would have changed is
  // written". Apply 30 of 40 lines, tap Delete to bin the leftovers, and the customer's payments came
  // off with nothing said until the toast afterwards. The card knows the count, so the card says it, in
  // the words its own Undo confirm already uses.
  const alreadyCounted = view?.appliedLines ?? 0;
  // EVERY LINE ALREADY IN NORTH (the same month downloaded again): there is nothing to write, so the one
  // put-away door says exactly that and the pair below is otherwise unchanged. Never two buttons that
  // archive the same paper in different words.
  const nothingNew = !!view && !view.problem && view.rows.length === 0 && view.counts.matched + view.counts.ruled === 0;
  const notNow = (
    <NotNowOrDelete
      itemId={itemId}
      what="bank download"
      label={nothingNew ? "Done: Nothing New" : "Set Aside"}
      keptSaid={nothingNew ? "Nothing new in it. Kept in files." : undefined}
      alsoTakesBack={
        alreadyCounted > 0
          ? `everything it already wrote comes off: the ${alreadyCounted === 1 ? "1 line" : `${alreadyCounted} lines`} it counted, with their bills and payments`
          : null
      }
      run={run}
      working={working}
    />
  );
  const undo = view?.canUndo ? (
    <Button
      variant="outline"
      onClick={() => {
        if (confirm("Undo this whole download? Everything it wrote comes off, and every line waits here again.")) run("undo", () => undoBankDownload(itemId));
      }}
      disabled={working}
    >
      {busy === "undo" ? <Loader2 className="animate-spin" /> : <Undo2 />} Undo This Download
    </Button>
  ) : null;

  if (!view) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="w-full text-sm text-slate-600">This download couldn&apos;t be sorted right now. Refresh the page to try again.</p>
        {notNow}
      </div>
    );
  }
  if (view.problem) {
    return (
      <div className="mt-2 space-y-2">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          {view.problem}
        </p>
        <div className="flex flex-wrap gap-2">
          {notNow}
          {undo}
        </div>
      </div>
    );
  }

  // ONLY THE ROWS ON THE CARD NOW: after a 'books changed' refresh a picked row may be gone (its
  // deposit matched the payment just recorded). Its pick would refuse every later Apply, and there
  // is no row left on screen to clear it.
  const live = livePicks(picks, view.rows);
  const { answered, partly } = rowsAnswered(live, view.rows);
  const leftRows = view.rows.length - answered;
  const sorted = view.counts.matched + view.counts.ruled;
  const canApply = sorted + answered + partly > 0;
  const apply = () =>
    run(
      "apply",
      async () => {
        const res = await applyBankDownload(itemId, { fingerprint: view.fingerprint, picks: live });
        if (res.stale) router.refresh();
        if (res.ok) setPicks({});
        return res;
      },
      // THE CARD LEAVES only when every row is answered: then (as any paper filed) the list line and
      // the toast carry Undo. A partial Apply stays on the card, says what it did in the card's own
      // line, and its one Undo is the card's confirmed Undo This Download.
      leftRows === 0 ? "Applied." : undefined,
    );

  return (
    <div className="mt-2 space-y-3">
      <p className="text-sm font-medium text-slate-900">{view.headline}</p>
      {/* WHAT CHECKED THIS READ, IN FRONT OF HIM WHERE APPLY IS. The paper's own running balance walked
          line by line, the printed totals where it prints them, or — said out loud — that nothing could
          check it at all; and one short clause saying how it was read, so he knows how hard to look. The
          line under the drop button says it at the moment of the drop; this says it at the moment of the
          decision, which may be tomorrow. EVERY download carries one (2026-10-02): a running balance is
          printed on a CSV, an Excel export and a statement's pages alike. */}
      {view.readSaid && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700" role="status">
          {view.readSaid}
        </p>
      )}
      {view.channels && <MoneyInBlock channels={view.channels} />}
      <FlowBar flow={view.flow} outCents={view.outCents} />
      {view.appliedSaid && <p className="text-xs text-slate-600">{view.appliedSaid}</p>}
      <SortedLines view={view} run={run} busy={busy} working={working} />
      {view.rows.length > 0 && <p className="text-xs text-slate-500">A button marked Guess is the app&apos;s guess. Nothing counts until you tap one.</p>}
      {view.rows.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 px-3">
          {view.rows.map((r) => (
            <Row
              key={r.id}
              row={r}
              picks={picks}
              onPick={(id, choice) =>
                setPicks((all) => {
                  const next = { ...all };
                  if (choice) next[id] = choice;
                  else delete next[id];
                  return next;
                })
              }
              others={othersFor(r, view)}
              lineOthers={r.direction === "in" ? view.otherInSingle : view.otherOutSingle}
              working={working}
            />
          ))}
        </ul>
      )}
      {canApply && leftRows > 0 && (
        <p className="text-xs text-slate-600">
          {leftRows === 1 ? "1 row" : `${leftRows} rows`} left for later {leftRows === 1 ? "isn't" : "aren't"} counted; {leftRows === 1 ? "it waits" : "they wait"} here.
        </p>
      )}
      {!canApply && view.rows.length > 0 && <p className="text-xs text-slate-600">Answer a row, and Apply counts it.</p>}
      <div className="flex flex-wrap gap-2">
        {canApply && (
          <Button onClick={apply} disabled={working}>
            {busy === "apply" ? <Loader2 className="animate-spin" /> : <Check />} Apply
          </Button>
        )}
        {/* DELETE IS DRAWN IN EVERY STATE, THIS ONE INCLUDED (review, 2026-10-03). A lone "Done: Nothing
            New" button used to REPLACE NotNowOrDelete here, so in the one state a second download of an
            overlapping month lands in there was no Delete and no sentence saying where the paper goes —
            the very thing Erik could not find, in the shape it most often arrives. The put-away button
            still says "Done: Nothing New" (see `nothingNew` above), so there is one door, not two. */}
        {notNow}
        {undo}
      </div>
      {view.swapped && <p className="text-xs text-slate-600">Read as a card&apos;s download: its charges are money out, its payments and credits money in.</p>}
      {view.askAccount && (
        <div className="space-y-1.5">
          <p className="text-xs text-slate-600">No account on this file. Which account is it? The last 4 digits keep the same line on two accounts from being counted once.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-11 w-24"
              inputMode="numeric"
              maxLength={4}
              value={four}
              onChange={(e) => setFour(e.target.value.replace(/\D/g, "").slice(0, 4))}
              aria-label="The account's last 4 digits"
              placeholder="1234"
              disabled={working}
            />
            <Button variant="outline" onClick={() => run("account", () => setBankAccount(itemId, four))} disabled={working || four.length !== 4}>
              {busy === "account" ? <Loader2 className="animate-spin" /> : <Check />} Save Account
            </Button>
          </div>
        </div>
      )}
      {(view.sorted.length > 0 || view.skipped.length > 0 || view.canSwap) && (
        <details className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <summary className="flex min-h-11 cursor-pointer items-center font-medium text-slate-700">See How It Sorted</summary>
          <div className="mt-2 space-y-3">
            {view.sorted.length > 0 && (
              <ul className="space-y-0.5">
                {view.sorted.map((s) => (
                  <li key={s.label} className="flex flex-wrap gap-x-3 text-slate-700">
                    <span>{s.label}</span>
                    <span className="text-xs text-slate-500">{s.n === 1 ? "1 line" : `${s.n} lines`}</span>
                    <span className="ml-auto tabular-nums">{sayDollars(s.cents / 100)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-slate-500">
              Matched means it is already in North (a payment, a bill, a supplier or crew payment): Apply only marks it, never adds it again. Owner&apos;s Draw — anything that wasn&apos;t the business&apos;s — Owner&apos;s Money In and Cash Taken Out are kept as the bank line only, never a cost and never income; cash counts when its receipts come in.
            </p>
            {view.rules.length > 0 && (
              <div>
                <p className="font-medium text-slate-800">Your Answers Used Here</p>
                <p className="text-xs text-slate-500">Each was remembered from a tap on an earlier download, for amounts like those. Forget one and its lines are asked again.</p>
                <ul className="mt-1 space-y-1">
                  {view.rules.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-700">
                      <span className="min-w-0 break-words">{r.label}</span>
                      <span className="text-xs text-slate-500">{r.n === 1 ? "1 line" : `${r.n} lines`}</span>
                      <Button variant="outline" className="ml-auto" onClick={() => run(`forget:${r.id}`, () => forgetBankRule(r.id))} disabled={working}>
                        {busy === `forget:${r.id}` ? <Loader2 className="animate-spin" /> : null} Forget
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {view.canSwap && (
              <div className="space-y-1.5">
                <p className="text-xs text-slate-500">
                  {view.swapped
                    ? "This file prints charges as positive, so they were read as money out. If that is wrong, swap them back."
                    : "Charges showing as Money In? Some card downloads print them that way round."}
                </p>
                <Button variant="outline" onClick={() => run("swap", () => swapBankDownload(itemId))} disabled={working}>
                  {busy === "swap" ? <Loader2 className="animate-spin" /> : <ArrowLeftRight />} Swap Money In And Out
                </Button>
              </div>
            )}
            {view.skipped.length > 0 && (
              <div>
                <p className="font-medium text-slate-800">Lines That Didn&apos;t Read ({view.skipped.length})</p>
                <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                  {view.skipped.map((s) => (
                    <li key={s.line}>
                      Line {s.line}: {s.why}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
