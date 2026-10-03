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
 *
 * ── AND THE CONFIRM SAYS WHAT COMES OFF THE BOOKS (review, 2026-10-03) ─────────────────────────
 *
 * "nothing it would have changed is written" was ONE fixed string for every state, and on a bank
 * download that was PART-APPLIED it was the opposite of the truth: `deleteOrganizedItem` runs
 * `undoBankCore` first, which deletes the bills and the payments that Apply wrote on invoices, voids
 * the supplier and crew payments, and drops the learned rules. Apply 30 of 40 lines, tap Delete to bin
 * the leftovers, accept a confirm that mentions neither, and the customer's payments come off. The only
 * word about it arrived AFTER, in a toast. So the card that knows its state hands in the sentence for
 * it (`alsoTakesBack`), in the same words its own Undo confirm already uses.
 */

/** The card's one write path (paperwork-row's `run`): `gone` is a write with no Undo. */
type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, filedSentence?: string, gone?: string) => void;

export function NotNowOrDelete({
  itemId,
  what,
  label,
  keptSaid = "Kept in files.",
  alsoTakesBack,
  run,
  working,
}: {
  itemId: string;
  /** What is being put away or deleted, in his words: "statement", "download". */
  what: string;
  /** The put-it-away button's words: "Not Now" on an open list, "Set Aside" on a download, "Done:
   *  Nothing New" on a download whose every line is already in North. ONE put-away door per state, never
   *  two buttons that archive the same paper in different words. */
  label: string;
  /** What that button's card line says afterwards. Default: the plain "Kept in files." */
  keptSaid?: string;
  /**
   * WHAT DELETE WOULD ALSO TAKE BACK, as one clause, when this paper has already written something (a
   * part-applied bank download). The CARD knows that, not this component, so the card says it — and
   * when nothing is written the sentence stays the plain one it always was.
   */
  alsoTakesBack?: string | null;
  run: Run;
  working: boolean;
}) {
  /** The card's clause, trimmed of a full stop so it can sit inside either sentence below. */
  const clause = alsoTakesBack?.trim().replace(/\.$/, "") || "";
  return (
    <>
      <Button variant="outline" onClick={() => run("keep", () => keepPaperwork(itemId), keptSaid)} disabled={working}>
        <Archive /> {label}
      </Button>
      <Button
        variant="outline"
        onClick={() => {
          // ASKED FIRST, AND THE QUESTION SAYS WHAT GOES. Delete cannot be undone, so the confirm names
          // the paper and its file rather than asking "are you sure?" about nothing in particular — and
          // on a paper that has already written to the books it names THAT, because "nothing it would
          // have changed is written" was flatly untrue there and the books moved anyway.
          const tail = clause || "nothing it would have changed is written";
          if (confirm(`Delete this ${what}? It goes for good, with its file, and ${tail}.`)) {
            run("delete", () => deleteOrganizedItem(itemId), undefined, "Deleted.");
          }
        }}
        disabled={working}
      >
        <Trash2 /> Delete
      </Button>
      <p className="w-full text-xs text-slate-500">
        {label} keeps it in Organize, under Archive, and you can bring it back. Delete removes it and its file for good
        {clause ? `, and ${clause}.` : "."}
      </p>
    </>
  );
}
