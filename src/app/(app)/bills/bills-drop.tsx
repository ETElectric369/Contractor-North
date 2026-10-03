"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useFileDragActive } from "@/components/drop-target";
import { PaperworkList, type PaperRowItem } from "@/components/paperwork-row";
import { SnapLinesList, clearFinishedSnapLines, snapFiles, useSnapLines } from "@/components/snap-or-note";
import type { NumberMatch } from "@/lib/paperwork";

/**
 * THE BILLS PAGE'S HALF OF THE ONE PAPER DOOR (W1-30; it was Drop Paperwork, Justin 2026-09-24:
 * "drop PDF/JPEG/PNG onto Bills & Purchasing and have it parsed").
 *
 * The queue is Snap Or Note's (components/snap-or-note: the + in the top bar, on every page): one
 * set of rules for a photo, a PDF, a supplier's list or a bank download, whichever way it came in.
 * This page keeps two things of its own:
 *
 *   · THE PAGE-WIDE DROP: drag any number of files anywhere onto the page on a desktop or an iPad,
 *     and every one goes to the same queue (snapFiles). Nothing is filtered out here, so a file the
 *     queue can't take gets its own line saying so by name instead of vanishing.
 *   · NEEDS YOU (W1-32; it was Sort These, a card of its own beside Needs You): the queue's lines,
 *     then every paper waiting for a person's answer, then the supplier's bills not in the books.
 *     Nothing is filed until a person taps an answer on a card.
 */

const STRIPES = {
  backgroundImage:
    "repeating-linear-gradient(45deg, transparent 0 10px, color-mix(in srgb, var(--color-brand) 10%, transparent) 10px 20px)",
} as const;

export function PaperworkDropZone({ children }: { children: React.ReactNode }) {
  const dragging = useFileDragActive();
  return (
    <>
      {children}
      {/* PAGE-WIDE, AND FIXED TO THE SCREEN. A wrapper zone the height of this page put its label
          halfway down a long list, off screen. This covers the viewport while a file is dragged
          anywhere over the window, and hands EVERY file to the queue. No stopPropagation, so the
          window's own drop listener still clears the drag state. */}
      {dragging && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center border-4 border-dashed border-brand bg-white/90 p-4"
          style={STRIPES}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            snapFiles(Array.from(e.dataTransfer?.files ?? []));
          }}
        >
          <span className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-brand shadow">Drop Papers Here</span>
        </div>
      )}
    </>
  );
}

/**
 * NEEDS YOU: ONE CARD FOR EVERYTHING WAITING ON A PERSON (W1-32). In order: what happened to each file
 * just dropped (with Clear Finished Lines), every dropped paper waiting for its answer (a receipt, a
 * bill, a supplier invoice or a picture: the paper card), then the supplier's bills not in the books
 * (`supplier`, drawn by the page: the cards and their Waiting On A Credit lines, or the sentence saying
 * they couldn't be checked).
 *
 * A BANK DOWNLOAD AND A SUPPLIER'S OPEN LIST ARE NOT HERE ANY MORE (2026-10-03, Erik: "so it still
 * doesnt make sense to me that all this reconcile stuff is on the bills page"). They compare two
 * records rather than becoming a cost, so they are answered on /reconcile, where they are dropped
 * (lib/paperwork answeredOnReconcile). `statementsElsewhere` is how this card stays honest about it:
 * one line pointing at them, so every door that lands on #sort-these — My Day's Papers To Sort, a
 * download's own drop line — still reaches the paper it came for instead of an empty card.
 *
 * The count is only what is open: the papers waiting HERE plus the supplier cards. A statement waiting
 * on another page is somebody's work but it is not this count's, so it is a line, never a number.
 *
 * Drawn once there is something in it: a paper, a line, supplier papers to speak for (`always`), or a
 * statement to point at. Once drawn it stays for the visit, so a card just answered keeps its Undo.
 */
export function NeedsYou({
  items,
  jobs,
  matches,
  shopStock = true,
  supplierCards = 0,
  always = false,
  supplier = null,
  emptyLine,
  trayUnread = false,
  statementsElsewhere = 0,
}: {
  items: PaperRowItem[];
  jobs: { id: string; job_number: string; name: string }[];
  matches: Record<string, NumberMatch[]>;
  /** The Shop Stock switch (0352): off, and no card offers stock. Absent = on. */
  shopStock?: boolean;
  /** The supplier's cards waiting for an answer (the feed's), for the count. */
  supplierCards?: number;
  /** The company has supplier papers (or a read of them failed and says so): draw the card anyway. */
  always?: boolean;
  /** The supplier's half, drawn by the page. */
  supplier?: ReactNode;
  /** Said when nothing is waiting; null when a read it speaks for failed (the card says that instead). */
  emptyLine: string | null;
  /** The read of the papers waiting to be sorted failed: said in words, never an empty card. */
  trayUnread?: boolean;
  /** Bank downloads and suppliers' open lists waiting on /reconcile: a line, never part of the count. */
  statementsElsewhere?: number;
}) {
  const lines = useSnapLines();
  const open = items.length + supplierCards;
  const show = open > 0 || lines.length > 0 || always || statementsElsewhere > 0;
  const [seen, setSeen] = useState(show);
  useEffect(() => {
    if (show) setSeen(true);
  }, [show]);
  if (!show && !seen) return null;
  const done = lines.some((l) => l.tone !== "busy");
  return (
    <Card className="mb-6 scroll-mt-20 p-4" id="needs-you">
      <h2 className="text-base font-semibold text-slate-900">Needs You{open ? ` (${open})` : ""}</h2>
      <p className="mt-0.5 text-xs text-slate-500">Paper to sort and supplier bills not in your books yet.</p>
      {/* Where My Day's Papers To Sort lands. (A bank download is answered on Reconcile since
          2026-10-03, and the link that used to say "Open Needs You" is gone: this card draws the
          pointer line to that page, never the download's own card.) */}
      <span id="sort-these" className="block scroll-mt-20" />
      {lines.length > 0 && (
        <div className="mt-3">
          <SnapLinesList lines={lines} />
        </div>
      )}
      {done && (
        <div className="mt-2">
          <Button variant="outline" onClick={clearFinishedSnapLines}>
            Clear Finished Lines
          </Button>
        </div>
      )}
      <div className="mt-3 space-y-3">
        {trayUnread && (
          <p className="text-sm text-amber-800" role="alert">
            Couldn&apos;t read the papers waiting to be sorted just now. Reload the page to try again.
          </p>
        )}
        <PaperworkList items={items} jobs={jobs} matches={matches} shopStock={shopStock} />
        {/* NOT A DEAD END. The paper is real and it is one tap away, on the page it is answered on. */}
        {statementsElsewhere > 0 && (
          <a
            href="/reconcile#bring-in-a-statement"
            className="flex min-h-11 items-center text-sm font-medium text-brand hover:underline"
          >
            {statementsElsewhere === 1
              ? "A Statement Is Waiting On Reconcile"
              : `${statementsElsewhere} Statements Are Waiting On Reconcile`}
          </a>
        )}
        {supplier}
        {emptyLine && open === 0 && lines.length === 0 && <p className="text-sm text-slate-500">{emptyLine}</p>}
      </div>
    </Card>
  );
}
