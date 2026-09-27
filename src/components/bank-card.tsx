"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArrowLeftRight, Check, Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { sayDollars } from "@/lib/supplier-open-list";
import type { BankRowView, BankView, FlowSegment } from "@/lib/bank-download";
import { applyBankDownload, forgetBankRule, setBankAccount, swapBankDownload, undoBankDownload } from "@/app/(app)/bills/bank-actions";
import { keepPaperwork } from "@/app/(app)/organize/paperwork-actions";

/**
 * A BANK DOWNLOAD, AS ONE CARD IN SORT THESE (Erik, 2026-09-27: "yes go for those").
 *
 *   Bank ••1234 · Aug 26–Sep 25 · 96 sorted · 17 already in North · 3 need you
 *   [one bar: where the money went]
 *   SHELL 123 ANYTOWN · 3 charges · $288.45   [Fuel] [Truck] [Personal] [Other…]
 *   Deposit Sep 4 · $1,275.00        [On INV-1001] [Other Income] [Already Counted Or Not Income] [Other…]
 *   Check 1043 · $640.00             [Pay Pat] [Other…]
 *   [Apply] [Not Now]
 *
 * THE APP'S GUESS IS MARKED "Guess" AND NEVER PICKED FOR YOU (fill-vs-execute): a row counts only
 * once a person taps an answer. A row with no guess says so; the usual answers beside it are never
 * called one. A row left alone is left for later: Apply writes the rest and the
 * card keeps it, named as not counted. The detail (what it sorted, lines that didn't read) is
 * folded. Undo takes the whole download back.
 */

type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, filedSentence?: string) => void;

/** The segment's colour, in the Money by Month palette (money-chart.ts), so a colour means the
 *  same money on both cards. Identity is never colour alone: every segment is named with its figure
 *  in the legend under the bar. */
function toneOf(key: string): string {
  if (key === "fuel") return "bg-pink-600";
  if (key.startsWith("bucket:")) return "bg-pink-300";
  if (key === "suppliers" || key === "materials") return "bg-indigo-500";
  if (key === "crew") return "bg-amber-600";
  if (key === "draw") return "bg-green-600";
  if (key === "petty") return "bg-teal-600";
  if (key === "not_cost") return "bg-sky-600";
  if (key === "personal") return "bg-slate-500";
  if (key === "need") return "bg-amber-200";
  return "bg-slate-300";
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

function Row({
  row,
  picked,
  onPick,
  others,
  working,
}: {
  row: BankRowView;
  picked: string | undefined;
  onPick: (id: string | undefined) => void;
  others: { id: string; label: string }[];
  working: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pickedLabel = picked ? (row.buttons.find((b) => b.id === picked)?.label ?? others.find((o) => o.id === picked)?.label ?? picked) : null;
  const offList = picked && !row.buttons.some((b) => b.id === picked);
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
      <div className="flex flex-wrap gap-2">
        {row.buttons.map((b) => (
          <Button
            key={b.id}
            variant={picked === b.id ? "primary" : "outline"}
            aria-pressed={picked === b.id}
            onClick={() => onPick(picked === b.id ? undefined : b.id)}
            disabled={working}
            title={b.id === row.guess ? "The app's guess. Tap it if it's right." : undefined}
          >
            {picked === b.id && <Check />} {b.label}
            {b.id === row.guess && (
              <span className="rounded bg-amber-100 px-1 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                Guess
              </span>
            )}
          </Button>
        ))}
        {offList && (
          <Button variant="primary" aria-pressed onClick={() => onPick(undefined)} disabled={working}>
            <Check /> {pickedLabel}
          </Button>
        )}
        <Button variant="outline" onClick={() => setOpen((o) => !o)} disabled={working} aria-expanded={open}>
          Other…
        </Button>
        {picked && (
          <Button variant="outline" onClick={() => onPick(undefined)} disabled={working}>
            Not Now
          </Button>
        )}
      </div>
      {open && (
        <Select
          className="h-11 w-full sm:w-80"
          value={picked ?? ""}
          aria-label={`Where ${row.title} goes`}
          onChange={(e) => {
            onPick(e.target.value || undefined);
            setOpen(false);
          }}
          disabled={working}
        >
          <option value="">Not Now</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </li>
  );
}

/** The picks for rows still on the card: a row the books took away since keeps no answer. */
export function livePicks(picks: Record<string, string>, rows: readonly { id: string }[]): Record<string, string> {
  return Object.fromEntries(Object.entries(picks).filter(([id]) => rows.some((r) => r.id === id)));
}

export function BankCard({ itemId, view, run, busy, working }: { itemId: string; view: BankView | null | undefined; run: Run; busy: string | null; working: boolean }) {
  const router = useRouter();
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [four, setFour] = useState("");

  const notNow = (
    <Button variant="outline" onClick={() => run("keep", () => keepPaperwork(itemId), "Set aside.")} disabled={working} title="Set it aside in Organize's Archive">
      <Archive /> Not Now
    </Button>
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
  const answered = view.rows.filter((r) => live[r.id]).length;
  const leftRows = view.rows.length - answered;
  const sorted = view.counts.matched + view.counts.ruled;
  const canApply = sorted + answered > 0;
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
      <FlowBar flow={view.flow} outCents={view.outCents} />
      {view.appliedSaid && <p className="text-xs text-slate-600">{view.appliedSaid}</p>}
      {view.rows.length > 0 && <p className="text-xs text-slate-500">A button marked Guess is the app&apos;s guess. Nothing counts until you tap one.</p>}
      {view.rows.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 px-3">
          {view.rows.map((r) => (
            <Row
              key={r.id}
              row={r}
              picked={picks[r.id]}
              onPick={(id) =>
                setPicks((all) => {
                  const next = { ...all };
                  if (id) next[r.id] = id;
                  else delete next[r.id];
                  return next;
                })
              }
              others={r.direction === "in" ? (r.single ? view.otherInSingle : view.otherIn) : view.otherOut}
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
        {/* EVERY LINE ALREADY IN NORTH (the same month downloaded again): nothing to write, one tap
            puts the card away. */}
        {!canApply && view.rows.length === 0 ? (
          <Button onClick={() => run("keep", () => keepPaperwork(itemId), "Nothing new in it. Set aside.")} disabled={working}>
            {busy === "keep" ? <Loader2 className="animate-spin" /> : <Check />} Done: Nothing New
          </Button>
        ) : (
          notNow
        )}
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
              Matched means it is already in North (a payment, a bill, a supplier or crew payment): Apply only marks it, never adds it again. Owner&apos;s Draw and Personal are kept as the bank line only, never a cost.
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
