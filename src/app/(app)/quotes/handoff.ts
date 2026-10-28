import type { DraftLineItem } from "@/lib/estimate/line-map";
import { coerceDraftLine } from "@/lib/estimate/task-lines";

/**
 * THE HAND-OFF FROM /quotes/new TO /quotes/<id> (cn-v1132, S6). An estimate born on the new page is
 * handed to its own page by a REAL navigation (router.replace: Back then goes to the page before the
 * editor, never to an unsaved editor that would birth a second row), and the saved page's status is
 * the server's from then on. What is not on the server rides across in a one-shot stash: the
 * estimator's scope text, the proposals he has not yet taken or dropped, the questions, and the
 * number the save came back with (so the saved page can still say "Saved as E-012" once). A line
 * on the estimate is NEVER here — the hand-off waits until every line is on the server (isQuiet).
 *
 * Pure over a Storage-shaped store, so a test drives it with a Map; the browser's sessionStorage is
 * handed in by the editor (browserStash). Read once and cleared: a reload of the saved page has
 * nothing to restore, which is right — the server is the estimate.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One line the estimator proposed and he has not yet taken or dropped. */
export type HandoffProposal = DraftLineItem & { pid: number; keep: boolean };

export interface Handoff {
  scope: string;
  proposed: HandoffProposal[];
  questions: string[];
  /** The number the first save came back with, for the one "Saved as …" line. */
  number: string | null;
}

export const handoffKey = (quoteId: string): string => `handoff:quote:${quoteId}`;

/** How long a stash is good for. A hand-off that never landed (the tab closed between the stash and
 *  the navigation, the navigation refused) would otherwise leave its proposals and a "Saved as" line
 *  for whoever opens that estimate in the same tab a week later. Ten minutes covers a slow network. */
export const HANDOFF_TTL_MS = 10 * 60_000;

/** The browser's sessionStorage, or null where there is none (a server render, a private window that
 *  refuses it). Every caller treats null as "nothing to carry": the estimate itself is on the server. */
export function browserStash(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    const s = window.sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

/** Put the unsaved UI text under the estimate's key, stamped with when. False when it could not be
 *  kept (no store, a full store): the editor then decides whether to navigate — with text to carry it
 *  stays where it is and offers the saved page as a link, so nothing he typed is lost. */
export function stashHandoff(store: StorageLike | null, quoteId: string, h: Handoff, now: number = Date.now()): boolean {
  if (!store) return false;
  try {
    store.setItem(handoffKey(quoteId), JSON.stringify({ ...h, at: now }));
    return true;
  } catch {
    return false;
  }
}

/** Take the stash for this estimate, once: what was kept, shaped (a proposal is a draft line with
 *  its pid and keep; anything else is dropped), and the key cleared. null when there is none, or when
 *  it is older than HANDOFF_TTL_MS (a stash with no stamp counts as old: nothing to carry). */
export function takeHandoff(store: StorageLike | null, quoteId: string, now: number = Date.now()): Handoff | null {
  if (!store) return null;
  const key = handoffKey(quoteId);
  let raw: string | null;
  try {
    raw = store.getItem(key);
    store.removeItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.at !== "number" || !Number.isFinite(p.at) || now - p.at > HANDOFF_TTL_MS) return null;
  const proposed: HandoffProposal[] = (Array.isArray(p.proposed) ? p.proposed : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { description?: unknown }).description === "string")
    .map((x, i) => ({
      ...coerceDraftLine({
        description: String(x.description),
        quantity: Number(x.quantity) || 1,
        unit: typeof x.unit === "string" ? x.unit : "ea",
        unit_price: Number(x.unit_price) || 0,
        ...(typeof x.group === "string" && x.group ? { group: x.group } : {}),
        ...(typeof x.flag === "string" && x.flag ? { flag: x.flag } : {}),
        ...(x.kind === "labor" || x.kind === "materials" ? { kind: x.kind } : {}),
        detail: x.detail as DraftLineItem["detail"],
      }),
      pid: typeof x.pid === "number" ? x.pid : i,
      keep: x.keep !== false,
    }));
  return {
    scope: typeof p.scope === "string" ? p.scope : "",
    proposed,
    questions: (Array.isArray(p.questions) ? p.questions : []).filter((q): q is string => typeof q === "string"),
    number: typeof p.number === "string" && p.number ? p.number : null,
  };
}
