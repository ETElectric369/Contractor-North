"use client";

import { Archive, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { keepPaperwork } from "@/app/(app)/organize/paperwork-actions";
import { deleteOrganizedItem } from "@/app/(app)/organize/actions";

/**
 * ── WHAT ELSE A STATEMENT'S CARD CAN DO, AND WHERE THE PAPER GOES (2026-10-03) ─────────────────
 *
 * Erik dropped a statement, wanted to bin it, and could not. Both these cards offered Apply and one
 * put-it-away button and nothing else: `paperMenuRows` only offers Delete on a paper the update cannot
 * file, and neither card draws the ⋯ menu at all (a bank download's and an open list's row return
 * early, on purpose — nothing else on those rows applies). So the only way out was Not Now, which
 * archived it without a word on the card about where it went, and he could not find it again.
 *
 * TWO DOORS AND ONE LINE, IN ONE PLACE BECAUSE BOTH CARDS NEED THE SAME PAIR:
 *
 *  · PUT IT AWAY, with the destination said on the card rather than in a tooltip (a tooltip does not
 *    exist on a phone) and rather than only in a toast (gone before it is read). NOTHING SILENT.
 *  · DELETE, behind a confirm, through the same `deleteOrganizedItem` every other paper's Delete uses
 *    — so whatever it filed comes down with it, by the one function that knows how.
 *
 * IT RENDERS INSIDE THE CARD'S OWN `flex flex-wrap gap-2` ROW, which is why the sentence is `w-full`:
 * it wraps onto its own line under the buttons wherever the card puts these.
 */

/** The card's one write path (paperwork-row's `run`): `gone` is a write with no Undo. */
type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, filedSentence?: string, gone?: string) => void;

export function NotNowOrDelete({
  itemId,
  what,
  label,
  run,
  working,
}: {
  itemId: string;
  /** What is being put away or deleted, in his words: "statement", "download". */
  what: string;
  /** The put-it-away button's words: "Not Now" on an open list, "Set Aside" on a download. */
  label: string;
  run: Run;
  working: boolean;
}) {
  return (
    <>
      <Button variant="outline" onClick={() => run("keep", () => keepPaperwork(itemId), "Kept in files.")} disabled={working}>
        <Archive /> {label}
      </Button>
      <Button
        variant="outline"
        onClick={() => {
          // ASKED FIRST, AND THE QUESTION SAYS WHAT GOES. Delete cannot be undone, so the confirm names
          // the paper and its file rather than asking "are you sure?" about nothing in particular.
          if (confirm(`Delete this ${what}? It goes for good, with its file, and nothing it would have changed is written.`)) {
            run("delete", () => deleteOrganizedItem(itemId), undefined, "Deleted.");
          }
        }}
        disabled={working}
      >
        <Trash2 /> Delete
      </Button>
      <p className="w-full text-xs text-slate-500">
        {label} keeps it in Organize, under Archive, and you can bring it back. Delete removes it and its file for good.
      </p>
    </>
  );
}
