"use client";

import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { ShelfTicketSheet, type ShelfCountLine } from "@/components/shelf-count";
import { formatCurrency, formatDateShort } from "@/lib/utils";
import { BUSINESS_COST_BUCKETS } from "@/lib/business-cost-buckets";
import type { SupplierPaperFeed } from "@/app/(app)/bills/supplier-papers";
import type { PaperJob, SupplierPaperCard } from "@/app/(app)/bills/supplier-reconcile";
import type { SupplierActionResult } from "@/app/(app)/bills/supplier-balance";
import {
  fileSupplierPaper,
  recordSupplierInvoiceToShelf,
  supplierInvoiceShelfLines,
  tieSupplierInvoiceToBill,
  undoFileSupplierPaper,
} from "@/app/(app)/bills/supplier-actions";
import { supplierPaperContents } from "@/app/(app)/bills/paper-contents-action";
import { offLinesWords, type PaperContents } from "@/lib/supplier-paper-contents";

type UndoToken = NonNullable<SupplierActionResult["undo"]>;
/** What's On It, per card: reading, read, or a read that failed (said, with Try Again). */
export type PaperContentsState = { state: "loading" } | { state: "error"; error: string } | { state: "ok"; contents: PaperContents };
type Done = { card: SupplierPaperCard; message: string; undo?: UndoToken; error?: string };

/** "in progress" reads "In Progress" on a chip: every clickable is Title Case. */
const titleCase = (s: string | null | undefined) =>
  String(s ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

/**
 * WHAT A CHIP SAYS BEYOND ITS NUMBER (review of Wave A). "J-033 · Complete" and "J-006 · Complete"
 * read the same on a phone, where a `title` never shows. So a chip carries the job's name when it
 * is not the name the others share ("J-034 · Panel Upgrade", "J-047 · Jackie Burks"), and the day
 * the job was made, which is what tells two "5659 Rhodesia, complete" jobs apart.
 */
const squash = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function chipNames(said: string | null, jobs: PaperJob[]): Map<string, string | null> {
  const names = jobs.map((j) => String(j.name ?? "").trim());
  // The name that says nothing new: CED's own words when a job carries them, else the most common.
  const counts = new Map<string, number>();
  for (const n of names) if (squash(n)) counts.set(squash(n), (counts.get(squash(n)) ?? 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? "";
  const base = said && counts.has(squash(said)) ? squash(said) : common;
  const out = new Map<string, string | null>();
  for (const j of jobs) {
    const name = String(j.name ?? "").trim();
    const n = squash(name);
    if (!n || n === base) {
      out.set(j.id, null);
      continue;
    }
    // "5659 Rhodesia - Panel Upgrade" beside "5659 Rhodesia" says only "Panel Upgrade".
    let rest = name;
    if (base && n.startsWith(`${base} `)) {
      // Walk his own words until the shared ones are used up; what is left is the news.
      const tokens = name.split(/\s+/);
      let need = base.split(" ").length;
      let i = 0;
      while (i < tokens.length && need > 0) need -= squash(tokens[i++]).split(" ").filter(Boolean).length;
      rest = tokens.slice(i).join(" ");
    }
    out.set(j.id, rest.replace(/^[\s\-–—·:,]+/, "").trim() || null);
  }
  return out;
}

/** "Opened Jun 11": the day a job was made, in his own day. */
const openedWords = (j: PaperJob) => (j.opened ? `Opened ${formatDateShort(j.opened)}` : "");

// ── THE DONE LINES, KEPT PAST THE LIST THAT HELD THEM (review of Wave A) ─────────────────────────
//
// On My Day the cards ride inside the "Supplier Bills" line, and filing the LAST paper removes
// that line (the server's fresh list has nothing waiting), unmounting these cards and, with them,
// the sentence and the Undo he was owed. A scoped store keeps the done lines outside any one
// mount, and SupplierPaperDoneTrail shows them where the line was while no card set is on screen.
// Without a `scope` a card set keeps its own (the /bills list never vanishes).

type Scope = { done: Record<string, Done>; live: number };
/** My Day's scope: its rollup's cards and the trail under them share it. */
export const SUPPLIER_PAPERS_SCOPE = "my-day";
const EMPTY_DONE: Record<string, Done> = {};
/** One frozen "nothing kept" answer: useSyncExternalStore needs the same object back each time. */
const EMPTY_SCOPE: Scope = { done: EMPTY_DONE, live: 0 };
const scopes = new Map<string, Scope>();
const listeners = new Set<() => void>();
const scopeOf = (key: string) => scopes.get(key) ?? EMPTY_SCOPE;
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
function putScope(key: string, next: Partial<Scope>) {
  scopes.set(key, { ...scopeOf(key), ...next });
  emit();
}
/** Tests only: set what a scope holds, as a tap and a mount would. */
export const setSupplierPaperScopeForTest = putScope;

/** What the card's headline says the paper names: CED's own words, or where it already sits. */
function saysLine(c: SupplierPaperCard): string {
  if (c.said) return `It Says ${c.said}`;
  if (c.state === "record" && c.onJob) return `It's On ${c.onJob.label}`;
  return "No Job Name On It";
}

/**
 * WHAT'S ON IT (Erik, 2026-09-26: "i need to open the bill to see whats on it to be able to approve
 * or deny"). The paper's own lines, drawn under the card's headline and above every answer, so he
 * sees what CED sent before he says what it was for. Quantity and EXTENSION only (the extension is
 * the price: CED prices per hundred and per thousand); a $0.00 line says Not Shipped. Then Tax and
 * the Total, which is the card's own amount, and any money that is on no line is said, never
 * hidden. A read that failed says so, with Try Again.
 */
export function PaperContentsView({ cardTotal, view, onRetry }: { cardTotal: number; view: PaperContentsState; onRetry: () => void }) {
  if (view.state === "loading") {
    return (
      <p className="mt-2 text-xs text-slate-500" role="status">
        Reading What&apos;s On It…
      </p>
    );
  }
  if (view.state === "error") {
    return (
      <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2" role="alert">
        <p className="text-xs text-red-700">It couldn&apos;t read what&apos;s on this paper. {view.error}</p>
        <Button type="button" variant="outline" className="mt-2" onClick={onRetry}>
          Try Again
        </Button>
      </div>
    );
  }
  const c = view.contents;
  const gap = offLinesWords(c);
  const row = (label: string, amount: number, strong = false) => (
    <div className={`flex items-baseline justify-between gap-3 py-1 ${strong ? "font-semibold text-slate-900" : ""}`}>
      <span>{label}</span>
      <span className="shrink-0 tabular-nums">{formatCurrency(amount)}</span>
    </div>
  );
  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">
      {c.lines.length === 0 && <p className="py-1">No lines are on file for this one.</p>}
      {c.lines.length > 0 && (
        <ul className="divide-y divide-slate-200">
          {c.lines.map((l) => (
            <li key={l.key} className="flex items-start justify-between gap-3 py-1">
              <span className="min-w-0 break-words">{l.what}</span>
              {l.notShipped ? (
                <span className="shrink-0 font-medium text-amber-700">Not Shipped</span>
              ) : (
                <span className="shrink-0 tabular-nums">{formatCurrency(l.amount)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-slate-300">
        {c.shipping !== 0 && row("Shipping", c.shipping)}
        {row("Tax", c.tax)}
        {row("Total", c.total, true)}
      </div>
      {gap && <p className="py-1 text-amber-800">{gap}</p>}
      {Math.round(c.total * 100) !== Math.round(cardTotal * 100) && (
        <p className="py-1 text-amber-800">This paper changed since the page loaded. Reload the page to see it fresh.</p>
      )}
      {c.pdfUrl ? (
        <a href={c.pdfUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
          Open The PDF
        </a>
      ) : (
        c.pdfNote && <p className="py-1 text-slate-500">{c.pdfNote}</p>
      )}
    </div>
  );
}

/**
 * "HEY YOU, HERE'S A BILL, WHAT'S IT FOR?" (Bills plan, Wave A, 2026-09-25).
 *
 * One card per supplier paper nobody has put in the books, the same cards on My Day and on /bills
 * (both are fed by supplierPaperFeed). The card asks the one question and every answer is one tap:
 *
 *   CED Sent A Bill · $301.81 · It Says 13897 HERRINGBONE
 *   [Put It On J-011] [Another Job] [Shop Stock] [Business Cost]
 *
 * THE APP SUGGESTS, A PERSON DECIDES. The matcher's clear guess is the first button and nothing is
 * ever preselected; when several jobs match just as well (the Rhodesias) they are chips and none is
 * first; when there is nothing to go on it says Pick A Job. Every tap says what it did, with Undo
 * while no customer invoice has claimed the bill. Staff only: these carry prices.
 */
export function SupplierPaperCards({
  feed,
  refreshAfter = true,
  emptyLabel,
  scope,
  trail = false,
  limit,
  moreHref,
}: {
  feed: SupplierPaperFeed;
  /** /bills refreshes so its other lists follow; My Day keeps the done line in place instead. */
  refreshAfter?: boolean;
  /** Said when nothing is waiting (never a blank box). */
  emptyLabel?: string;
  /** Keeps the done lines (and their Undo) past this mount; see SupplierPaperDoneTrail. */
  scope?: string;
  /** SupplierPaperDoneTrail's mode: only the kept done lines, and only while no card set is up. */
  trail?: boolean;
  /**
   * How many waiting cards to draw (My Day: one, readable at 60mph). The rest are one plain line
   * and a link to where they all are (`moreHref`). Absent: every card.
   */
  limit?: number;
  moreHref?: string;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [ownDone, setOwnDone] = useState<Record<string, Done>>({});
  // The same answer on the server: nothing there ever writes the store (only taps and mounts do),
  // so it is always EMPTY_SCOPE at render and hydration cannot disagree.
  const keptOf = () => (scope ? scopeOf(scope) : null);
  const kept = useSyncExternalStore(subscribe, keptOf, keptOf);
  const done = scope ? (kept?.done ?? EMPTY_DONE) : ownDone;
  const setDone = (fn: (d: Record<string, Done>) => Record<string, Done>) => {
    if (scope) putScope(scope, { done: fn(scopeOf(scope).done) });
    else setOwnDone(fn);
  };
  // A card set on screen says so, so the trail stays out of its way. The trail itself, leaving the
  // page, lets the kept lines go: they belong to this visit.
  useEffect(() => {
    if (!scope) return;
    if (trail) return () => putScope(scope, { done: EMPTY_DONE });
    putScope(scope, { live: scopeOf(scope).live + 1 });
    return () => putScope(scope, { live: Math.max(0, scopeOf(scope).live - 1) });
  }, [scope, trail]);
  const [open, setOpen] = useState<Record<string, "job" | "bucket" | undefined>>({});
  /** What he has picked in a card's picker, before he presses. Nothing is preselected, ever. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [shelf, setShelf] = useState<{ card: SupplierPaperCard; lines: ShelfCountLine[]; total: number } | null>(null);
  /** What's On It: which cards have it open, and what each read brought back (kept for a re-open). */
  const [reading, setReading] = useState<Record<string, boolean>>({});
  const [contents, setContents] = useState<Record<string, PaperContentsState>>({});

  function readContents(card: SupplierPaperCard) {
    const id = card.invoiceId;
    setContents((c) => ({ ...c, [id]: { state: "loading" } }));
    supplierPaperContents(id).then(
      (res) =>
        setContents((c) => ({
          ...c,
          [id]: res.ok ? { state: "ok", contents: res.contents } : { state: "error", error: res.error },
        })),
      () => setContents((c) => ({ ...c, [id]: { state: "error", error: "The connection dropped before the lines came back." } })),
    );
  }

  function toggleContents(card: SupplierPaperCard) {
    const id = card.invoiceId;
    const opening = !reading[id];
    setReading((r) => ({ ...r, [id]: opening }));
    // A read that came back is kept; one that failed (or never ran) is asked again.
    const had = contents[id]?.state;
    if (opening && had !== "ok" && had !== "loading") readContents(card);
  }

  const cards = trail ? [] : (feed?.cards ?? []);
  const jobs = feed?.jobs ?? [];
  // Every done line, in the order they were answered: a paper filed and then refreshed away still
  // owes its sentence (and its Undo) somewhere, and one still in the list shows it in its place.
  const doneLines = Object.values(done);
  const waiting = cards.filter((c) => !done[c.invoiceId]);
  const shown = limit != null && limit >= 0 ? waiting.slice(0, limit) : waiting;
  const moreCount = waiting.length - shown.length;

  function settle(card: SupplierPaperCard, res: SupplierActionResult, fallback: string, refresh = true) {
    setBusy(null);
    if (!res.ok) {
      setErrors((e) => ({ ...e, [card.invoiceId]: res.error ?? "That didn't save. Nothing was filed." }));
      // A refusal is often news the card did not have yet (a bill that may be this purchase landed
      // since the page loaded): fresh cards bring its Same Purchase: Tie Them with them.
      if (refresh) router.refresh();
      return;
    }
    setErrors((e) => ({ ...e, [card.invoiceId]: "" }));
    setOpen((o) => ({ ...o, [card.invoiceId]: undefined }));
    setDone((d) => ({ ...d, [card.invoiceId]: { card, message: res.message ?? fallback, undo: res.undo } }));
    if (refreshAfter) router.refresh();
  }

  function file(card: SupplierPaperCard, answer: { jobId: string } | { businessCost: string }) {
    setBusy(card.invoiceId);
    setErrors((e) => ({ ...e, [card.invoiceId]: "" }));
    start(async () => {
      try {
        const res = await fileSupplierPaper({
          invoiceId: card.invoiceId,
          ...answer,
          // He read "maybe already in your books" on this card and pressed an answer anyway: THOSE
          // bills, the ones drawn above, are set aside. Any other still stops it on the server.
          notSameAs: card.samePurchase.map((s) => s.billId),
        });
        settle(card, res, `${card.invoiceNumber} is in your books now.`);
      } catch {
        // The answer never came back, so nobody here knows what landed. The card stays put with the
        // truth (no refresh to whisk it away along with this sentence).
        settle(
          card,
          { ok: false, error: "The connection dropped before the answer came back. Reload the page to see whether it was filed." },
          "",
          false,
        );
      }
    });
  }

  function tie(card: SupplierPaperCard, billId: string) {
    setBusy(card.invoiceId);
    start(async () => {
      try {
        settle(card, await tieSupplierInvoiceToBill({ invoiceId: card.invoiceId, billId }), `${card.invoiceNumber} is tied to that bill.`);
      } catch {
        settle(card, { ok: false, error: "The connection dropped, so nothing was tied. Try again." }, "");
      }
    });
  }

  function openShelf(card: SupplierPaperCard) {
    setBusy(card.invoiceId);
    setErrors((e) => ({ ...e, [card.invoiceId]: "" }));
    start(async () => {
      try {
        const res = await supplierInvoiceShelfLines(card.invoiceId);
        setBusy(null);
        if (!res.ok) return setErrors((e) => ({ ...e, [card.invoiceId]: res.error }));
        setShelf({ card, lines: res.lines, total: res.total });
      } catch {
        setBusy(null);
        setErrors((e) => ({ ...e, [card.invoiceId]: "The connection dropped before the lines came back. Try again." }));
      }
    });
  }

  function undo(d: Done) {
    if (!d.undo) return;
    const token = d.undo;
    setBusy(d.card.invoiceId);
    start(async () => {
      let res: SupplierActionResult;
      try {
        res = await undoFileSupplierPaper(token);
      } catch {
        res = { ok: false, error: "The connection dropped, so nothing was undone. Try again." };
      }
      setBusy(null);
      if (!res.ok) {
        setDone((all) => ({ ...all, [d.card.invoiceId]: { ...d, error: res.error } }));
        return;
      }
      setDone((all) => {
        const next = { ...all };
        delete next[d.card.invoiceId];
        return next;
      });
      // The card comes back from the server, so the list and the badge agree with the books.
      router.refresh();
    });
  }

  const doneLine = (d: Done) => (
    <div key={`done-${d.card.invoiceId}`} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2" role="status">
      <p className="text-sm text-emerald-900">{d.message}</p>
      {d.error && <p className="mt-1 text-xs text-red-700" role="alert">{d.error}</p>}
      {d.undo && (
        <Button type="button" variant="outline" className="mt-2" disabled={busy === d.card.invoiceId} onClick={() => undo(d)}>
          Undo
        </Button>
      )}
    </div>
  );

  const jobButton = (card: SupplierPaperCard, job: PaperJob, text: string, variant: "primary" | "outline", className?: string) => (
    <Button
      key={job.id}
      type="button"
      variant={variant}
      disabled={busy === card.invoiceId}
      onClick={() => file(card, { jobId: job.id })}
      title={job.name}
      className={className}
    >
      {text}
    </Button>
  );

  function picker(card: SupplierPaperCard) {
    // His best guesses first, then everything else, so the job he wants is near the top whether
    // or not the matcher liked it. Nothing selected until he selects it.
    // A weak card's nearest jobs ride here too (card.closest), so "The closest are first" is true.
    const firstIds = new Set<string>();
    const first = ([card.suggestion, ...card.candidates, ...(card.closest ?? [])].filter(Boolean) as PaperJob[]).filter(
      (j) => !firstIds.has(j.id) && !!firstIds.add(j.id),
    );
    const rest = jobs.filter((j) => !firstIds.has(j.id));
    const value = picked[card.invoiceId] ?? "";
    const chosen = jobs.find((j) => j.id === value) ?? first.find((j) => j.id === value) ?? null;
    return (
      <div className="mt-2 space-y-2">
        <Select
          aria-label={`Which job was ${card.invoiceNumber} for?`}
          value={value}
          onChange={(e) => setPicked((p) => ({ ...p, [card.invoiceId]: e.target.value }))}
          className="min-h-11"
        >
          <option value="">— Pick The Job —</option>
          {first.length > 0 && (
            <optgroup label="Closest">
              {first.map((j) => (
                <option key={j.id} value={j.id}>
                  {[j.label, j.name, titleCase(j.status)].filter(Boolean).join(" · ")}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Every Job">
            {rest.map((j) => (
              <option key={j.id} value={j.id}>
                {[j.label, j.name, titleCase(j.status)].filter(Boolean).join(" · ")}
              </option>
            ))}
          </optgroup>
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!chosen || busy === card.invoiceId} onClick={() => chosen && file(card, { jobId: chosen.id })}>
            {chosen ? `Put It On ${chosen.label}` : "Put It On This Job"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen((o) => ({ ...o, [card.invoiceId]: undefined }))}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  function buckets(card: SupplierPaperCard) {
    return (
      <div className="mt-2 space-y-2">
        <p className="text-xs text-slate-500">The company&apos;s own, on no job. Which bucket?</p>
        <div className="flex flex-wrap gap-2">
          {BUSINESS_COST_BUCKETS.map((b) => (
            <Button key={b} type="button" variant="outline" disabled={busy === card.invoiceId} onClick={() => file(card, { businessCost: b })}>
              {b}
            </Button>
          ))}
          <Button type="button" variant="ghost" onClick={() => setOpen((o) => ({ ...o, [card.invoiceId]: undefined }))}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  function cardView(c: SupplierPaperCard) {
    const d = done[c.invoiceId];
    if (d) return doneLine(d);
    const showing = open[c.invoiceId];
    const toggle = (what: "job" | "bucket") => setOpen((o) => ({ ...o, [c.invoiceId]: o[c.invoiceId] === what ? undefined : what }));
    const hasGuess = c.state === "record" || !!c.suggestion || c.candidates.length > 0;
    const chips = chipNames(c.said, c.candidates);
    return (
      <div key={c.invoiceId} className="rounded-lg border border-slate-200 bg-white p-3">
        <p className="text-sm font-semibold text-slate-900">
          {c.supplier} Sent A Bill · {formatCurrency(c.total)} · {saysLine(c)}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {c.invoiceNumber} · {formatDateShort(c.date)} · {c.closed ? "the supplier shows it paid" : "still open with the supplier"}
          {c.state === "record" && c.onJob ? ` · on ${[c.onJob.label, c.onJob.name].filter(Boolean).join(" ")}, with no bill yet` : ""}
        </p>
        {c.state === "needs_job" && (
          <p className="mt-0.5 text-xs text-slate-400">
            {/* "The closest are first" only where the picker really has them first. */}
            {c.verdict === "weak" && !(c.closest ?? []).length ? c.because.replace(/\s*The closest are first\.$/, "") : c.because}
          </p>
        )}

        {/* WHAT'S ON IT comes before every answer: he sees the paper, then he decides. */}
        <div className="mt-2">
          <Button type="button" variant="outline" aria-expanded={!!reading[c.invoiceId]} onClick={() => toggleContents(c)}>
            {reading[c.invoiceId] ? "Hide What's On It" : "What's On It"}
          </Button>
        </div>
        {reading[c.invoiceId] && contents[c.invoiceId] && (
          <PaperContentsView cardTotal={c.total} view={contents[c.invoiceId]} onRetry={() => readContents(c)} />
        )}

        {c.samePurchase.length > 0 && (
          <div className="mt-2 space-y-2 rounded-md border border-amber-200 bg-amber-50 p-2">
            {/* Every one drawn: Different Purchase sets aside exactly the bills he was shown. */}
            {c.samePurchase.map((s) => (
              <div key={s.billId} className="space-y-1">
                <p className="text-xs text-amber-900">{s.sentence}</p>
                <Button type="button" variant="outline" disabled={busy === c.invoiceId} onClick={() => tie(c, s.billId)}>
                  Same Purchase: Tie Them
                </Button>
              </div>
            ))}
            <p className="text-xs text-amber-900">Any other button below records it as a different purchase.</p>
          </div>
        )}

        {c.candidates.length > 0 && <p className="mt-2 text-xs text-slate-500">It could be any of these. Only you know which:</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {c.state === "record" && c.onJob && jobButton(c, c.onJob, `Record It On ${c.onJob.label}`, "primary")}
          {c.state === "needs_job" && c.suggestion && jobButton(c, c.suggestion, `Put It On ${c.suggestion.label}`, "primary")}
          {c.state === "needs_job" &&
            c.candidates.map((j) =>
              jobButton(
                c,
                j,
                [j.label, titleCase(chips.get(j.id)), titleCase(j.status), openedWords(j)].filter(Boolean).join(" · "),
                "outline",
                "h-auto min-h-11 whitespace-normal py-2 text-left",
              ),
            )}
          <Button type="button" variant="outline" disabled={busy === c.invoiceId} onClick={() => toggle("job")}>
            {hasGuess ? "Another Job" : "Pick A Job"}
          </Button>
          <Button type="button" variant="outline" disabled={busy === c.invoiceId} onClick={() => openShelf(c)}>
            Shop Stock
          </Button>
          <Button type="button" variant="outline" disabled={busy === c.invoiceId} onClick={() => toggle("bucket")}>
            Business Cost
          </Button>
        </div>
        {showing === "job" && picker(c)}
        {showing === "bucket" && buckets(c)}
        {busy === c.invoiceId && <p className="mt-1 text-xs text-slate-500">Working…</p>}
        {errors[c.invoiceId] && (
          <p className="mt-2 text-xs text-red-700" role="alert">
            {errors[c.invoiceId]}
          </p>
        )}
      </div>
    );
  }

  // The trail steps aside while a card set is on screen (it shows the same lines itself).
  if (trail && (!doneLines.length || (kept?.live ?? 0) > 0)) return null;

  return (
    <div className={trail ? "mb-4 space-y-2" : "space-y-2"}>
      {emptyLabel && waiting.length === 0 && doneLines.length === 0 && <p className="text-sm text-slate-500">{emptyLabel}</p>}
      {doneLines.map(doneLine)}
      {shown.map(cardView)}
      {moreCount > 0 && moreHref && (
        <Link href={moreHref} className="flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
          {`See ${moreCount} More Supplier Bill${moreCount === 1 ? "" : "s"}`}
        </Link>
      )}
      {shelf && (
        <ShelfTicketSheet
          title={`Record ${shelf.card.invoiceNumber} To The Shelf`}
          lines={shelf.lines}
          total={shelf.total}
          fileLabel="Record To Shelf"
          onClose={() => setShelf(null)}
          onFile={async (choices) => {
            const card = shelf.card;
            const res = await recordSupplierInvoiceToShelf({
              invoiceId: card.invoiceId,
              notSameAs: card.samePurchase.map((s) => s.billId),
              toShelf: choices,
            });
            if (!res.ok) return { ok: false, error: res.error };
            setShelf(null);
            // No Undo here: its rolls come off the shelf with Take It Off The Shelf, on /bills.
            settle(card, res, `${card.invoiceNumber} is on the shop shelf now.`);
            return { ok: true };
          }}
        />
      )}
    </div>
  );
}

/**
 * WHERE MY DAY'S DONE LINES LAND WHEN THE "SUPPLIER BILLS" LINE IS GONE. Filing the last paper
 * clears the line (and its cards) at once; this keeps "8802-... is a bill on J-011 now" and its
 * Undo on screen until he leaves the page. Renders nothing while a card set of the same scope is up.
 */
export function SupplierPaperDoneTrail({ scope }: { scope: string }) {
  return <SupplierPaperCards feed={{ cards: [], jobs: [] }} scope={scope} trail refreshAfter={false} />;
}
