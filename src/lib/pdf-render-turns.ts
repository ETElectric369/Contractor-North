/**
 * WHOSE TURN IT IS TO OWN THE DOCUMENT PREVIEW, and what width the sheets on screen are drawn at.
 *
 * Pulled out of print/pdf-preview/viewer.tsx the same way pdf-page-width.ts was: this is a race with
 * a history, and a race with a history belongs somewhere it can be tested. Two different jobs draw on
 * that screen and they are NOT peers:
 *
 *  - a LOAD fetches a new document (a margin change, a first open) and ends by drawing it;
 *  - a PAINT draws the document already in hand again, at a new width (the phone turned).
 *
 * Until 2026-10-01 both bumped ONE counter, and the two failures that came out of that are the reason
 * this file exists:
 *
 *  1. THE MARGIN HE CHOSE WENT MISSING. He taps Wide, the fetch starts, he turns the phone, and
 *     180 ms later the rotation's repaint bumped the shared counter — so when the Wide bytes landed,
 *     the load saw a newer number and returned. Nothing re-ran it. The selector read "Wide · 1 in"
 *     over Narrow sheets, and the only way out was to change the margin twice. Silent, on a money
 *     document. Worse, when the bump landed after the blob had been swapped in, Download handed over
 *     a document that did not match the screen.
 *     THE RULE: a paint may never take the screen away from a load. And while a load is in flight
 *     nothing repaints at all — the load measures the room itself when it finally draws.
 *
 *  2. AN INTERRUPTED ROTATION LEFT THE SHEETS THE WRONG WIDTH. The width was recorded only after the
 *     last page finished rasterizing, but the first thing a paint does is empty the list. Turn the
 *     phone and turn it back before a 12-page material list finishes, and the "have I already drawn
 *     this width?" guard was still looking at the width of the paint before last — so it declined to
 *     redraw, and the sideways paint ran to completion into a portrait window. The invoice could only
 *     be read by panning sideways, and standing still fires no further resize, so it never healed.
 *     THE RULE: the width is claimed when the list is emptied, because that is the width the screen
 *     shows from then on — finished or not.
 */

export type RenderTurns = {
  /** A new document is being fetched. Cancels every load AND every paint, and holds the repainter off. */
  startLoad(): number;
  /** Does this load still own the screen, or did a newer one start? */
  loadOwns(turn: number): boolean;
  /**
   * The page list is being emptied and refilled at `widthPx`. Cancels other paints only — never a
   * load. The width is recorded HERE, not when the last page lands.
   */
  startPaint(widthPx: number): number;
  /** Does this paint still own the screen? */
  paintOwns(turn: number): boolean;
  /**
   * The last page has landed. False when a newer turn took the list — the caller must stop without
   * flipping anything to "ready". The width is re-affirmed only by the turn that still owns the list;
   * a superseded paint finishing late must not overwrite the width now on screen.
   */
  finishedPaint(turn: number, widthPx: number): boolean;
  /** The width the sheets in the list are drawn at right now, whether or not that paint finished. */
  drawnAtW(): number;
  /** Is a fetch in flight? While it is, a rotation must defer rather than repaint the old document. */
  isLoading(): boolean;
  /** This load's document is now the one in hand, so rotations may repaint it. A stale load is ignored. */
  settled(turn: number): void;
  /** Leaving the page: nothing owns the screen any more, so no loop keeps drawing into it. */
  abandonAll(): void;
};

export function renderTurns(): RenderTurns {
  let loadTurn = 0;
  let paintTurn = 0;
  let loading = false;
  let drawnAt = 0;
  return {
    startLoad() {
      loading = true;
      // The document on screen is about to be replaced, so a repaint of IT loses the screen too.
      paintTurn++;
      return ++loadTurn;
    },
    loadOwns: (turn) => turn === loadTurn,
    startPaint(widthPx) {
      drawnAt = widthPx;
      return ++paintTurn;
    },
    paintOwns: (turn) => turn === paintTurn,
    finishedPaint(turn, widthPx) {
      if (turn !== paintTurn) return false;
      drawnAt = widthPx;
      return true;
    },
    drawnAtW: () => drawnAt,
    isLoading: () => loading,
    settled(turn) {
      if (turn === loadTurn) loading = false;
    },
    abandonAll() {
      loading = false;
      loadTurn++;
      paintTurn++;
    },
  };
}
