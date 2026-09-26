"use client";

import { useState, useTransition } from "react";
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

type UndoToken = NonNullable<SupplierActionResult["undo"]>;
type Done = { card: SupplierPaperCard; message: string; undo?: UndoToken; error?: string };

/** "in progress" reads "In Progress" on a chip: every clickable is Title Case. */
const titleCase = (s: string | null | undefined) =>
  String(s ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

/** What the card's headline says the paper names: CED's own words, or where it already sits. */
function saysLine(c: SupplierPaperCard): string {
  if (c.said) return `It Says ${c.said}`;
  if (c.state === "record" && c.onJob) return `It's On ${c.onJob.label}`;
  return "No Job Name On It";
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
}: {
  feed: SupplierPaperFeed;
  /** /bills refreshes so its other lists follow; My Day keeps the done line in place instead. */
  refreshAfter?: boolean;
  /** Said when nothing is waiting (never a blank box). */
  emptyLabel?: string;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, Done>>({});
  const [open, setOpen] = useState<Record<string, "job" | "bucket" | undefined>>({});
  /** What he has picked in a card's picker, before he presses. Nothing is preselected, ever. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [shelf, setShelf] = useState<{ card: SupplierPaperCard; lines: ShelfCountLine[]; total: number } | null>(null);

  const cards = feed?.cards ?? [];
  const jobs = feed?.jobs ?? [];
  const inFeed = new Set(cards.map((c) => c.invoiceId));
  // A paper filed and then refreshed away still owes its done line (and its Undo) somewhere.
  const doneElsewhere = Object.values(done).filter((d) => !inFeed.has(d.card.invoiceId));

  function settle(card: SupplierPaperCard, res: SupplierActionResult, fallback: string) {
    setBusy(null);
    if (!res.ok) {
      setErrors((e) => ({ ...e, [card.invoiceId]: res.error ?? "That didn't save. Nothing was filed." }));
      // A refusal is often news the card did not have yet (a bill that may be this purchase landed
      // since the page loaded): fresh cards bring its Same Purchase: Tie Them with them.
      router.refresh();
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
          // He read "maybe already in your books" on this card and pressed an answer anyway.
          differentPurchase: card.samePurchase.length > 0,
        });
        settle(card, res, `${card.invoiceNumber} is in your books now.`);
      } catch {
        settle(card, { ok: false, error: "The connection dropped, so nothing was filed. Try again." }, "");
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

  const jobButton = (card: SupplierPaperCard, job: PaperJob, text: string, variant: "primary" | "outline") => (
    <Button
      key={job.id}
      type="button"
      variant={variant}
      disabled={busy === card.invoiceId}
      onClick={() => file(card, { jobId: job.id })}
      title={job.name}
    >
      {text}
    </Button>
  );

  function picker(card: SupplierPaperCard) {
    // His best guesses first, then everything else, so the job he wants is near the top whether
    // or not the matcher liked it. Nothing selected until he selects it.
    const first = [card.suggestion, ...card.candidates].filter(Boolean) as PaperJob[];
    const firstIds = new Set(first.map((j) => j.id));
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
    return (
      <div key={c.invoiceId} className="rounded-lg border border-slate-200 bg-white p-3">
        <p className="text-sm font-semibold text-slate-900">
          {c.supplier} Sent A Bill · {formatCurrency(c.total)} · {saysLine(c)}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {c.invoiceNumber} · {formatDateShort(c.date)} · {c.closed ? "the supplier shows it paid" : "still open with the supplier"}
          {c.state === "record" && c.onJob ? ` · on ${[c.onJob.label, c.onJob.name].filter(Boolean).join(" ")}, with no bill yet` : ""}
        </p>
        {c.state === "needs_job" && <p className="mt-0.5 text-xs text-slate-400">{c.because}</p>}

        {c.samePurchase.length > 0 && (
          <div className="mt-2 space-y-2 rounded-md border border-amber-200 bg-amber-50 p-2">
            {c.samePurchase.slice(0, 2).map((s) => (
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
            c.candidates.map((j) => jobButton(c, j, [j.label, titleCase(j.status)].filter(Boolean).join(" · "), "outline"))}
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

  return (
    <div className="space-y-2">
      {emptyLabel && cards.length === 0 && doneElsewhere.length === 0 && <p className="text-sm text-slate-500">{emptyLabel}</p>}
      {doneElsewhere.map(doneLine)}
      {cards.map(cardView)}
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
              differentPurchase: card.samePurchase.length > 0,
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
