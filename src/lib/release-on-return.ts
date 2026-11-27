import { shellFromUserAgent } from "@/lib/native-shell";
import { APP_VERSION } from "@/lib/version";

/**
 * THE PHONE APP TAKES A RELEASE WHEN IT COMES BACK (cn-v1205).
 *
 * A browser tab reloads itself when a release goes live: its service worker is replaced and
 * components/pwa-register.tsx reloads the page. The phone app has no service worker, so nothing told
 * it. It kept the build it was opened with until someone swiped it away, and the host went on
 * answering that page from its own old build for twelve hours. Found on 2026-11-27, when two proof
 * taps for a release ran on the release before it.
 *
 * THE RULE. When the page comes back after at least AWAY_MIN_MS out of sight, read the live release
 * from the worker file's own VERSION line (the same file whose change reloads a browser tab), and if
 * it is not the build this page runs, reload: at that moment or not at all. THE GATES, any one of
 * which passes the return over: a hold is on (a native screen or a file picker was opened in the
 * last HOLD_MS: a scan, a measure, a card tap, a photo, whose result lands in this page; or a
 * notification was tapped in the last thirty seconds); a screen has registered work only this page
 * holds (holdReloadWhile); a sheet is open; a field has focus; text the person typed is still on
 * the screen; or the person has already touched the screen since coming back. A return that is
 * passed over costs nothing: the next one asks again. No timer runs while the person uses the app:
 * the reload is decided once, when the answer lands (at most CHECK_CAP_MS after the return), and
 * only when none of the gates is in the way.
 *
 * FOR WHOEVER WRITES THE NEXT SCREEN. Work a screen holds only in this page's memory (a model, a
 * queue still sending, answers not yet saved, a card the person has not answered) is registered with
 * holdReloadWhile, and both reloads, the browser's and the phone app's, wait while it answers true.
 * A screen that hands the phone to a native view calls holdReleaseReload, because its result lands
 * in this page after the page is back.
 *
 * ONE RELOAD PER RELEASE. The live release this page reloaded for is kept for the session, written
 * before the reload. If the page that comes up is still not that release, it does not reload for it
 * again; and where nothing can be kept, nothing reloads.
 */

/** A look away shorter than this asks nothing: a Face ID sheet, a glance at a message. */
export const AWAY_MIN_MS = 10_000;
/** How long the question may take. Past it the return is passed over. */
export const CHECK_CAP_MS = 4_000;
/** How long an opened native screen or file picker keeps a reload away. */
export const HOLD_MS = 15 * 60_000;
/** The file whose VERSION line names the live release. Served to everyone, never cached. */
export const LIVE_VERSION_URL = "/sw.js";
/** Session key: the live release this page last reloaded for. */
export const RELOADED_FOR_KEY = "cn-release-reloaded-for";

/** The release named by the worker file's VERSION line, or null when the text is not that file. */
export function liveVersionOf(workerText: string): string | null {
  const m = /^const VERSION = "(cn-v\d+)";/m.exec(workerText);
  return m ? m[1] : null;
}

// ── The hold ────────────────────────────────────────────────────────────────────────────────
let holdUntil = 0;

/** A native screen or a file picker is opening: no release reload for `ms` from `now`. A later,
 *  shorter hold never shortens an earlier one. Both reloads read it: the phone app's on a return,
 *  and the browser's (unsafeToReloadNow), which waits it out. */
export function holdReleaseReload(now: number = Date.now(), ms: number = HOLD_MS): void {
  holdUntil = Math.max(holdUntil, now + ms);
}

export function releaseReloadHeld(now: number = Date.now()): boolean {
  return now < holdUntil;
}

/** For tests: the hold is one value for the whole page. */
export function clearReleaseHold(): void {
  holdUntil = 0;
}

// ── Work only this page holds ───────────────────────────────────────────────────────────────
const reloadChecks = new Set<() => boolean>();

/** A screen holds work only in this page's memory while `check` answers true. Returns the function
 *  that takes the check back. */
export function holdReloadWhile(check: () => boolean): () => void {
  // A wrapper, so the same function registered twice is two holds and each is taken back alone.
  const entry = () => check();
  reloadChecks.add(entry);
  return () => {
    reloadChecks.delete(entry);
  };
}

/** A reload now would lose work this page alone holds. A check that throws counts as yes. */
export function reloadWouldLoseWork(): boolean {
  for (const check of reloadChecks) {
    try {
      if (check()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** For tests: no screen holds anything. */
export function clearReloadChecks(): void {
  reloadChecks.clear();
}

// ── What the page is doing ──────────────────────────────────────────────────────────────────
export type PageLike = { body: { classList: { contains(name: string): boolean } }; activeElement: unknown };
type FieldLike = {
  tagName?: string;
  type?: string;
  value?: unknown;
  isContentEditable?: boolean;
  textContent?: string | null;
  isConnected?: boolean;
};

/** A sheet is up: every overlay sets `modal-open` on <body> (modal-lock). */
export function modalOpen(page: PageLike): boolean {
  return page.body.classList.contains("modal-open");
}

export function fieldFocused(page: PageLike): boolean {
  const el = page.activeElement as FieldLike | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || !!el.isContentEditable;
}

/** A sheet is up, or a field has focus: the part both reloads share, the browser's (pwa-register)
 *  and the phone app's (below), which gates on more besides. */
export function midTyping(page: PageLike = document): boolean {
  return modalOpen(page) || fieldFocused(page);
}

/** The browser's reload asks this: a sheet or a focused field, a hold, or work only this page holds. */
export function unsafeToReloadNow(page: PageLike = document, now: number = Date.now()): boolean {
  return midTyping(page) || releaseReloadHeld(now) || reloadWouldLoseWork();
}

const NOT_TEXT = new Set(["checkbox", "radio", "file", "button", "submit", "reset", "range", "color", "image", "hidden"]);

/** A field a person types words or numbers into. */
export function isTextField(el: unknown): el is FieldLike {
  if (!el || typeof el !== "object") return false;
  const f = el as FieldLike;
  if (f.tagName === "TEXTAREA") return true;
  if (f.tagName === "INPUT") return !NOT_TEXT.has(String(f.type ?? "text").toLowerCase());
  return f.tagName !== "SELECT" && !!f.isContentEditable;
}

export function isFileInput(el: unknown): boolean {
  if (!el || typeof el !== "object") return false;
  const f = el as FieldLike;
  return f.tagName === "INPUT" && String(f.type ?? "").toLowerCase() === "file";
}

export function hasText(f: FieldLike): boolean {
  const text = f.tagName === "INPUT" || f.tagName === "TEXTAREA" ? f.value : f.textContent;
  return String(text ?? "").trim() !== "";
}

// ── The verdict ─────────────────────────────────────────────────────────────────────────────
export type ReturnVerdict =
  | "reload"
  | "same"
  | "unknown"
  | "looped"
  | "hidden"
  | "held"
  | "busy"
  | "modal"
  | "focused"
  | "typed"
  | "touched"
  | "unguarded";

export type ReturnState = {
  /** The build this page runs. */
  mine: string;
  /** The release the site serves now; null when it could not be read. */
  live: string | null;
  /** The live release this page already reloaded for, this session. */
  reloadedFor: string | null;
  visible: boolean;
  held: boolean;
  /** A screen registered work that only this page holds (holdReloadWhile). */
  busy: boolean;
  modalOpen: boolean;
  fieldFocused: boolean;
  typedOnScreen: boolean;
  touchedSinceBack: boolean;
};

/** Reload, or the one thing that stands in the way. Any other live release is taken, a roll back too. */
export function verdictOnReturn(s: ReturnState): ReturnVerdict {
  if (!s.live) return "unknown";
  if (s.live === s.mine) return "same";
  if (s.reloadedFor === s.live) return "looped";
  if (!s.visible) return "hidden";
  if (s.held) return "held";
  if (s.busy) return "busy";
  if (s.modalOpen) return "modal";
  if (s.fieldFocused) return "focused";
  if (s.typedOnScreen) return "typed";
  if (s.touchedSinceBack) return "touched";
  return "reload";
}

// ── The wiring ──────────────────────────────────────────────────────────────────────────────
type Listener = (e: { target?: unknown }) => void;
type ListenOptions = { capture: boolean; passive: boolean };
export type ReturnDoc = PageLike & {
  visibilityState: string;
  addEventListener(type: string, fn: Listener, options?: ListenOptions): void;
  removeEventListener(type: string, fn: Listener, options?: ListenOptions): void;
};
export type ReturnDeps = {
  doc: ReturnDoc;
  nav: { userAgent: string };
  now: () => number;
  mine: string;
  fetchText: (url: string, capMs: number) => Promise<string | null>;
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  reload: () => void;
  /** Told each verdict. For tests; nothing in the app listens. */
  onVerdict: (v: ReturnVerdict) => void;
};

const LISTEN: ListenOptions = { capture: true, passive: true };

async function fetchTextCapped(url: string, capMs: number): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), capMs);
  try {
    // No cookie either way: the answer is the same for everyone, and a question that carried the
    // session could take part in its refresh on the way back in.
    const res = await fetch(url, { cache: "no-store", credentials: "omit", signal: ctl.signal });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sessionStore(): ReturnDeps["storage"] {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Start the rule on this page. Returns the function that stops it. It starts only in the phone app
 * and only where there is no service worker: where there is one, pwa-register is the one rule.
 */
export function installReleaseOnReturn(over: Partial<ReturnDeps> = {}): () => void {
  const doc = over.doc ?? (typeof document === "undefined" ? null : (document as unknown as ReturnDoc));
  const nav = over.nav ?? (typeof navigator === "undefined" ? null : navigator);
  if (!doc || !nav) return () => {};
  if ("serviceWorker" in nav) return () => {};
  if (!shellFromUserAgent(nav.userAgent).native) return () => {};
  const storage = over.storage !== undefined ? over.storage : sessionStore();
  if (!storage) return () => {};

  const now = over.now ?? Date.now;
  const mine = over.mine ?? APP_VERSION;
  const fetchText = over.fetchText ?? fetchTextCapped;
  const reload = over.reload ?? (() => window.location.reload());

  const typed = new Set<FieldLike>();
  // A page that loads out of sight (a launch woken by the site fence or a push) is away from now.
  let hiddenAt: number | null = doc.visibilityState === "visible" ? null : now();
  let backAt = 0;
  let touchedAt = -1;
  let asking = false;

  const typedOnScreen = (): boolean => {
    for (const f of [...typed]) {
      if (f.isConnected === false) typed.delete(f);
      else if (hasText(f)) return true;
    }
    return false;
  };
  const reloadedFor = (): string | null => {
    try {
      return storage.getItem(RELOADED_FOR_KEY);
    } catch {
      return null;
    }
  };
  const remember = (live: string): boolean => {
    try {
      storage.setItem(RELOADED_FOR_KEY, live);
      return true;
    } catch {
      return false;
    }
  };

  const onReturn = async (): Promise<void> => {
    if (asking) return;
    asking = true;
    backAt = now();
    let verdict: ReturnVerdict = "unknown";
    try {
      if (releaseReloadHeld(backAt)) {
        verdict = "held";
        return;
      }
      const text = await fetchText(LIVE_VERSION_URL, CHECK_CAP_MS);
      const live = text === null ? null : liveVersionOf(text);
      verdict = verdictOnReturn({
        mine,
        live,
        reloadedFor: reloadedFor(),
        visible: doc.visibilityState === "visible",
        held: releaseReloadHeld(now()),
        busy: reloadWouldLoseWork(),
        modalOpen: modalOpen(doc),
        fieldFocused: fieldFocused(doc),
        typedOnScreen: typedOnScreen(),
        touchedSinceBack: touchedAt >= backAt,
      });
      if (verdict === "reload" && live) {
        // Remembered BEFORE the reload: the page that comes up reads it.
        if (remember(live)) reload();
        else verdict = "unguarded";
      }
    } catch {
      verdict = "unknown";
    } finally {
      asking = false;
      over.onVerdict?.(verdict);
    }
  };

  const onVisibility: Listener = () => {
    if (doc.visibilityState !== "visible") {
      if (hiddenAt === null) hiddenAt = now();
      return;
    }
    const away = hiddenAt === null ? 0 : now() - hiddenAt;
    hiddenAt = null;
    if (away >= AWAY_MIN_MS) void onReturn();
  };
  const onTouch: Listener = () => {
    touchedAt = now();
  };
  const onInput: Listener = (e) => {
    if (isTextField(e.target)) typed.add(e.target);
  };
  // A file picker hands its photo to this page when it closes, sometimes a second or two after the
  // page is back: the hold starts at the tap that opens it, and again when the file lands.
  const onFile: Listener = (e) => {
    if (isFileInput(e.target)) holdReleaseReload(now());
  };

  const wired: [string, Listener][] = [
    ["visibilitychange", onVisibility],
    ["pointerdown", onTouch],
    ["touchstart", onTouch],
    ["keydown", onTouch],
    ["input", onInput],
    ["click", onFile],
    ["change", onFile],
  ];
  for (const [type, fn] of wired) doc.addEventListener(type, fn, LISTEN);
  return () => {
    for (const [type, fn] of wired) doc.removeEventListener(type, fn, LISTEN);
  };
}
