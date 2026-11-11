import { measureNative, type MeasureMode } from "@/lib/native-measure";
import { discardScan, scan3dNative } from "@/lib/native-scan";
import type { Words } from "@/lib/lang-words";

/**
 * MEASURE FROM THE + (cn-v1160). The owner, 2026-11-10: "i think we should add a quick measure button
 * on the top bar, quick access to the lidar measure tool with dropdown for the 3 options", and, shown
 * that a seventh 44px button does not fit a phone's top bar (33px over at 375), "in the + menu agreed".
 *
 * The three options are the Inspector's own (Measure, Measure Area, 3D Scan). Until now they lived
 * only inside a visit's Inspector. From the + there may be no visit open, so the question this file
 * answers is WHERE A RESULT GOES, and the answer is never a guess:
 *
 *   · ON A VISIT whose Inspector he can write: the + runs the Inspector's OWN functions (the host
 *     below), for the task that is open or the visit. One implementation: a server-side append would
 *     be erased by the Inspector's next autosave, which sends its whole measures section.
 *   · ANYWHERE ELSE: the result opens in one sheet (components/quick-measure-sheet) that offers the
 *     page he is on (a job), the job he is clocked on, a new inspection, or not keeping it.
 *
 * A LENGTH OR AN AREA IS NEVER HELD ONCE THE SHEET CLOSES: it costs ten seconds to take again, and
 * closing is a discard he was told about (the Modal's own two-tap guard). A 3D MODEL IS NEVER DROPPED
 * BY CLOSING: it costs minutes and is 40 to 130 MB, so it waits here, in this page's memory, until it
 * is saved or he discards it; the + wears a mark while it waits.
 *
 * This file is the store and the rules, with no React, no catalog (a file under src/lib imports no
 * catalog: words are handed in) and no database. The store is module memory: it survives moving
 * between pages (a soft navigation) and nothing else. A reload loses a held model, which is why the
 * +'s own full reload waits while one is held (measureHeld).
 */

/** What a row in the + asks for. */
export type MeasureKind = MeasureMode | "scan";

// ── THE HOST: A PAGE THAT TAKES A RESULT ITSELF ────────────────────────────────────────────────

/** What a mounted, writable Inspector offers the +. Its functions are the in-page buttons' own. */
export type MeasureHost = {
  /** Measure or Measure Area, for the task that is open, else the visit. */
  measure: (mode: MeasureMode) => void | Promise<void>;
  /** 3D Scan, for the task that is open, else the visit. */
  scan: () => void | Promise<void>;
  /** A model the + is holding, handed to this visit: the Inspector keeps it and sends it down its own
   *  path. True when the Inspector TOOK it (the + then lets go of it without discarding the file). */
  adoptModel: (m: { model: File; path: string; shots: number }) => boolean | Promise<boolean>;
};

/** A page's answer: its host, or null when its reader cannot write (a reader's Inspector). */
export type MeasureHostProvider = () => MeasureHost | null;

const providers = new Set<MeasureHostProvider>();

/** Register a page's host. Returns the unregister, for the effect's cleanup. */
export function registerMeasureHost(provider: MeasureHostProvider): () => void {
  providers.add(provider);
  return () => {
    providers.delete(provider);
  };
}

/** The host on the screen right now: the last registered provider that answers. A provider that
 *  throws is skipped (a page mid-unmount must never take the + down with it). */
export function measureHost(): MeasureHost | null {
  let found: MeasureHost | null = null;
  for (const p of providers) {
    try {
      const h = p();
      if (h) found = h;
    } catch {
      /* skipped */
    }
  }
  return found;
}

// ── WHERE HE IS ────────────────────────────────────────────────────────────────────────────────

export type MeasurePlace = { kind: "visit" } | { kind: "job"; jobId: string } | { kind: "nowhere" };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const JOB_PAGE = new RegExp(`^/jobs/(${UUID})(?:/|$)`, "i");

/** The place a result would be saved to, from the address and whether a host answered. A visit he
 *  can only read is not a place (no host): the sheet treats it as nowhere and asks. */
export function whereIsHe(pathname: string | null | undefined, hasHost: boolean): MeasurePlace {
  if (hasHost) return { kind: "visit" };
  const m = JOB_PAGE.exec(String(pathname ?? ""));
  return m ? { kind: "job", jobId: m[1].toLowerCase() } : { kind: "nowhere" };
}

// ── THE STORE ──────────────────────────────────────────────────────────────────────────────────

/** A length or an area as the sheet shows it. `photo` is the measuring screen's own picture (the
 *  points and lines; the figure is not in it), null when it did not come back. */
export type MeasureFigure = { mode: MeasureMode; value: number; unit: "ft" | "sq ft"; caption: string; approx: boolean; photo: File | null };

/** A 3D model the + is holding. */
export type HeldModel = {
  model: File;
  /** The shell's copy, discarded only once the model is saved somewhere or he discards it. */
  path: string;
  shots: number;
  /** Set when the file reached a job's folder and only the job's row is owed: Finish Saving writes
   *  the row alone, never a second upload; Discard removes this file too. */
  landed: { jobId: string; path: string; name: string } | null;
};

/** What the sheet is showing. A model's own data is `held`; the sheet shows it while `open` says so. */
export type OpenResult =
  | { kind: "figure"; figure: MeasureFigure }
  | { kind: "model" }
  /** The plugin said no (no camera permission, a phone that cannot scan), in its own sentence. */
  | { kind: "refused"; said: string };

export type MeasureStore = {
  /** The measuring or scanning screen is up (rows are disabled while it is). */
  busy: MeasureKind | null;
  open: OpenResult | null;
  held: HeldModel | null;
  /** A visit Start an Inspection with It already made for what is open or held: a retry fills THAT
   *  visit and never makes a second one. Cleared when the result is saved, dropped or replaced. It is
   *  ONE slot, and two results can be on the phone at once (a model held, a figure open): while a model
   *  is held a figure's going leaves the slot as it stands, so the save lane keeps each result's own
   *  visit beside it and never hands one result's visit to the other (quick-measure-save visitMadeFor). */
  visitId: string | null;
  /** Whose this is ("<user>:<company>"), from the first context that answered. */
  owner: string | null;
  /** THE APP WAS LEFT (the + unmounted: sign-out is a soft navigation and this is page memory). Until
   *  a fresh context says it is the same person in the same company, nothing held is offered; anyone
   *  else starts empty and the shell's copy is discarded (Snap or Note's rule). */
  left: boolean;
};

const START: MeasureStore = { busy: null, open: null, held: null, visitId: null, owner: null, left: false };
let store: MeasureStore = START;
const listeners = new Set<() => void>();
/** How many times the app has been left (measureAppLeft). A measuring screen that was up when it
 *  happened hands its answer to a page somebody else may be on by then: runQuickMeasure counts. */
let leaves = 0;

function put(next: Partial<MeasureStore>) {
  store = { ...store, ...next };
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* a listener's fault is its own */
    }
  });
}

/** The store as it stands (a stable object between changes: useSyncExternalStore's snapshot). */
export function measureStore(): MeasureStore {
  return store;
}

export function subscribeMeasure(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The same rule over a snapshot: a component's render reads the store it subscribed to. */
export function heldModelOf(s: MeasureStore): HeldModel | null {
  return s.left ? null : s.held;
}

/** A model is held and is this person's to see. The + draws its mark and its row from this. */
export function heldModel(): HeldModel | null {
  return heldModelOf(store);
}

/** A model is in page memory, whoever's it is: a full reload now would lose it (the +'s reload guard). */
export function measureHeld(): boolean {
  return store.held !== null;
}

/** The sheet closed. A figure goes (he was told); a model stays held. */
export function closeMeasureSheet(): void {
  put({ open: null, ...(store.held ? {} : { visitId: null }) });
}

/** The +'s "3D Model · Not Saved" row: the sheet opens on the held model. */
export function reopenHeldModel(): void {
  if (heldModel()) put({ open: { kind: "model" } });
}

/** A step of a save landed or was owed (the file is up, the row is not). */
export function patchHeldModel(patch: Partial<Pick<HeldModel, "landed">>): void {
  if (store.held) put({ held: { ...store.held, ...patch } });
}

/** Start an Inspection with It made this visit; a retry reuses it. */
export function rememberMeasureVisit(visitId: string | null): void {
  put({ visitId });
}

/** The model is somewhere now (a job, a visit) or the Inspector took it: the + lets go WITHOUT
 *  touching the shell's copy (the caller discards it once its own save has landed). */
export function releaseHeldModel(): void {
  put({ held: null, visitId: null, open: store.open?.kind === "model" ? null : store.open });
}

/** He discarded it: the + lets go and the shell's copy goes. (A file already up on a job is the
 *  save lane's to remove: lib/quick-measure-save discardModel, which then calls this.) */
export async function dropHeldModel(): Promise<void> {
  const path = store.held?.path ?? "";
  releaseHeldModel();
  if (path) await discardScan(path);
}

/** The figure in the sheet was saved or not kept. */
export function clearMeasureFigure(): void {
  if (store.open?.kind === "figure" || store.open?.kind === "refused") put({ open: null, ...(store.held ? {} : { visitId: null }) });
}

/**
 * THE INSPECTOR IS LEAVING WITH A MODEL IT NEVER SENT (cn-v1160; the scout's F2: the kept model lived
 * only while the visit's page was mounted, and leaving dropped it without a word). It is handed here
 * so the + can offer it again. False when the + cannot take it (it already holds one, or the app was
 * left): the Inspector then does what it did before.
 */
export function keepModelInPlus(m: { model: File; path: string; shots?: number }): boolean {
  if (store.held || store.left) return false;
  put({ held: { model: m.model, path: m.path, shots: m.shots ?? 0, landed: null }, visitId: null });
  return true;
}

/** The + unmounted (see `left`). The sheet goes with it, as closing it would: a figure and the visit
 *  made for it are gone, a model and its visit stay held, hidden until its owner is named again. */
export function measureAppLeft(): void {
  leaves += 1;
  put({ left: true, open: null, busy: null, ...(store.held ? {} : { visitId: null }) });
}

/**
 * A context answered: this is who is on the phone. The same person in the same company gets what was
 * held back; anyone else (or a held model nobody was named for by the time the app was left) starts
 * with nothing held, and the shell's copy of the last person's model is discarded.
 *
 * THE FIRST NAME MAY COME AFTER THE MODEL. The context is a read over the network and a scan needs
 * none: with no signal when the app opened, a model is held before anybody has been named. While the
 * app has not been left since, that model is the scanner's own, and the first name to arrive is
 * theirs: it is kept. (Dropping it there threw away a walk of minutes the moment the signal came
 * back.) Only what was left behind unnamed has nobody to go back to.
 *
 * What goes is what the LAST person held. A figure the person on the phone has open, or a screen
 * they have up, is theirs and stays: a name arriving late must never close the sheet they are reading.
 */
export function setMeasureOwner(key: string | null): void {
  if (!key) return;
  const theirs = store.owner === key || (store.owner === null && !store.left);
  if (theirs || !store.held) {
    put({ owner: key, left: false });
    return;
  }
  const path = store.held.path;
  put({ owner: key, left: false, held: null, visitId: null, open: store.open?.kind === "model" ? null : store.open });
  if (path) void discardScan(path);
}

// ── THE TAP ────────────────────────────────────────────────────────────────────────────────────

/**
 * A row in the + was tapped. On a page with a host it IS the Inspector's flow and no sheet opens.
 * Anywhere else the plugin runs and its answer opens the sheet: a figure, a model (held from this
 * moment), or the plugin's refusal in its own sentence. A cancel says nothing. A model already held
 * is never replaced by a new scan: the sheet opens on the one that is waiting.
 *
 * `words` is the reader's translator (the bridges say their refusals through it); `now` is the
 * model file's stamp, handed in so a test can fix it.
 *
 * WHOSE THE ANSWER IS. The web view keeps running under the measuring screen, and a sign-out is a soft
 * navigation: the app can be left while the screen is up. What comes back then belongs to whoever
 * was measuring, not to whoever is on the phone next, so a figure or a refusal is dropped (a length
 * is never held) and a model is held hidden, with no sheet, exactly as one left behind is: its owner
 * gets it back, anybody else never sees it. The other way round, a scan STARTED while the last
 * person's leaving is still unanswered (the + is back on screen, the context has not named anybody
 * yet) is the scanner's own and nothing of the last person's is held beside it, so it is shown at
 * once and the next name to arrive is its owner's.
 */
export async function runQuickMeasure(kind: MeasureKind, o: { lang?: string | null; words?: Words; now?: number } = {}): Promise<void> {
  if (store.busy) return;
  const host = measureHost();
  if (host) {
    put({ busy: kind });
    try {
      if (kind === "scan") await host.scan();
      else await host.measure(kind);
    } finally {
      put({ busy: null });
    }
    return;
  }
  const leftAtTap = leaves;
  const leftSince = () => leaves !== leftAtTap;
  if (kind === "scan") {
    if (store.held) {
      reopenHeldModel();
      return;
    }
    const ownerAtTap = store.owner;
    put({ busy: "scan" });
    try {
      const r = await scan3dNative(o.now ?? Date.now(), o.lang, o.words);
      if (r.ok) {
        const held: HeldModel = { model: r.model, path: r.path, shots: r.shots, landed: null };
        if (!leftSince()) put({ held, visitId: null, open: { kind: "model" }, ...(store.left ? { left: false, owner: null } : {}) });
        // Left while the screen was up: held for the one who scanned it, as long as the store is still
        // theirs (the same name, or still waiting for one). Somebody else named since: it has nobody
        // to go back to, and the shell's copy goes with it.
        else if (store.owner === ownerAtTap && (ownerAtTap !== null || store.left)) put({ held, visitId: null });
        else await discardScan(r.path);
      } else if ("refused" in r && !leftSince()) put({ open: { kind: "refused", said: r.refused } });
    } finally {
      put({ busy: null });
    }
    return;
  }
  put({ busy: kind });
  try {
    const r = await measureNative(kind, o.lang, o.words);
    if (leftSince()) return;
    if (r.ok) {
      put({
        open: { kind: "figure", figure: { mode: r.mode, value: r.value, unit: r.unit, caption: r.caption, approx: r.approx, photo: r.photo } },
        ...(store.held ? {} : { visitId: null }),
      });
    } else if ("refused" in r) put({ open: { kind: "refused", said: r.refused } });
  } finally {
    put({ busy: null });
  }
}

// ── WHO IS ON THE PHONE, AND THE JOB HE IS CLOCKED ON ──────────────────────────────────────────

/** What POST /api/measure/context answers, as askMeasureContext hands it on. `punchUnread`: who is on
 *  the phone was read, and the time clock was not; the job he is clocked on is unknown, which is never
 *  the same as "not on the clock" (the sheet says so, with Try Again). */
export type MeasureContext =
  | { ok: true; userId: string; orgId: string; punchJob: { id: string; label: string } | null; punchUnread?: true }
  | { ok: false; error: string };

/** How long the read may take before it is given up (the sheet says no signal sooner, at its own
 *  ASK_PATIENCE_MS; this only frees the connection). */
export const MEASURE_CONTEXT_TIMEOUT_MS = 15000;

/**
 * WHO IS ON THE PHONE, AND THE JOB HE IS CLOCKED ON: the one read Measure from the + makes. A ROUTE,
 * NOT A SERVER ACTION: Next sends one client's server actions one at a time, and this read is asked
 * at every mount of the + and every measure, so as an action it would stand in front of his saves
 * with no signal. `fail` is the reader's own sentence for any failure (the route's refusals carry no
 * words, so a Spanish reader never gets an English one).
 */
export async function askMeasureContext(fail: string, ms: number = MEASURE_CONTEXT_TIMEOUT_MS): Promise<MeasureContext> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ms);
  try {
    const r = await fetch("/api/measure/context", { method: "POST", signal: stop.signal });
    const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (!r.ok || body?.ok !== true || typeof body.userId !== "string" || typeof body.orgId !== "string") return { ok: false, error: fail };
    const pj = body.punchJob as { id?: unknown; label?: unknown } | null | undefined;
    const punchJob = pj && typeof pj.id === "string" && typeof pj.label === "string" ? { id: pj.id, label: pj.label } : null;
    return { ok: true, userId: body.userId, orgId: body.orgId, punchJob, ...(body.punchUnread === true ? { punchUnread: true as const } : {}) };
  } catch {
    return { ok: false, error: fail };
  } finally {
    clearTimeout(timer);
  }
}

/** The store's owner key for a context. */
export function measureOwnerKey(c: MeasureContext): string | null {
  return c.ok ? `${c.userId}:${c.orgId}` : null;
}

/** Test seam: the store back to its start. Never called by the app. */
export function resetMeasureStoreForTest(): void {
  store = START;
  leaves = 0;
  listeners.clear();
  providers.clear();
}
