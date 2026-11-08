"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * THE WEEK LINE'S HEIGHT, HANDED TO THE GRID AS A CSS VARIABLE (cn-v1151; Erik: the Mon–Sun day header
 * must lock on screen while he scrolls down the week).
 *
 * Both week stacks (/timecards' timecard-stack, the schedule's calendar-view) put each week in a Card with
 * a `sticky top-0` week line at its top and the TimeGrid under it. The grid's day-header strip sticks too
 * (TimeGrid's `stickyHeader`), and it has to stick UNDER that line, not at the stack's edge where the line
 * would cover it — so its `top` is the line's height. Only the caller knows that height: the line wraps on
 * a narrow phone ("· 1 still on the clock" takes a second row), so it is measured, never guessed. This
 * hook measures it and writes it onto an ancestor of the grid as `--grid-stick-top`, which the strip reads
 * (`top: var(--grid-stick-top, 0px)`; custom properties inherit, so any ancestor of the grid will do).
 *
 * NO REACT STATE. The number goes straight onto the element with style.setProperty, so a resize of the
 * line (a rotation, a wrap) never re-renders the stack — with forty weeks mounted, a render per resize is
 * the difference between scrolling and freezing (see TimeGrid's memo). A ResizeObserver keeps it true as
 * the line changes; where there is none it is measured once. Before paint (useLayoutEffect), so the strip
 * never sticks at 0px for a frame. SSR-safe: nothing here names `window` or `ResizeObserver` at import
 * time, only inside the effect, which never runs on the server.
 */

/** The variable the grid's day-header strip reads for its `top` (components/time-grid.tsx). */
export const STICK_TOP_VAR = "--grid-stick-top";

/** The variable's value for a line this tall: "30px"; zero or less (or no number) is "0px", and the strip
 *  then sticks at the stack's own edge. */
export function stickTopPx(height: number): string {
  return `${height > 0 ? height : 0}px`;
}

/** The least of a ResizeObserver this needs, so a test can hand in a fake. */
type Resizer = { observe(target: HTMLElement): void; disconnect(): void };
type ResizerCtor = new (onResize: () => void) => Resizer;

/**
 * Measures `line` and writes its height onto `host` as --grid-stick-top; with an observer, again on every
 * resize of the line. Returns the undo: the observer disconnected, the variable removed. The hook below is
 * this inside React's lifecycle; it is its own function so a test can run it with a fake observer and no
 * DOM at all.
 */
export function attachStickyOffset(line: HTMLElement, host: HTMLElement, Observer?: ResizerCtor): () => void {
  const measure = () => host.style.setProperty(STICK_TOP_VAR, stickTopPx(line.offsetHeight));
  measure();
  const watcher = Observer ? new Observer(measure) : null;
  watcher?.observe(line);
  return () => {
    watcher?.disconnect();
    host.style.removeProperty(STICK_TOP_VAR);
  };
}

/**
 * `lineRef` is the caller's sticky week line; `hostRef` the element the variable is written on — the Card
 * around the line and the grid, or any other ancestor of the grid. Both refs are read when the effect runs
 * (after the caller's render has mounted them); either missing, nothing is set.
 */
export function useStickyOffset(lineRef: RefObject<HTMLElement | null>, hostRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const line = lineRef.current;
    const host = hostRef.current;
    if (!line || !host) return;
    return attachStickyOffset(line, host, typeof ResizeObserver === "undefined" ? undefined : ResizeObserver);
  }, [lineRef, hostRef]);
}
