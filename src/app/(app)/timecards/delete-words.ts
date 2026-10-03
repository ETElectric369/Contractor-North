/**
 * WHAT A DELETE SAYS BEFORE IT TAKES THE HOURS (Erik, 2026-10-02).
 *
 * He split a shift, deleted one half, and found the remaining half could not be rejoined. Two things
 * were wrong. The family dissolving is fixed in deleteTimeEntry. The other is these words: "Delete this
 * time entry? This can't be undone." is the same sentence for an ordinary shift and for one half of a
 * split, and on a split it names neither what goes (the hours, and the job they were on) nor the door
 * that keeps them. There is no Undo on a delete, so the sentence IS the way back — it has to name it.
 *
 * A SENTENCE MAY NEVER NAME A DOOR THE SCREEN IS NOT SHOWING (review, 2026-10-03). On a RUNNING piece
 * — which is every second piece a Switch Job leaves behind — the editor shows the clock-out sheet, and
 * that sheet has Delete and no Join Back at all. The first version of these words named it anyway, so
 * the way back it promised was a door that was not on the page. `running` picks the true one.
 *
 * JOIN BACK KEEPS THE FIRST PART'S JOB (join_time_entries, 0320), which is the part of this that bites:
 * if the half being deleted is the EARLIER one — the sliver on the job the app picked, the exact thing
 * Erik was deleting — then joining instead puts the whole shift on that very job. So the sentence names
 * the job the joined shift would keep, every time, rather than offering a door whose outcome is a
 * surprise. It is the same fact joinConsequence says beside the button itself.
 *
 * Pure, so the words are pinned by a test and cannot drift from the editor that shows them.
 */

/** An ordinary entry: the plain question, unchanged since 1aef0a4e. */
export const PLAIN_DELETE_CONFIRM = "Delete this time entry? This can't be undone.";

/** What the editor knows about the piece it is about to delete, in the words a person reads. */
export type DeletingPiece = {
  /** Worked hours on this piece, lunch already taken off, or null while the clock is still running. */
  hours: number | null;
  /** This piece's job, named the way a person knows it (jobLabel), or its time code, or "no job". */
  label: string;
  /** The job the JOINED shift would keep: the first part's. Join Back's own rule (0320). */
  keepsJob: string;
  /**
   * THE CLOCK ON THIS PIECE IS STILL RUNNING, so Join Back Into One Shift is not on the screen in
   * front of them: a running entry opens the clock-out sheet, which has Delete and no split tools, and
   * join_time_entries refuses a running shift outright ("Clock out first", 0322). Naming that button
   * anyway sent the office to cancel and hunt for a door that was not there. The way back is real —
   * clock out, then join — and it is on this very sheet, so the sentence says it in that order.
   */
  running?: boolean;
};

/** The door's words. Line per idea, so the question, the loss and the way back read in that order. */
export function deleteConfirmWords(piece: DeletingPiece | null): string {
  if (!piece) return PLAIN_DELETE_CONFIRM;
  const what =
    piece.hours == null
      ? `Its time on ${piece.label} goes with it`
      : `The ${Math.round(piece.hours * 100) / 100} h on ${piece.label} go with it`;
  const back = piece.running
    ? `To keep those hours, cancel and clock this shift out first — then Join Back Into One Shift is on it, and it makes the day one shift again, all of it on ${piece.keepsJob}.`
    : `To keep those hours, cancel and tap Join Back Into One Shift — that makes it one shift again, all of it on ${piece.keepsJob}.`;
  return ["Delete this part of the split shift?", `${what}, and this can't be undone.`, back].join("\n\n");
}
