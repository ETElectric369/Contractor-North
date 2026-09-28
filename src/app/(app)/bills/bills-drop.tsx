"use client";

import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { WhyFold } from "@/components/why-fold";
import { useFileDragActive } from "@/components/drop-target";
import { PaperworkList, type PaperRowItem } from "@/components/paperwork-row";
import { SnapLinesList, clearFinishedSnapLines, openSnapOrNote, snapFiles, useSnapLines } from "@/components/snap-or-note";
import type { NumberMatch } from "@/lib/paperwork";

/**
 * THE BILLS PAGE'S HALF OF THE ONE PAPER DOOR (W1-30; it was Drop Paperwork, Justin 2026-09-24:
 * "drop PDF/JPEG/PNG onto Bills & Purchasing and have it parsed").
 *
 * The queue is Snap Or Note's now (components/snap-or-note: the + in the top bar, on every page):
 * one set of rules for a photo, a PDF, a supplier's list or a bank download, whichever way it came
 * in. This page keeps two things of its own:
 *
 *   · THE PAGE-WIDE DROP: drag any number of files anywhere onto the page on a desktop or an iPad,
 *     and every one goes to the same queue (snapFiles). Nothing is filtered out here, so a file the
 *     queue can't take gets its own line saying so by name instead of vanishing.
 *   · SORT THESE: the queue's lines where they always were, then every paper waiting for a person's
 *     answer. Add More opens the sheet. Nothing is filed until a person taps an answer on a card.
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

/** What happened to each file, then every paper waiting for an answer. */
export function SortThese({
  items,
  jobs,
  matches,
  shopStock = true,
}: {
  items: PaperRowItem[];
  jobs: { id: string; job_number: string; name: string }[];
  matches: Record<string, NumberMatch[]>;
  /** The Shop Stock switch (0352): off, and no card offers stock. Absent = on. */
  shopStock?: boolean;
}) {
  const lines = useSnapLines();
  if (!items.length && !lines.length) return null;
  const done = lines.some((l) => l.tone !== "busy");
  return (
    <Card className="mb-6 p-4" id="sort-these">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold text-slate-900">
          Sort These{items.length ? ` (${items.length})` : ""}
        </h2>
        <Button variant="outline" onClick={openSnapOrNote}>
          <FileUp /> Add More
        </Button>
      </div>
      {lines.length > 0 && (
        <div className="mb-3">
          <SnapLinesList lines={lines} />
        </div>
      )}
      {done && (
        <div className="mb-3">
          <Button variant="outline" onClick={clearFinishedSnapLines}>
            Clear Finished Lines
          </Button>
        </div>
      )}
      <WhyFold className="mb-2">
        <p>
          Nothing here is filed until you tap an answer on its card: a job, stock or a business cost. Undo takes it back. The
          same file is never filed twice, and a number already on the books offers to tie them together instead of making a
          second bill.
        </p>
      </WhyFold>
      <PaperworkList
        items={items}
        jobs={jobs}
        matches={matches}
        shopStock={shopStock}
        empty={<p className="py-4 text-center text-sm text-slate-400">Everything put in here is sorted.</p>}
      />
    </Card>
  );
}
