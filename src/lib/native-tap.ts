"use client";

import { isNativeShell } from "@/lib/native-shell";
import { ensureTerminalLocation, tapToPayContext, type TapToPayContext } from "@/app/(app)/billing/tap-actions";
import { reportClientError } from "@/app/report-client-error";

/**
 * TAP TO PAY ON IPHONE, from the web app running inside the native shell (2026-09-10).
 *
 * The phone IS the card reader. The web side (served from app.contractornorth.com into the
 * WKWebView) drives Stripe's Terminal SDK through the Capacitor plugin
 * @capacitor-community/stripe-terminal, which registers natively as `StripeTerminal`. The flow is
 * initialize → discover the (one) Tap to Pay reader → connect it → collect the tap → confirm. The
 * server mints the PaymentIntent (billing/tap-actions.ts) and Stripe's webhook books the money;
 * this file only ever reports "it went through" or a sentence saying why not.
 *
 * THE PLUGIN, FROM THE BRIDGE — NEVER FROM AN IMPORT (the native-push.ts lesson, 2026-09-09).
 * `await import("@capacitor-community/stripe-terminal")` would put the package (and its
 * @stripe/terminal-js dependency) in the browser bundle for nothing — all the JS side does is
 * forward to the bridge Capacitor already injected — and on the phone that import HUNG, never
 * resolving. So read `window.Capacitor.Plugins.StripeTerminal`, and return null the moment it
 * isn't there: a build without the plugin then says "not available" instead of stalling. Event
 * names are the raw strings ("terminal…") because the package's enum is not importable here.
 *
 * ARM EVERY TIMEOUT BEFORE THE CALL IT RESCUES. A bridge call into a plugin the running build
 * doesn't have simply never answers; the rescue has to exist before the risk does.
 *
 * Until Apple grants the Tap to Pay entitlement (a human step — see App.entitlements), a real
 * iPhone answers the discover/connect stage with an error, which lands here as a plain sentence.
 * That is the designed behaviour: shippable today, honest about what it can't do yet.
 *
 * APPLE'S REVIEW LAWS THIS FILE CARRIES (App Requirements v1.7, added 2026-09-11):
 *  1.4  an iOS too old for Tap to Pay on iPhone is told to UPDATE iOS — classify() → "os".
 *  1.5  warm up at launch and on every foreground — prepareTapToPay() is a cheap no-op once the
 *       reader is connected, and waits for the SDK's own reconnect instead of fighting it.
 *  1.6  "has this merchant accepted Apple's terms?" is read from Apple through the SDK EVERY
 *       time (readLinked / tapToPayAccountLinked). No flag here ever answers that question.
 *  3.5/3.8  Apple's terms sheet is raised by the SDK inside the FIRST connect for an account.
 *       Only enableTapToPay() — the Settings door, which the page shows to owners/admins — lets a
 *       connect happen on an unlinked account. The unattended warm-up and the checkout REFUSE
 *       with a sentence (notEnabled) instead, so a technician never meets Apple's sheet. And when
 *       Apple's answer can't be read at all (readLinked null), the same refusal stands unless the
 *       SERVER has said the caller may accept the terms (canEnable — the checkout, for an
 *       owner/admin); the warm-up never carries that word, so it skips the round.
 *  3.9.1/5.7  configuration progress: the SDK reports Apple's device setup as a reader software
 *       update; onTapProgress() re-publishes it as a percent, next to this bridge's own stages.
 *  4.1  Apple's own how-to sheet (ProximityReaderDiscovery, iOS 18+) through CN's tiny native
 *       TapToPayEducation plugin — showHowToTap().
 *  Copy: in-app communications say "Tap to Pay on iPhone" in full; only a button may shorten it.
 *
 * ONE PAGE IS NOT ONE IDENTITY. Sign-out and sign-in are soft client transitions (server-action
 * redirects), so every cache below — and the reader's own connection — outlives the person it
 * was read for unless something says otherwise. noteTapIdentity is that something: every server
 * answer carries who it belongs to, and a stamp that moved empties the page and drops the reader.
 */

type Reader = { serialNumber: string; [k: string]: unknown };

type TerminalPlugin = {
  initialize(o: { isTest: boolean; tokenProviderEndpoint?: string }): Promise<void>;
  setConnectionToken(o: { token: string }): Promise<void>;
  discoverReaders(o: { type: string; locationId?: string }): Promise<{ readers: Reader[] }>;
  cancelDiscoverReaders(): Promise<void>;
  connectReader(o: {
    reader: Reader;
    merchantDisplayName?: string;
    autoReconnectOnUnexpectedDisconnect?: boolean;
  }): Promise<void>;
  getConnectedReader(): Promise<{ reader: Reader | null }>;
  disconnectReader(): Promise<void>;
  collectPaymentMethod(o: { paymentIntent: string }): Promise<void>;
  cancelCollectPaymentMethod(): Promise<void>;
  confirmPaymentIntent(): Promise<void>;
  /**
   * Plugin 8.2.0 / SDK 5.5.0, iOS 16.4+: Apple's own "terms accepted?" answer, read fresh on
   * every call, no reader needed — but initialize() must have run (the SDK singleton asserts a
   * token provider before it will even be touched). OPTIONAL on the type because an older shell
   * build's bridge simply won't carry it; that build must get null, not a hang.
   */
  isTapToPayAccountLinked?(o?: { onBehalfOf?: string }): Promise<{ isLinked: boolean }>;
  addListener(event: string, cb: (data: unknown) => void): Promise<{ remove: () => Promise<void> }>;
};

/**
 * CN's own native plugin (ios/App/App, registered as `TapToPayEducation`), built beside this file
 * for the two things Stripe's plugin can't reach: Apple's ProximityReaderDiscovery how-to sheet
 * (iOS 18+, Apple 4.1) and PaymentCardReader.isSupported — the MODEL check, which "doesn't check
 * the OS version". Every method is optional on the type: the plugin ships in a later app build
 * than this page, and a bridge without it must get a sentence, not a hang.
 */
type EducationPlugin = {
  showHowToTap?(): Promise<void>;
  isSupported?(): Promise<{ supported?: unknown; reason?: unknown; osTooOld?: unknown; modelSupported?: unknown }>;
};

type CapacitorGlobal = { Plugins?: Record<string, unknown>; getPlatform?: () => string };

function capacitor(): CapacitorGlobal | null {
  if (typeof window === "undefined" || !isNativeShell()) return null;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  // Tap to Pay on iPHONE. The Android shell, if it ever carries this plugin, is a different
  // product (Tap to Pay on Android) with its own gates; don't offer a door it can't open.
  if (cap?.getPlatform && cap.getPlatform() !== "ios") return null;
  return cap ?? null;
}

function plugin(): TerminalPlugin | null {
  return (capacitor()?.Plugins?.StripeTerminal as TerminalPlugin | undefined) ?? null;
}

function educationPlugin(): EducationPlugin | null {
  return (capacitor()?.Plugins?.TapToPayEducation as EducationPlugin | undefined) ?? null;
}

/** Synchronous: is Stripe's Terminal plugin on the bridge — i.e. is this the iOS shell, with it. */
export function tapToPayPluginPresent(): boolean {
  return plugin() !== null;
}

// ── module state ────────────────────────────────────────────────────────────────────────────
// One page load, one SDK. The plugin guards Terminal.initWithTokenProvider behind its own
// `isInitialize`, and re-reads `isTest` on every initialize() — so initialize is cheap to repeat,
// but the token LISTENER must have exactly one native registration at a time or every request
// gets answered twice. armListeners() keeps that to one while re-registering on every SDK turn.
type ListenerHandle = { remove: () => Promise<void> };
let tokenHandle: ListenerHandle | null = null;
/**
 * Why the last connection-token fetch failed, and what the person can do about it. The SDK's own
 * sentence for a failed token is generic ("Connecting to the reader failed because the app
 * completed fetchConnectionToken with an error"), so the reason has to be kept here and folded
 * into whatever fails next. `kind` picks the fix: a 401 is "sign in again", not "check the
 * internet" (Erik's 2026-09-16 console: "Missing `token` is empty" with no word of why).
 */
type TokenFailure = { reason: string; advice: string; kind: "signed-out" | "network" | "busy" | "setup" };
let lastTokenFailure: TokenFailure | null = null;
let inFlight = false;
let cancelRequested = false;
/**
 * The payment in flight has reached Apple's card sheet (collectPaymentMethod was called) — from
 * here only the collect's own answer may say how it ended. Before this, nothing native is taking
 * a card: the attempt is still finding or connecting the reader, which the plugin cannot cancel.
 */
let readerArmed = false;
/**
 * Answers the Pay Now sheet's Cancel at once while the attempt in flight has not armed the
 * reader yet (collectTapPayment races its attempt against this). null once the reader is armed.
 */
let cancelBeforeReader: (() => void) | null = null;
/**
 * This phone CAN tap — a reader was offered or connected once on this page load. The model and
 * the iOS don't change under a page, so a "yes" is never re-asked; a "no" always is, because its
 * reasons (network, entitlement, setup) can. Dropped when the signed-in identity moves, with
 * every other memo here (noteTapIdentity).
 */
let supportedOnce = false;
/**
 * The SERVER's word on whether this person may accept Apple's terms (tapToPayContext.canEnable:
 * owner/admin), kept for the page load like ctxCache. null = nobody on this page has asked yet.
 * The checkout needs it only in the corner where Apple's own linked answer can't be read
 * (connectIfNeeded), and must not owe the server a round-trip at the moment of the tap (Apple
 * 5.6) — so every read of the context memos it, and the identity stamp on that same answer is
 * what keeps it from outliving the person it was read for.
 */
let canEnableCache: boolean | null = null;
/** The warm-up in progress, if any — collect waits for it, a second prepare shares it. */
let preparing: Promise<TapPrepareResult> | null = null;
/** The Settings "Enable Tap to Pay on iPhone" run in progress — two taps on it share one run. */
let enabling: Promise<TapEnableResult> | null = null;
/**
 * The company's location/name/mode from the LAST successful ensureTerminalLocation, kept for the
 * page load so a foreground warm-up costs no server round-trip (Apple 1.5 wants one on every
 * foreground; driveway LTE does not want a cold function each time). Cleared on any failure of
 * the chain it feeds, so a location that stopped being right can't loop — and cleared the moment
 * the signed-in identity moves, because THIS company's location is the tenant boundary.
 */
let ctxCache: Ctx | null = null;
/** Apple's model answer, once the education plugin has given it — splits "OS" from "model". */
let modelSupported: boolean | null = null;
/**
 * Unattended warm-ups are throttled; the doors a person presses (enable, collect) never are.
 * An unlinked account is re-asked at most once a minute; any other failed warm-up is not
 * re-run for 30 s. Neither memo ever answers "are the terms accepted?" to a screen (Apple 1.6).
 */
let notEnabledAt = 0;
let lastPrepareFailure: { at: number; result: TapPrepareResult } | null = null;
const NOT_ENABLED_RECHECK_MS = 60_000;
const FAILED_WARMUP_RECHECK_MS = 30_000;

// ── whose page is this? ─────────────────────────────────────────────────────────────────────
/**
 * WHO EVERY CACHE ABOVE BELONGS TO — `${orgId}:${userId}`, stamped by the server on every answer
 * that reaches this file (tapToPayContext, ensureTerminalLocation, createTapPaymentIntent).
 *
 * This file used to say "a sign-out is a new page". IT IS NOT. Sign-out and sign-in are Next
 * server-action redirects — soft client transitions, no reload — so this module, its caches and
 * the reader's own native connection all survive one. Signed out of one company and into
 * another, a tap would otherwise run against the FIRST company's Terminal Location and the first
 * person's role. A rule at one read path is a convention; this stamp is the one place every path
 * passes through, and the moment it moves everything learned for the old identity is dropped and
 * the reader is let go.
 */
let identity: string | null = null;
/** When the server last confirmed that identity — the unattended warm-up's own clock. */
let identityAt = 0;
/**
 * How long a cached location may go unconfirmed before the WARM-UP re-asks who is signed in.
 * Nothing on the tap path waits for this (Apple 5.6): a press mints its PaymentIntent, and that
 * answer carries the stamp — so the checkout is reconciled by a round-trip it already makes, and
 * the background warm-up, which makes none, is reconciled on this clock.
 */
const IDENTITY_RECHECK_MS = 5 * 60_000;

/**
 * A server answer said who is signed in. Same person, same company: note when we heard it and go
 * on. A DIFFERENT one: everything this page learned belongs to the identity that left — another
 * company's Stripe location, another person's role, this phone's memos of their failures — and
 * the reader is still connected for that company's account. Drop all of it and disconnect.
 *
 * The device facts (supportedOnce, modelSupported) go too. The hardware did not change; a reset
 * with an exceptions list is the kind somebody eventually gets wrong, and re-learning them costs
 * one probe when a sheet opens, never anything at the press.
 */
export function noteTapIdentity(stamp: string | null | undefined): void {
  if (typeof stamp !== "string" || !stamp) return;
  identityAt = Date.now();
  if (identity === stamp) return;
  const moved = identity !== null;
  identity = stamp;
  // The first stamp on a page has nothing to clear: every cache here is filled by a path that
  // stamps on its way in, so an unstamped page is an empty one.
  if (!moved) return;
  ctxCache = null;
  canEnableCache = null;
  supportedOnce = false;
  modelSupported = null;
  notEnabledAt = 0;
  lastPrepareFailure = null;
  lastTokenFailure = null;
  // Only an ECHO of the old session's reader; the SDK says where the new one stands.
  connStatus = "UNKNOWN";
  reconnectingAt = 0;
  // Not awaited: it takes its SDK turn like any other caller, behind whoever holds one now.
  void disconnectTapReader();
}

// ── one SDK, one caller at a time ───────────────────────────────────────────────────────────
/**
 * The native side is a singleton with ONE discovery slot and ONE `locationId`, and it stores
 * whatever the latest discoverReaders() call passed — so two JS callers interleaving on it is not
 * a race, it is a crash: a support probe's discover (no location) landing between a warm-up's
 * discover and its connect leaves the native `locationId` nil for a force-unwrap. Every SDK
 * conversation therefore takes a TURN here and holds it until it settles; a turn that fails or
 * times out still hands the queue on. Cancel is the one call that deliberately jumps the queue —
 * it exists to interrupt the turn in progress.
 */
let sdkQueue: Promise<unknown> = Promise.resolve();
/** Which turn is current — a caller whose turn has passed must not touch the SDK on its way out. */
let turnSeq = 0;
function withSdk<T>(run: (turn: number) => Promise<T>): Promise<T> {
  const start = () => run(++turnSeq);
  const turn = sdkQueue.then(start, start);
  sdkQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

// ── the timeout, armed first ────────────────────────────────────────────────────────────────
const TIMED_OUT = Symbol("tap-to-pay:timeout");

/** Run `run` with a timer that exists BEFORE `run` is called. Rejects with TIMED_OUT. */
function raced<T>(ms: number, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(TIMED_OUT);
    }, ms);
    let p: Promise<T>;
    try {
      p = run();
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      reject(e);
      return;
    }
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ── progress: what the reader is doing, for any screen that wants to say so ─────────────────
/**
 * Apple 3.9.1 / 5.7: the checkout must show "initializing" with real progress while the phone is
 * being configured, and Settings must show the same during first enablement. Stripe surfaces
 * Apple's configuration as a reader SOFTWARE UPDATE (start → progress 0–1 → finish), fired from
 * inside connectReader before its promise resolves; this bridge adds its own stages around it.
 *
 * `stage` vocabulary (stable strings — other screens key off them):
 *   this bridge, in order: "getting your Stripe location" · "starting the card reader" ·
 *     "checking the reader" · "reconnecting the reader" · "finding the reader" ·
 *     "connecting the reader" · "configuring the reader" (the only stage with a percent) ·
 *     then, for a payment, "waiting for the tap" · "confirming with Stripe";
 *   resting states: "ready" (reader connected, nothing in progress) · "not ready" (no reader —
 *     it dropped, the app was backgrounded, or the last attempt failed and its sentence was
 *     returned to whoever asked).
 * `percent` is 0–100 during "configuring the reader" and null everywhere else — HIG: determinate
 * while the SDK reports progress, indeterminate otherwise.
 */
export type TapProgress = { stage: string; percent: number | null };

const STAGE = {
  location: "getting your Stripe location",
  starting: "starting the card reader",
  checking: "checking the reader",
  reconnecting: "reconnecting the reader",
  finding: "finding the reader",
  connecting: "connecting the reader",
  configuring: "configuring the reader",
  tapping: "waiting for the tap",
  confirming: "confirming with Stripe",
  ready: "ready",
  notReady: "not ready",
} as const;

const progressSubs = new Set<(p: TapProgress) => void>();
/** The last thing published, replayed to a late subscriber so a screen mounting mid-connect sees it. */
let lastProgress: TapProgress | null = null;

function publish(stage: string, percent: number | null = null): void {
  const p: TapProgress = { stage, percent };
  lastProgress = p;
  for (const cb of Array.from(progressSubs)) {
    try {
      cb(p);
    } catch {
      /* a subscriber's bug is not the reader's problem — the next subscriber still hears */
    }
  }
}

/**
 * Subscribe to reader configuration / software-update progress and to this bridge's own stage
 * changes. The current state (if any) is replayed on the next microtask, so a checkout that
 * mounts while a warm-up is mid-connect shows "connecting the reader" at once instead of nothing.
 * Returns the unsubscribe.
 */
export function onTapProgress(cb: (p: TapProgress) => void): () => void {
  progressSubs.add(cb);
  const last = lastProgress;
  if (last) {
    queueMicrotask(() => {
      if (!progressSubs.has(cb)) return;
      try {
        cb(last);
      } catch {
        /* as above */
      }
    });
  }
  return () => {
    progressSubs.delete(cb);
  };
}

// ── the SDK's own signals: update progress + connection status ──────────────────────────────
type ConnStatus = "CONNECTED" | "CONNECTING" | "NOT_CONNECTED" | "RECONNECTING" | "UNKNOWN";
/**
 * What the SDK last said about the reader link — reconnects happen without any JS turn. This is
 * an ECHO, not a read: the plugin exposes no connectionStatus getter, only the change event, so
 * a fresh page (every app launch, every reload) starts blind at UNKNOWN while the native
 * singleton may already be mid-reconnect. connectIfNeeded treats a collision as the missing
 * word rather than as a failure for exactly that reason.
 */
let connStatus: ConnStatus = "UNKNOWN";
/**
 * The SDK's own reconnect is running (terminalReaderReconnectStarted, not yet Succeeded/Failed).
 * Apple's reader is busy under it whatever getConnectedReader says — the SDK keeps the reader
 * object while it reconnects — so a collect started now answers "reader busy" (code 20).
 */
let reconnectingAt = 0;
/**
 * A reconnect is believed for this long without a verdict. The flag is set by one event and
 * cleared by another; a verdict this page never hears (a bridge without the event, a missed
 * delivery) must cost one wait, not a wait before every tap for the life of the page.
 */
const RECONNECT_BELIEF_MS = 90_000;
const statusWaiters = new Set<(s: ConnStatus) => void>();
let sdkHandles: ListenerHandle[] = [];

/** The SDK's own reconnect is running, as far as this page knows. */
function reconnecting(): boolean {
  return reconnectingAt > 0 && Date.now() - reconnectingAt < RECONNECT_BELIEF_MS;
}

/** The SDK settled on `s`: remember it, wake every waiter, say it on the progress feed. */
function settle(s: ConnStatus): void {
  connStatus = s;
  if (s === "CONNECTED" || s === "NOT_CONNECTED") reconnectingAt = 0;
  for (const w of Array.from(statusWaiters)) w(s);
  if (s === "CONNECTED") publish(STAGE.ready);
  else if (s === "RECONNECTING") publish(STAGE.reconnecting);
  else if (s === "CONNECTING") publish(STAGE.connecting);
  else if (s === "NOT_CONNECTED") publish(STAGE.notReady);
}

/** The SDK, or Apple's reader under it, is mid-way through something this turn didn't start. */
function sdkMidway(): boolean {
  return reconnecting() || connStatus === "CONNECTING" || connStatus === "RECONNECTING";
}

function percentOf(d: unknown): number | null {
  const v = (d as { progress?: unknown } | null)?.progress;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v * 100)));
}

function statusOf(d: unknown): ConnStatus {
  const s = (d as { status?: unknown } | null)?.status;
  return s === "CONNECTED" || s === "CONNECTING" || s === "NOT_CONNECTED" || s === "RECONNECTING" ? s : "UNKNOWN";
}

/**
 * Registered before initialize on every SDK turn, like the token listener (armListeners). The
 * update trio IS Apple's configuration progress (Stripe: "you'll see the configuration steps as
 * a software update so you can display progress"). The status stream is how a foreground
 * reconnect — which the SDK runs on its own, autoReconnectOnUnexpectedDisconnect — becomes
 * visible here at all.
 */
async function armSdkListeners(p: TerminalPlugin): Promise<void> {
  const old = sdkHandles;
  sdkHandles = [];
  for (const h of old) await h.remove().catch(() => {});
  const add = async (event: string, cb: (d: unknown) => void) => {
    sdkHandles.push(await p.addListener(event, cb));
  };
  await add("terminalStartInstallingUpdate", () => publish(STAGE.configuring, 0));
  await add("terminalReaderSoftwareUpdateProgress", (d) => publish(STAGE.configuring, percentOf(d)));
  await add("terminalFinishInstallingUpdate", (d) => {
    // A finish WITH an error is followed by the connect's own rejection, which carries the sentence.
    const failed = typeof (d as { error?: unknown } | null)?.error === "string";
    if (!failed) publish(STAGE.configuring, 100);
  });
  await add("terminalConnectionStatusChange", (d) => settle(statusOf(d)));
  // The reconnect trio (plugin 6.2+): the SDK's own foreground reconnect, start to verdict. The
  // status stream says RECONNECTING too, but the verdict events are the ones that can't be
  // missed — a reconnect that fails ends in NOT_CONNECTED, one that succeeds in CONNECTED, and
  // either way the "busy under it" flag comes down. A build whose bridge lacks an event simply
  // never fires it; the status stream still carries the turn.
  await add("terminalReaderReconnectStarted", () => {
    reconnectingAt = Date.now();
    settle("RECONNECTING");
  });
  await add("terminalReaderReconnectSucceeded", () => settle("CONNECTED"));
  await add("terminalReaderReconnectFailed", () => settle("NOT_CONNECTED"));
  await add("terminalUnexpectedReaderDisconnect", () => {
    // The SDK reconnects on its own (autoReconnectOnUnexpectedDisconnect); until it says so,
    // the reader is not there for a tap.
    if (!reconnecting()) settle("NOT_CONNECTED");
  });
}

/** The next status that isn't "still connecting", or TIMED_OUT. The waiter is always removed. */
function nextSettledStatus(ms: number): Promise<ConnStatus> {
  const box: { w: ((s: ConnStatus) => void) | null } = { w: null };
  return raced(
    ms,
    () =>
      new Promise<ConnStatus>((resolve) => {
        box.w = (s) => {
          if (s === "CONNECTING" || s === "RECONNECTING") return;
          resolve(s);
        };
        statusWaiters.add(box.w);
      }),
  ).finally(() => {
    if (box.w) statusWaiters.delete(box.w);
  });
}

// ── the connection token, answered from the session, not from a bare native POST ───────────
/**
 * The SDK asks for a token whenever it needs to talk to Stripe (first connect, every reconnect),
 * by emitting `terminalRequestedConnectionToken`; we answer with setConnectionToken. The plugin's
 * alternative — a `tokenProviderEndpoint` it POSTs to natively — sends no cookies, so it could
 * never pass requireStaff. This listener is registered BEFORE initialize(), as the plugin's
 * README insists, and registered again at the start of every SDK turn (armListeners says why).
 *
 * THE PLUGIN'S ONLY ERROR CHANNEL IS AN EMPTY TOKEN. setConnectionToken({ token: "" }) is, in
 * the plugin's Swift (APIClient.setConnectionToken), the one way to hand the SDK's pending
 * request an ERROR: it calls the SDK's completion with an NSError ("Missing `token` is empty")
 * and rejects our own call with the same words. So on failure that is exactly what happens, on
 * purpose — the SDK then fails the command that needed the token at once (SCPError 9050,
 * "…the app completed fetchConnectionToken with an error") instead of waiting 60 s for an
 * answer that isn't coming (9052). The rejection of OUR call is swallowed below; in a Debug
 * build Capacitor's bridge logger still prints every rejected plugin call to the console, which
 * is where Erik's 2026-09-16 1:03 PM "Missing `token` is empty" came from: the token fetch
 * failed, and this line is the SDK being told so. The real reason is kept in lastTokenFailure
 * and folded into the sentence the caller sees (classify / failure).
 *
 * The request runs on a clock armed BEFORE it (a stalled LTE fetch has no natural end, and the
 * SDK's own patience is 60 s), and a failure that can pass (no network, a 5xx, a non-JSON body)
 * is tried once more; a 401/403/429/400 is an answer, not weather, and is not retried. Every
 * request is answered EXACTLY ONCE: the plugin queues completions first-in-first-out and pops
 * one per setConnectionToken, so a request left unanswered would shift every later answer onto
 * the wrong request for the life of the process.
 */
const TOKEN_FETCH_MS = 15_000;
const TOKEN_RETRY_PAUSE_MS = 1_500;

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type TokenFetch = { secret: string } | { failure: TokenFailure; retryable: boolean };

/** One POST to the token route, on a clock armed before the request. Never throws. */
async function fetchToken(): Promise<TokenFetch> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TOKEN_FETCH_MS);
  try {
    const r = await fetch("/api/stripe/terminal/token", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: ctl.signal,
    });
    const body = (await r.json().catch(() => ({}))) as { secret?: unknown; error?: unknown };
    if (r.ok && typeof body.secret === "string" && body.secret) return { secret: body.secret };
    const reason = typeof body.error === "string" && body.error ? body.error.replace(/\.$/, "") : `the server answered ${r.status}`;
    // The route's own refusals (src/app/api/stripe/terminal/token/route.ts), by status.
    if (r.status === 401) {
      return {
        failure: { reason, advice: "Sign in to the North app again on this phone, then try the tap.", kind: "signed-out" },
        retryable: false,
      };
    }
    if (r.status === 403) return { failure: { reason, advice: "Ask an owner or admin to take this payment.", kind: "setup" }, retryable: false };
    if (r.status === 429) return { failure: { reason, advice: "Wait a minute, then try again.", kind: "busy" }, retryable: false };
    if (r.status === 400 || r.status === 503) return { failure: { reason, advice: "", kind: "setup" }, retryable: false };
    if (r.ok) {
      // 200 without a secret: a page that isn't this route (a host error page, a redirect).
      return { failure: { reason: "the server answered without a session", advice: "Try again in a moment.", kind: "network" }, retryable: true };
    }
    return { failure: { reason, advice: "Try again in a moment.", kind: "network" }, retryable: true };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    const said = e instanceof Error && e.message && !aborted ? e.message : "";
    return {
      failure: {
        reason: aborted ? "the server didn't answer in time" : `couldn't reach the server${said ? ` (${said})` : ""}`,
        advice: "Check the internet connection and try again.",
        kind: "network",
      },
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function feedToken(p: TerminalPlugin): Promise<void> {
  let got = await fetchToken();
  if ("failure" in got && got.retryable) {
    await pause(TOKEN_RETRY_PAUSE_MS);
    got = await fetchToken();
  }
  let secret = "";
  if ("secret" in got) {
    secret = got.secret;
    lastTokenFailure = null;
  } else {
    lastTokenFailure = got.failure;
  }
  try {
    await p.setConnectionToken({ token: secret });
  } catch {
    /* an empty token rejects by design (see above) — the SDK has already been told no */
  }
}

async function armTokenProvider(p: TerminalPlugin): Promise<void> {
  const old = tokenHandle;
  tokenHandle = null;
  if (old) await old.remove().catch(() => {});
  tokenHandle = await p.addListener("terminalRequestedConnectionToken", () => {
    void feedToken(p);
  });
}

/**
 * THE LISTENERS ARE REGISTERED AGAIN ON EVERY SDK TURN (2026-09-23, Erik's evening of 9052s).
 * Capacitor empties every native plugin listener the moment ANY main-frame navigation STARTS
 * (didStartProvisionalNavigation → bridge.reset()), and a navigation that then fails leaves the
 * old page running: Next's fallback to a full load on a failed RSC fetch, a foreground refresh on
 * bad signal. The page lives on, sure it is listening, while the SDK's token requests go to
 * nobody and every connect dies at Stripe's 60 s. Nothing tells JS the listeners went, so each
 * turn removes what it registered last and registers again. Remove BEFORE add: the native side
 * keeps exactly one registration, because two would answer each token request twice and hand the
 * spare answer to whatever request comes next. Re-arms take turns among themselves too, so a turn
 * a timeout abandoned can never interleave its swap with the next turn's.
 */
let arming: Promise<void> = Promise.resolve();
function armListeners(p: TerminalPlugin): Promise<void> {
  const run = arming.then(async () => {
    await armTokenProvider(p);
    await armSdkListeners(p).catch(() => {});
  });
  arming = run.catch(() => {});
  return run;
}

/**
 * Listeners first, THEN initialize — the SDK may ask for a token as part of initializing. The
 * progress/status listeners ride along; they are a courtesy layer, so their (theoretical)
 * registration failure must never cost a payment. EVERY other SDK call comes after this: the
 * singleton asserts its token provider on first touch, and getConnectedReader() before
 * initialize() is that first touch.
 */
async function initialise(p: TerminalPlugin, isTest: boolean): Promise<void> {
  await armListeners(p);
  await p.initialize({ isTest });
}

// ── words ───────────────────────────────────────────────────────────────────────────────────
function said(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return typeof e === "string" ? e : "";
}

/** Capacitor rejects with the plugin's errorDetails on `.data`; the plugin puts a decline code there. */
function declineOf(e: unknown): string | null {
  const d = (e as { data?: { declineCode?: unknown } } | null)?.data;
  return typeof d?.declineCode === "string" && d.declineCode ? d.declineCode : null;
}

/** Capacitor's own code on a rejection — "UNAVAILABLE" / "UNIMPLEMENTED" when a plugin says so. */
function codeOf(e: unknown): string | null {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && c ? c : null;
}

const NOT_IN_BUILD = "Tap to Pay on iPhone isn't available in this app build — it works in the North iPhone app.";
const PAYMENT_BUSY = "A card payment is already in progress on this phone.";
/** A Cancel answered before the reader was armed: the connect it interrupted is still settling natively. */
// "A few seconds" was untrue after an early Cancel: the attempt keeps its turn for the whole
// connect, which can be a minute, and a first-time Apple setup longer (review of the 09-23 wave).
const ATTEMPT_FINISHING = "The last Tap to Pay on iPhone attempt on this phone is still finishing. Wait a moment, then try again. The first connect can take a minute.";
const CANCELLED: TapCollectResult = { ok: false, cancelled: true, error: "Cancelled. Nothing was charged." };

/** Why this phone can't start another Tap to Pay on iPhone step right now, in true words. */
function busySentence(): string {
  return readerArmed ? PAYMENT_BUSY : ATTEMPT_FINISHING;
}

/**
 * The plugin hands JS the SDK's localizedDescription and nothing else — no error code — so the
 * cases Apple wants named (update iOS, wrong model, missing entitlement, the terms) can only be
 * told apart by the SDK's own wording. The strings below are the SDK 5.7.0 binary's, verbatim
 * (SCPErrors.h codes in brackets); matching is on their distinctive fragments, so a minor
 * rewording upstream degrades to the generic sentence rather than to a wrong one.
 */
export type TapFailKind =
  | "os"
  | "device"
  | "entitlement"
  | "terms-declined"
  | "terms-needed"
  | "apple-account"
  | "blocked"
  | "passcode"
  | "phone-call"
  | "location"
  | "background"
  | "network"
  | "busy"
  | "signed-out"
  | "setup"
  | "listener-lost";

const OS_SENTENCE =
  "This iPhone's iOS is too old for Tap to Pay on iPhone — update it in Settings › General › Software Update, then try again. Until then, send the customer the pay link.";
const DEVICE_SENTENCE =
  "Tap to Pay on iPhone needs an iPhone XS or newer — this iPhone can't take a tap. Send the customer the pay link instead.";
const ENTITLEMENT_SENTENCE =
  "Apple hasn't cleared this build of the North app for Tap to Pay on iPhone yet — install the next app update once it's out. Until then, send the customer the pay link.";
const TERMS_NEEDED_SENTENCE =
  "Tap to Pay on iPhone isn't enabled for this company yet — an owner or admin turns it on in Settings › Getting Paid, where Apple's terms are accepted.";
const TERMS_DECLINED_SENTENCE =
  "Apple's Tap to Pay on iPhone terms weren't accepted, so nothing was enabled — tap Enable Tap to Pay on iPhone again when you're ready to accept them.";
/** Apple's linked answer couldn't be read, and this caller may not meet the sheet (3.8 / 3.8.1). */
const TERMS_UNKNOWN_SENTENCE =
  "This iPhone couldn't confirm that Apple's Tap to Pay on iPhone terms are accepted for this company, so nothing was connected — ask an owner or admin to enable it in Settings › Getting Paid › Enable Tap to Pay on iPhone, then try again.";
const NETWORK_SENTENCE = "Couldn't reach Stripe from this phone — check the internet connection and try again.";
const BUSY_SENTENCE =
  "The Tap to Pay on iPhone reader on this phone is still busy with its last request — it's usually still warming up. Wait a few seconds, then try again; if it keeps saying that, fully close the North app and reopen it.";
/** [1110] after connectIfNeeded already waited and tried once more: the earlier connection is still going. */
const STILL_CONNECTING_SENTENCE =
  "This iPhone is still finishing an earlier Tap to Pay on iPhone connection. Wait a moment, then press Tap to Pay again.";
/**
 * [9052] the SDK gave up waiting 60 s for this phone's session answer, and this page never
 * fetched one for it: the request went to no listener (armListeners). It used to be worded as a
 * network problem, which sent Erik to his signal bars. The next SDK turn registers the listener
 * again, so a retry usually works; the restart is the fix that always does. Most likely, not
 * proof: lastTokenFailure is also empty after any earlier classified failure or a change of who
 * is signed in, and the sentence is true either way.
 */
const TOKEN_UNHEARD_SENTENCE =
  "This phone lost track of the card reader. Try again, and if the same thing happens, close the North app fully, reopen it, and try once more.";

/** The sentence for a token fetch that failed: the reason, then the fix. */
function tokenSentence(f: TokenFailure): string {
  return `Couldn't start a Stripe session for this company (${f.reason}).${f.advice ? ` ${f.advice}` : ""}`;
}

/** Apple's reader (codes 20 readerBusy, 43 readerSessionBusy, 12 notReady) or the SDK ([3010]) is still on an earlier request. */
function isBusy(e: unknown): boolean {
  const m = said(e);
  const rc = /SCPTapToPayReaderErrorDomain error (\d+)/i.exec(m);
  if (rc) return rc[1] === "20" || rc[1] === "43" || rc[1] === "12";
  return /^The reader is busy\.?$/i.test(m);
}

/**
 * [1110] "Already connected to a reader. Disconnect from the reader, or power it off before
 * trying again." The SDK raises it from discover/connect whenever its connectionStatus is not
 * notConnected — CONNECTED, but also CONNECTING or RECONNECTING with connectedReader still nil —
 * so it is the word for "mid-connection" as much as for "connected".
 */
function isAlreadyConnected(e: unknown): boolean {
  return /Already connected to a reader/i.test(said(e));
}

/**
 * Apple's reader errors reach JS with NO words at all — Erik's 2026-09-11 console:
 * "The operation couldn't be completed. (SCPTapToPayReaderErrorDomain error 20.)". The SDK
 * passes ProximityReader's failure through under its own domain, and the code is the ONLY
 * information. The numbers are the SDK 5.7.0 `TapToPayReaderErrorCode` enum (StripeTerminal
 * .swiftinterface: `case unknown = 0` then implicit, so the raw value is the case's position).
 * Only the codes a person can act on are named; the rest fall to the stage's generic sentence.
 */
const READER_CODE: Record<number, { kind: TapFailKind; sentence: string }> = {
  3: { kind: "passcode", sentence: "Tap to Pay on iPhone needs a passcode on this iPhone — set one in Settings › Face ID & Passcode, then try again." }, // passcodeDisabled
  5: { kind: "background", sentence: "The app went to the background before the tap finished — keep the app on screen and try again." }, // backgroundRequestNotAllowed
  6: { kind: "device", sentence: DEVICE_SENTENCE }, // unsupported
  7: { kind: "os", sentence: OS_SENTENCE }, // osVersionNotSupported
  8: { kind: "device", sentence: DEVICE_SENTENCE }, // modelNotSupported
  9: { kind: "network", sentence: NETWORK_SENTENCE }, // networkError
  10: { kind: "network", sentence: NETWORK_SENTENCE }, // networkAuthenticationError
  11: { kind: "network", sentence: NETWORK_SENTENCE }, // serviceConnectionError
  12: { kind: "busy", sentence: "Tap to Pay on iPhone is still getting ready on this phone — give it a moment, then try again." }, // notReady
  18: { kind: "blocked", sentence: "Apple has banned this iPhone from Tap to Pay on iPhone — contact Stripe support." }, // deviceBanned
  20: { kind: "busy", sentence: BUSY_SENTENCE }, // readerBusy
  21: { kind: "terms-needed", sentence: TERMS_NEEDED_SENTENCE }, // accountNotLinked
  23: { kind: "apple-account", sentence: "Accepting Apple's Tap to Pay on iPhone terms needs an Apple Account signed in on this iPhone — sign in at the top of Settings, then tap Enable Tap to Pay on iPhone again." }, // accountLinkingRequiresiCloudSignIn
  24: { kind: "terms-declined", sentence: TERMS_DECLINED_SENTENCE }, // accountLinkingCancelled
  27: { kind: "blocked", sentence: "Apple has blocked this company's account for Tap to Pay on iPhone — contact Stripe support." }, // merchantBlocked
  29: { kind: "background", sentence: "The tap was interrupted before it finished — keep the app on screen and try again." }, // requestInterrupted
  35: { kind: "background", sentence: "The app went to the background before the tap finished — keep the app on screen and try again." }, // readFromBackgroundError
  43: { kind: "busy", sentence: BUSY_SENTENCE }, // readerSessionBusy
  47: { kind: "device", sentence: "NFC is turned off on this iPhone, so it can't read a card — turn it on in Settings, then try again." }, // nfcDisabled
  48: { kind: "phone-call", sentence: "Tap to Pay on iPhone can't run during a phone call — end the call, then try again." }, // readNotAllowedDuringCall
};

function classify(e: unknown): { kind: TapFailKind; sentence: string } | null {
  const m = said(e);
  if (!m) return null;
  // The wordless pass-through: "(SCPTapToPayReaderErrorDomain error N.)" — decode N first,
  // since none of the phrase matches below can see anything in it.
  const rc = /SCPTapToPayReaderErrorDomain error (\d+)/i.exec(m);
  if (rc) {
    const known = READER_CODE[Number(rc[1])];
    if (known) return known;
  }
  // [2910] "Unsupported mobile device configuration. Ensure the device is running a supported
  // version of iOS and it has the hardware capability…" — ONE string for two causes. Apple's own
  // model answer (education plugin) splits them; without it the OS is the suspect Apple's 1.4
  // copy is written for, and the sentence still names the model floor.
  if (/Unsupported mobile device configuration/i.test(m)) {
    return modelSupported === false ? { kind: "device", sentence: DEVICE_SENTENCE } : { kind: "os", sentence: OS_SENTENCE };
  }
  // [2900] "Operation not permitted. Verify the app has the necessary entitlements…"
  if (/Operation not permitted/i.test(m) && /entitlement/i.test(m)) return { kind: "entitlement", sentence: ENTITLEMENT_SENTENCE };
  // [2920] "…must have a passcode set. Configure one in iOS Settings and try again."
  if (/passcode/i.test(m)) {
    return {
      kind: "passcode",
      sentence: "Tap to Pay on iPhone needs a passcode on this iPhone — set one in Settings › Face ID & Passcode, then try again.",
    };
  }
  // [2930] "The card reader cannot be used while a phone call is active."
  if (/phone call/i.test(m)) {
    return { kind: "phone-call", sentence: "Tap to Pay on iPhone can't run during a phone call — end the call, then try again." };
  }
  // [2200] "Access to location services is currently disabled. Location access is required…"
  if (/location services|location access/i.test(m)) {
    return {
      kind: "location",
      sentence:
        "Tap to Pay on iPhone needs Location for the North app — allow it in Settings › Privacy & Security › Location Services › North, then try again.",
    };
  }
  // [2960] "Failed to present reader-specific terms of service… sign into an appropriate iCloud
  // account…" — checked BEFORE the other terms strings, which it also contains.
  if (/iCloud/i.test(m)) {
    return {
      kind: "apple-account",
      sentence:
        "Accepting Apple's Tap to Pay on iPhone terms needs an Apple Account signed in on this iPhone — sign in at the top of Settings, then tap Enable Tap to Pay on iPhone again.",
    };
  }
  // [2970] "Reader-specific terms of service acceptance canceled."
  if (/terms of service acceptance cancel/i.test(m)) return { kind: "terms-declined", sentence: TERMS_DECLINED_SENTENCE };
  // [3930] "…the reader-specific terms of service have not yet been accepted. Try connecting again."
  if (/terms of service have not yet been accepted/i.test(m)) return { kind: "terms-needed", sentence: TERMS_NEEDED_SENTENCE };
  // [3940] "Failed to link merchant account to the provided Apple ID. Ensure the Apple ID is still active…"
  if (/Failed to link merchant account/i.test(m)) {
    return {
      kind: "apple-account",
      sentence:
        "Apple couldn't link this company to the signed-in Apple Account — check that account is active and in good standing, then try again.",
    };
  }
  // [3950] "This merchant account cannot be used with the built-in card reader as it has been blocked…"
  if (/has been blocked/i.test(m)) {
    return {
      kind: "blocked",
      sentence:
        "Apple has blocked this company's account for Tap to Pay on iPhone (it happens after too many Stripe accounts on one iPhone in a day) — contact Stripe support.",
    };
  }
  // [3920] "Device banned. Contact support for details."
  if (/Device banned/i.test(m)) {
    return { kind: "blocked", sentence: "Apple has banned this iPhone from Tap to Pay on iPhone — contact Stripe support." };
  }
  // [3905] "The application went to background before a reader request completed."
  if (/went to background/i.test(m)) {
    return { kind: "background", sentence: "The app went to the background before the tap finished — keep the app on screen and try again." };
  }
  // [1110] the SDK is mid-connection (see isAlreadyConnected). connectIfNeeded waits it out and
  // tries once more before this sentence can be reached; by then it is the truth.
  if (isAlreadyConnected(e)) return { kind: "busy", sentence: STILL_CONNECTING_SENTENCE };
  // [3010] "The reader is busy." — the SDK's own busy, distinct from Apple's code 20 above.
  if (/^The reader is busy\.?$/i.test(m)) return { kind: "busy", sentence: BUSY_SENTENCE };
  // THE TOKEN PROVIDER, in the SDK 5.7.0 binary's words: [9050] "Connecting to the reader failed
  // because the app completed fetchConnectionToken with an error." [1510] "…your app's
  // ConnectionTokenProvider called the completion block with no token and no error…" [9052]
  // "Your app's ConnectionTokenProvider did not call the provided completion block within 60
  // seconds." — plus the plugin's own rejection of our empty answer. None of them says WHY; the
  // reason is lastTokenFailure when this page fetched it, and its advice is the fix.
  if (/fetchConnectionToken|ConnectionTokenProvider|connection token|Missing `token`/i.test(m)) {
    const f = lastTokenFailure;
    if (f) return { kind: f.kind, sentence: tokenSentence(f) };
    // Every fetch this page makes ends in an answer inside ~32 s (feedToken), and a failed one is
    // remembered above. A 60-second wait with nothing remembered means no fetch ever ran. So does a
    // 9050 with nothing remembered: since 2026-09-24 the patched plugin answers a token request
    // that no page is listening for with an error at once, instead of letting it run out the 60 s.
    if (/within 60 seconds|completed fetchConnectionToken with an error|No page is listening/i.test(m)) {
      return { kind: "listener-lost", sentence: TOKEN_UNHEARD_SENTENCE };
    }
    return { kind: "network", sentence: NETWORK_SENTENCE };
  }
  if (/network|offline|internet/i.test(m)) return { kind: "network", sentence: NETWORK_SENTENCE };
  return null;
}

const STAGE_PREFIX: Record<string, string> = {
  [STAGE.location]: "Couldn't set up Tap to Pay on iPhone for this company",
  [STAGE.starting]: "Couldn't start the card reader",
  [STAGE.checking]: "Couldn't check the card reader",
  [STAGE.reconnecting]: "Couldn't reconnect the Tap to Pay on iPhone reader",
  [STAGE.finding]: "Couldn't find the Tap to Pay on iPhone reader on this phone",
  [STAGE.connecting]: "Couldn't connect the Tap to Pay on iPhone reader",
  [STAGE.tapping]: "The tap didn't go through",
  [STAGE.confirming]: "Stripe couldn't confirm the payment",
};

/** The sentence for a failure at `stage`, and the kind when the SDK's wording named one. */
function failure(stage: string, e: unknown): { error: string; kind: TapFailKind | null } {
  const known = classify(e);
  if (known) {
    lastTokenFailure = null;
    return { error: known.sentence, kind: known.kind };
  }
  const prefix = STAGE_PREFIX[stage] ?? "Tap to Pay on iPhone didn't finish";
  const msg = said(e);
  // A token that failed on the way here is the likelier cause than whatever the SDK said last;
  // its reason and fix ride along whatever the wording.
  const f = lastTokenFailure;
  lastTokenFailure = null;
  const token = f ? ` Stripe session: ${f.reason}.${f.advice ? ` ${f.advice}` : ""}` : "";
  return { error: `${prefix}${msg ? ` — ${msg}` : ""}.${token}`, kind: f?.kind ?? null };
}

function describeFailure(stage: string, e: unknown): string {
  return failure(stage, e).error;
}

/**
 * Thrown inside a turn when this door must NOT connect (Apple 3.8): Apple said the account is
 * "unlinked", or Apple's answer is "unknown" and the caller isn't someone who may accept the
 * terms. The message is the sentence the caller hands back — both name the Settings door. `why`
 * is for the memos: only a real "no" from Apple is worth not re-asking for a minute.
 */
class NotEnabledError extends Error {
  readonly why: "unlinked" | "unknown";
  constructor(why: "unlinked" | "unknown") {
    super(why === "unlinked" ? TERMS_NEEDED_SENTENCE : TERMS_UNKNOWN_SENTENCE);
    this.name = "NotEnabledError";
    this.why = why;
  }
}

// ── the reader ──────────────────────────────────────────────────────────────────────────────
type Ctx = { locationId: string; merchantDisplayName: string; livemode: boolean };

/**
 * Apple's "terms accepted?" answer through the SDK — read on EVERY call, never cached (Apple
 * 1.6). Assumes initialise() has run and that the caller holds the SDK turn. null = cannot be
 * known here: an older shell build without the method, iOS < 16.4 (the plugin answers
 * `unavailable`), a Stripe error, or no answer in time. Direct charges: no onBehalfOf — the
 * connection token already belongs to the tenant, so nil means "the account the SDK is acting
 * as". (That reading is Stripe's Connect guidance, not a line in the header; a connected reader
 * is taken as stronger evidence than a "false" from here — see tapToPayAccountLinked.)
 */
async function readLinked(p: TerminalPlugin): Promise<boolean | null | "busy"> {
  const ask = p.isTapToPayAccountLinked;
  if (typeof ask !== "function") return null;
  try {
    const { isLinked } = await raced(10_000, () => ask.call(p));
    return typeof isLinked === "boolean" ? isLinked : null;
  } catch (e) {
    // Apple's reader was on something else (a reconnect finishing under this turn) — that is
    // "ask again in a moment", not "Apple couldn't say", and the caller waits and re-asks.
    return isBusy(e) || isAlreadyConnected(e) ? "busy" : null;
  }
}

type ConnectOpts = {
  /**
   * "present": an unlinked account may connect, and the SDK raises Apple's terms sheet (the
   * Settings door, shown to owners/admins). "refuse": the connect happens only once Apple has
   * said the account IS linked — an unlinked account, or one Apple couldn't answer for, throws
   * NotEnabledError before any connect. The warm-up and the checkout, where a technician might
   * be holding the phone.
   */
  terms: "present" | "refuse";
  /**
   * With "refuse": the SERVER has said this caller may accept Apple's terms (tapToPayContext's
   * canEnable — owner/admin). Then, and only then, an answer Apple COULDN'T give lets the connect
   * go on: the sheet, if it appears, is theirs to read (Apple 5.3), and refusing would dead-end a
   * linked account on a build that can't ask. The unattended warm-up never sets it.
   */
  canEnable?: boolean;
  /** How long the connect may take — the terms sheet + Apple's first configuration live inside it. */
  connectMs: number;
};

/**
 * Discover + connect, unless a reader is already connected (Stripe recommends connecting ahead
 * and staying connected; the reader drops on its own when the app backgrounds). The FIRST
 * connect on a phone for a given Stripe account is the slow one: Apple presents its Tap to Pay
 * terms (Apple ID sign-in, an admin's job) and may run a configuration update "up to a few
 * minutes" — hence the long timeout and the stage text that says what's happening.
 *
 * locationId is REQUIRED at discovery: the native side stores it there and force-unwraps it at
 * connect, so a discover without it doesn't reject, it crashes the app on connect.
 *
 * Every stage is published to onTapProgress as well as handed to the caller's `setStage`, so a
 * checkout pressed mid-configuration shows "initializing" with the SDK's percent (Apple 5.7).
 */
async function connectIfNeeded(p: TerminalPlugin, ctx: Ctx, setStage: (s: string) => void, opts: ConnectOpts): Promise<void> {
  const go = (s: string) => {
    setStage(s);
    publish(s);
  };
  go(STAGE.checking);
  // THE SDK'S OWN WORK COMES FIRST (Erik's 2026-09-16: four "reader busy" (code 20) and one
  // "Already connected to a reader" in one afternoon, and no tap went through). The SDK reconnects
  // on its own after every foreground (autoReconnectOnUnexpectedDisconnect), keeping the reader
  // object while it does — so a getConnectedReader that answers "yes" can be a reader Apple is
  // still preparing, and a collect on it answers code 20. A connect a timed-out turn abandoned is
  // the same thing from the other side: still running natively, connectedReader nil, and a
  // second discover/connect on top of it is "Already connected" (1110). Neither is a failure;
  // both are "wait for the SDK's verdict, then look again".
  await awaitSdkVerdict(go, 30_000);
  if (await readerConnected(p)) {
    publish(STAGE.ready);
    return;
  }
  if (opts.terms === "refuse") {
    let linked = await readLinked(p);
    if (linked === "busy") {
      // Apple's reader was on something else when asked — let it finish and ask once more; a
      // reader that connected meanwhile is the answer itself.
      go(STAGE.reconnecting);
      await nextSettledStatus(15_000).catch(() => {});
      if (await readerConnected(p)) {
        publish(STAGE.ready);
        return;
      }
      linked = await readLinked(p);
      if (linked === "busy") linked = null;
    }
    if (linked === false) throw new NotEnabledError("unlinked");
    // Apple couldn't answer (an older shell build, iOS < 16.4, a Stripe error, no answer in
    // time). A connect now would still raise Apple's sheet if the account is unlinked — in front
    // of whoever holds the phone — so it happens only for a caller the server has cleared to
    // read that sheet. Everyone else is told the phone couldn't confirm, and where the terms get
    // accepted (3.8.1); the warm-up simply skips this round and asks Apple again next foreground.
    if (linked === null && opts.canEnable !== true) throw new NotEnabledError("unknown");
  }
  try {
    await discoverAndConnect(p, ctx, go, opts);
  } catch (e) {
    if (!isBusy(e) && !isAlreadyConnected(e)) throw e;
    // A collision after all: this page only HEARS the SDK's status change (there is no getter),
    // so on a fresh page the first word can arrive after this turn began. The collision is that
    // word. Let the SDK finish, take the reader if it is there; else clear what it left and try
    // once more — the second answer is the answer (classify names it: STILL_CONNECTING_SENTENCE).
    go(STAGE.reconnecting);
    await nextSettledStatus(20_000).catch(() => {});
    if (await readerConnected(p)) {
      publish(STAGE.ready);
      return;
    }
    if (isAlreadyConnected(e)) await raced(5_000, () => p.disconnectReader()).catch(() => {});
    await discoverAndConnect(p, ctx, go, opts);
  }
  publish(STAGE.ready);
}

/** Wait, bounded, while the SDK is connecting or reconnecting on its own. Silence is not a verdict. */
async function awaitSdkVerdict(go: (s: string) => void, ms: number): Promise<void> {
  if (!sdkMidway()) return;
  go(STAGE.reconnecting);
  await nextSettledStatus(ms).catch(() => {});
}

/** Is a reader on the line, and not one the SDK is still reconnecting under. */
async function readerConnected(p: TerminalPlugin): Promise<boolean> {
  if (reconnecting()) return false;
  const { reader } = await raced(5_000, () => p.getConnectedReader());
  return !!reader;
}

/** Discover the (one) Tap to Pay reader and connect it. Rejects with the SDK's error or TIMED_OUT. */
async function discoverAndConnect(p: TerminalPlugin, ctx: Ctx, go: (s: string) => void, opts: ConnectOpts): Promise<void> {
  go(STAGE.finding);
  // The SDK allows ONE discovery at a time — a probe (tapToPaySupported) that timed out on a slow
  // network may still have one running. Clear it first; the native side no-ops when there's none.
  await raced(3_000, () => p.cancelDiscoverReaders()).catch(() => {});
  let readers: Reader[] | undefined;
  try {
    ({ readers } = await raced(20_000, () => p.discoverReaders({ type: "tap-to-pay", locationId: ctx.locationId })));
  } catch (e) {
    // A discovery this turn gave up on keeps running natively; the next turn's discover would
    // land on it. Tell it to stop on the way out.
    if (e === TIMED_OUT) void p.cancelDiscoverReaders().catch(() => {});
    throw e;
  }
  const reader = readers?.[0];
  if (!reader) {
    throw new Error("this iPhone didn't offer one. Tap to Pay on iPhone needs an iPhone XS or newer on a current, non-beta iOS");
  }
  go(STAGE.connecting);
  // A connect this turn gives up on (raced) keeps running natively — the plugin has no cancel for
  // it. The status stream says CONNECTING until it settles, and the next turn's awaitSdkVerdict
  // waits on exactly that instead of colliding.
  await raced(opts.connectMs, () =>
    p.connectReader({
      reader,
      merchantDisplayName: ctx.merchantDisplayName,
      // Direct charges: NO onBehalfOf — the connection token already belongs to the tenant.
      autoReconnectOnUnexpectedDisconnect: true,
    }),
  );
}

/**
 * The one support probe this plugin exposes: a discovery, never a connect (Apple's
 * PaymentCardReader.isSupported isn't surfaced by Stripe's plugin). Takes its SDK turn like every
 * other caller, so it can never slip between a warm-up's discover and connect. Resolves whether a
 * Tap to Pay reader was offered; rejects with the SDK's error (or TIMED_OUT) for the caller to
 * word. In test mode the SDK simulates a reader on any device — a "found" there is about the
 * simulator, not the hardware.
 */
function probeDiscovery(p: TerminalPlugin, livemode: boolean, locationId: string | null): Promise<boolean> {
  return withSdk((turn) =>
    raced(10_000, async () => {
      await initialise(p, !livemode);
      // A reader already connected (a warm-up before this page load) is the strongest "yes"
      // there is — and a discovery on top of a live connection is a question the SDK need not
      // be asked. A reader the SDK is mid-way through connecting is the same yes: this phone
      // offered one, and a discovery now would only collide with it (1110).
      if (sdkMidway()) return true;
      const { reader: connected } = await p.getConnectedReader();
      if (connected) return true;
      // The org's location when it already has one — the native side keeps the LAST location
      // it was handed, and a real discover always passes its own, but there is no reason to
      // leave nil behind. Never connects.
      let readers: Reader[] | undefined;
      try {
        ({ readers } = await p.discoverReaders({ type: "tap-to-pay", ...(locationId ? { locationId } : {}) }));
      } catch (e) {
        // "Already connected" from a discover: the SDK holds, or is finishing, a connection this
        // page hadn't heard about yet. A reader on this phone, either way.
        if (isAlreadyConnected(e)) return true;
        throw e;
      }
      const found = (readers?.length ?? 0) > 0;
      // Leave nothing running behind a probe — awaited, so a real discovery started after this
      // can never be the one this cancel lands on. Unless this turn already timed out and the
      // queue moved on: then the discovery running now belongs to someone else. Leave it.
      if (turn === turnSeq) await p.cancelDiscoverReaders().catch(() => {});
      return found;
    }),
  );
}

// ── the bridge API ──────────────────────────────────────────────────────────────────────────

export type TapDeviceStatus =
  | { ok: true; supported: boolean; reason: string | null; osTooOld: boolean }
  | { ok: false; error: string };

/** The "yes", and the memo of it — every positive verdict leaves through here. */
function supportedNow(): TapDeviceStatus {
  supportedOnce = true;
  return { ok: true, supported: true, reason: null, osTooOld: false };
}

/**
 * Can THIS PHONE do Tap to Pay on iPhone — device facts, not company setup (a company that can't
 * take cards yet still learns whether the phone could). Two layers: Apple's model answer from the
 * education plugin when it is aboard (PaymentCardReader.isSupported), then the SDK's discovery,
 * which is where an old iOS or a missing entitlement shows. `osTooOld` is the Apple 1.4 signal —
 * callers show the "update iOS" sentence. `reason` is already that sentence, fix included.
 * `ok: false` means the question couldn't be answered right now (no server, no time), never that
 * the phone can't. A "supported" is remembered for the page load (supportedOnce) — the checkout
 * asks this on every open, and a phone that offered a reader once does not stop being that phone.
 */
export async function tapToPayDeviceStatus(): Promise<TapDeviceStatus> {
  const p = plugin();
  if (!p) return { ok: true, supported: false, reason: NOT_IN_BUILD, osTooOld: false };
  if (supportedOnce) return supportedNow();
  if (inFlight) return { ok: false, error: busySentence() };
  // A warm-up or an enable that connects has answered this already — a reader on the line IS
  // support; share it instead of queueing a probe behind a connect that may take minutes.
  for (const run of [enabling, preparing]) {
    if (!run) continue;
    const r = await run;
    if (r.ok) return supportedNow();
  }
  const edu = educationPlugin();
  const isSupported = edu?.isSupported;
  if (edu && typeof isSupported === "function") {
    try {
      const a = await raced(5_000, () => isSupported.call(edu));
      // The native side answers in booleans — supported / modelSupported / osTooOld — and the
      // words in `reason` are only the fallback for a shell build that predates the booleans. An
      // answer with no boolean verdict at all is no answer: the SDK probe below decides.
      if (typeof a?.supported === "boolean") {
        const reason = typeof a.reason === "string" ? a.reason : "";
        if (typeof a.modelSupported === "boolean") modelSupported = a.modelSupported;
        if (!a.supported) {
          // Which one: the boolean when given; else "iOS"/"update" in the words means the OS. A
          // model verdict is remembered so the SDK's one-string error can be split later.
          const osTooOld = typeof a.osTooOld === "boolean" ? a.osTooOld : /\bios\b|update|version/i.test(reason);
          if (!osTooOld && typeof a.modelSupported !== "boolean") modelSupported = false;
          return { ok: true, supported: false, osTooOld, reason: osTooOld ? OS_SENTENCE : DEVICE_SENTENCE };
        }
        if (typeof a.modelSupported !== "boolean") modelSupported = true;
      }
    } catch {
      /* the model check is a courtesy — the SDK probe below is the gate that matters */
    }
  }
  let ctx: TapToPayContext;
  try {
    ctx = await readContext();
  } catch {
    return { ok: false, error: "Couldn't reach the server to check Tap to Pay on iPhone — check the internet connection and try again." };
  }
  if (!ctx.ok) return { ok: false, error: ctx.error };
  try {
    const found = await probeDiscovery(p, ctx.livemode, ctx.locationId);
    if (found) return supportedNow();
    // No reader offered and no error: the SDK's quiet "no" — the model when Apple said so, else the OS.
    return modelSupported === false
      ? { ok: true, supported: false, osTooOld: false, reason: DEVICE_SENTENCE }
      : { ok: true, supported: false, osTooOld: true, reason: OS_SENTENCE };
  } catch (e) {
    if (e === TIMED_OUT) {
      return { ok: false, error: "The card reader didn't answer in time — fully close the North app, reopen it, and try again." };
    }
    const known = classify(e);
    if (known?.kind === "os") return { ok: true, supported: false, osTooOld: true, reason: known.sentence };
    if (known?.kind === "device" || known?.kind === "entitlement") {
      return { ok: true, supported: false, osTooOld: false, reason: known.sentence };
    }
    return { ok: false, error: known?.sentence ?? describeFailure(STAGE.finding, e) };
  }
}

/**
 * The server's read-only look at this company and this caller (tapToPayContext), on its own
 * 10 s clock — OUTSIDE any SDK turn, always. The one fact in it that outlives the call is the
 * role (canEnableCache): every probe that reads the context on the way to the SDK leaves it
 * behind, so the checkout that follows owes the server nothing for it.
 */
async function readContext(): Promise<TapToPayContext> {
  const c = await raced(10_000, () => tapToPayContext());
  if (c.ok) {
    // The stamp FIRST: if this is a different company or person than the page's caches were
    // built for, noteTapIdentity empties them — and the role below is the one left standing.
    noteTapIdentity(c.identity);
    canEnableCache = c.canEnable;
  }
  return c;
}

/** livemode for initialize() when nothing is cached yet — null when the server can't say. */
async function livemodeFromServer(): Promise<boolean | null> {
  try {
    const c = await readContext();
    return c.ok ? c.livemode : null;
  } catch {
    return null;
  }
}

/**
 * Has this company accepted Apple's Tap to Pay on iPhone terms? APPLE'S answer, through the SDK,
 * on every call (Apple 1.6) — the Settings page shows this, never a stored flag. null = it can't
 * be known without connecting: no plugin, an older shell build without the method, iOS < 16.4,
 * no server for the mode, or Stripe didn't answer. A connected reader overrides a "false": the
 * SDK cannot connect an unlinked account, so the reader IS the acceptance — this also covers the
 * unverified corner where a nil onBehalfOf might answer for the platform account instead.
 */
export async function tapToPayAccountLinked(): Promise<boolean | null> {
  const p = plugin();
  if (!p || typeof p.isTapToPayAccountLinked !== "function") return null;
  // An enable or a warm-up in progress is about to answer this the hard way — a connect that
  // succeeds IS the acceptance; share that verdict rather than queue behind it for minutes.
  if (enabling) {
    const r = await enabling;
    if (r.ok) return true;
  }
  if (preparing) {
    const r = await preparing;
    if (r.ok) return true;
  }
  const livemode = ctxCache?.livemode ?? (await livemodeFromServer());
  if (livemode === null) return null;
  try {
    return await withSdk(() =>
      raced(20_000, async () => {
        await initialise(p, !livemode);
        const linked = await readLinked(p);
        if (linked === true) return true;
        // A connected reader IS the acceptance (header) — and it also answers for a reader that
        // was too busy to be asked.
        const { reader } = await p.getConnectedReader();
        if (reader) return true;
        return linked === false ? false : null;
      }),
    );
  } catch {
    return null;
  }
}

export type TapPrepareResult = { ok: true } | { ok: false; error: string; notEnabled?: boolean };

/**
 * WARM UP: location + SDK + reader, ahead of the customer standing there. Apple's review
 * checklist asks for this at launch AND on every foreground (1.5); it also moves the slow first
 * connect (configuration update) off the moment money changes hands. Safe to call as often as
 * the shell likes: once the reader is connected it is one cached context + two bridge calls, and
 * failed attempts are not re-run for 30 s. NEVER raises Apple's terms sheet — an unlinked account
 * comes back `notEnabled` with the sentence that names the Settings door (Apple 3.8), and so
 * does an account Apple couldn't answer for: nothing here knows who holds the phone, so the
 * round is skipped (no memo) and the next foreground asks Apple again.
 */
export async function prepareTapToPay(): Promise<TapPrepareResult> {
  const p = plugin();
  if (!p) return { ok: false, error: NOT_IN_BUILD };
  if (inFlight) return { ok: true };
  // The Settings door is doing exactly this job right now, with the terms allowed — share it.
  if (enabling) return enabling;
  // One warm-up at a time; a second caller shares the first one's answer.
  if (preparing) return preparing;
  // The reader is not reachable from the background (the SDK says so, loudly); the foreground
  // that follows will call again.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return { ok: false, error: "The app is in the background — Tap to Pay on iPhone gets ready once it's back on screen." };
  }
  if (notEnabledAt && Date.now() - notEnabledAt < NOT_ENABLED_RECHECK_MS) {
    return { ok: false, notEnabled: true, error: TERMS_NEEDED_SENTENCE };
  }
  if (lastPrepareFailure && Date.now() - lastPrepareFailure.at < FAILED_WARMUP_RECHECK_MS) return lastPrepareFailure.result;
  preparing = (async (): Promise<TapPrepareResult> => {
    let stage: string = STAGE.location;
    try {
      // NOBODY IS HOLDING THIS PHONE — the warm-up is the one path with no customer waiting on
      // it, so it is the one that can afford to ask who is signed in. A cached location the
      // server hasn't confirmed for this identity in five minutes is re-confirmed here: signing
      // out of one company and into another is a soft transition, and warming the reader onto
      // the company someone LEFT is a tenant boundary, not a nicety. A moved identity empties
      // ctxCache under this line, and the location below is read again for the new one.
      if (ctxCache && Date.now() - identityAt > IDENTITY_RECHECK_MS) await readContext().catch(() => {});
      let ctx: Ctx | null = ctxCache;
      if (!ctx) {
        publish(STAGE.location);
        const r = await raced(20_000, () => ensureTerminalLocation());
        if (!r.ok) {
          publish(STAGE.notReady);
          reportWarmupFailure("location refused", r.error, { stage });
          return { ok: false, error: r.error };
        }
        noteTapIdentity(r.identity);
        ctx = r;
        ctxCache = r;
      }
      const c: Ctx = ctx;
      await withSdk(async () => {
        stage = STAGE.starting;
        publish(stage);
        await raced(10_000, () => initialise(p, !c.livemode));
        await connectIfNeeded(
          p,
          c,
          (s) => {
            stage = s;
          },
          { terms: "refuse", connectMs: 180_000 },
        );
      });
      lastPrepareFailure = null;
      return { ok: true };
    } catch (e) {
      publish(STAGE.notReady);
      if (e instanceof NotEnabledError) {
        // Apple's "no" is not re-asked for a minute. Apple's silence is not memoised at all —
        // this round is skipped, and the next foreground (the shell spaces those out) asks again.
        if (e.why === "unlinked") notEnabledAt = Date.now();
        return { ok: false, notEnabled: true, error: e.message };
      }
      ctxCache = null;
      let result: TapPrepareResult;
      if (e === TIMED_OUT) {
        result = { ok: false, error: `Tap to Pay on iPhone didn't get ready (stuck at: ${stage}).` };
        reportWarmupFailure(`timed out at ${stage}`, result.error, { stage });
      } else {
        // The SDK's own words go to ops as they came; failure() reads lastTokenFailure before it
        // clears it, which is what tells a lost listener apart from a failed fetch.
        const sdkSaid = said(e);
        const f = failure(stage, e);
        result = { ok: false, error: f.error };
        const kind = f.kind === "listener-lost" ? "token listener lost" : (f.kind ?? `unclassified at ${stage}`);
        // The app went to the background mid-warm-up (the camera sheet does it): a skip, the same as
        // the hidden-page check at the top, not a failure anyone needs to read about.
        if (f.kind !== "background") reportWarmupFailure(kind, f.error, { stage, sdk_said: sdkSaid });
      }
      lastPrepareFailure = { at: Date.now(), result };
      return result;
    }
  })();
  try {
    return await preparing;
  } finally {
    preparing = null;
  }
}

/**
 * THE WARM-UP HAS NO SCREEN, SO ITS FAILURES GO TO OPS (2026-09-23). It used to drop every one:
 * the evening Tap to Pay on iPhone could not get a Stripe session for three hours, the phone
 * looked ready and error_events held nothing, and the only witness was a Debug console pasted
 * into a bug report about something else. A failure here is the one the next press will meet at
 * the counter, so it is reported once per page load per kind (an unanswered report is allowed
 * another go, since a warm-up most often fails when the signal is gone). Apple's "not enabled"
 * and a backgrounded app are skips, not failures, and never come through here.
 */
const warmupReported = new Set<string>();
function reportWarmupFailure(kind: string, sentence: string, extra: Record<string, string>): void {
  if (warmupReported.has(kind)) return;
  warmupReported.add(kind);
  reportClientError("tap-to-pay", `warm-up failed: ${kind}`, { ...extra, sentence }).catch(() => {
    warmupReported.delete(kind);
  });
}

export type TapEnableResult = { ok: true } | { ok: false; error: string; kind?: TapFailKind };

const ENABLE_CONNECT_MS = 480_000;

/**
 * ENABLE TAP TO PAY ON IPHONE — the Settings action (Apple 3.5, 3.6), shown by the page to
 * owners/admins only (3.8). Location → SDK → discover → connect, exactly like the warm-up, with
 * two differences: an unlinked account IS connected here, so the SDK raises Apple's terms sheet
 * the first time (Apple ID sign-in, the terms, done — a human reading them is why the connect
 * gets eight minutes), and it never answers from a warm-up's "already prepared": every Enable
 * tap does its own pass (cheap when the reader is there — a connected reader is the acceptance).
 * Progress arrives on onTapProgress; the answer's sentence tells declined-the-terms apart from
 * not-supported from update-iOS from no-network, each with its fix.
 */
export async function enableTapToPay(): Promise<TapEnableResult> {
  const p = plugin();
  if (!p) return { ok: false, error: NOT_IN_BUILD };
  if (inFlight) {
    return {
      ok: false,
      error: readerArmed ? "A card payment is in progress on this phone. Finish or cancel it, then enable Tap to Pay on iPhone." : ATTEMPT_FINISHING,
    };
  }
  if (enabling) return enabling;
  enabling = (async (): Promise<TapEnableResult> => {
    // A warm-up mid-connect owns the SDK — let it settle, but never take its answer.
    if (preparing) await preparing;
    notEnabledAt = 0;
    lastPrepareFailure = null;
    let stage: string = STAGE.location;
    try {
      publish(STAGE.location);
      const ctx = await raced(20_000, () => ensureTerminalLocation());
      if (!ctx.ok) {
        publish(STAGE.notReady);
        return { ok: false, error: ctx.error };
      }
      noteTapIdentity(ctx.identity);
      ctxCache = ctx;
      await withSdk(async () => {
        stage = STAGE.starting;
        publish(stage);
        await raced(10_000, () => initialise(p, !ctx.livemode));
        await connectIfNeeded(
          p,
          ctx,
          (s) => {
            stage = s;
          },
          { terms: "present", connectMs: ENABLE_CONNECT_MS },
        );
      });
      return { ok: true };
    } catch (e) {
      ctxCache = null;
      publish(STAGE.notReady);
      if (e === TIMED_OUT) {
        return {
          ok: false,
          error:
            stage === STAGE.connecting
              ? "Apple's Tap to Pay on iPhone setup didn't finish in eight minutes. If the terms sheet is still open, finish it and tap Enable Tap to Pay on iPhone again; otherwise check the internet connection and try again."
              : `Tap to Pay on iPhone didn't get ready (stuck at: ${stage}). Check the internet connection and try again.`,
        };
      }
      const f = failure(stage, e);
      return f.kind ? { ok: false, error: f.error, kind: f.kind } : { ok: false, error: f.error };
    }
  })();
  try {
    return await enabling;
  } finally {
    enabling = null;
  }
}

/**
 * Apple's own "how to take a tap" sheet (ProximityReaderDiscovery — Apple 4.1, right after the
 * terms and again from Settings). Native-only and iOS 18+, through the TapToPayEducation plugin;
 * a shell without it, or an older iOS, gets the plain sentence. The sheet stays up until the
 * person closes it, and the native call answers then — so the timer is a long one, a guard
 * against a bridge that never answers, not a limit on reading.
 */
export async function showHowToTap(): Promise<{ ok: true } | { ok: false; error: string }> {
  const NOT_HERE = "Apple's Tap to Pay on iPhone guide isn't available on this iPhone — it needs iOS 18 or newer and the current North app.";
  const edu = educationPlugin();
  const show = edu?.showHowToTap;
  if (!edu || typeof show !== "function") return { ok: false, error: NOT_HERE };
  // Apple owns the screen during a tap; a second sheet on top of it is nowhere anyone should be.
  if (inFlight) return { ok: false, error: busySentence() };
  // The same for Apple's terms sheet (an enable) and Apple's configuration (a warm-up): the guide
  // never stacks on either. The Settings door opens the guide itself the moment the terms are
  // done (4.2), so the enable case is told to finish rather than told to wait.
  if (enabling) {
    return {
      ok: false,
      error: "Enable Tap to Pay on iPhone is still running — finish Apple's terms first; the guide opens on its own right after.",
    };
  }
  if (preparing) {
    return { ok: false, error: "Tap to Pay on iPhone is getting ready on this phone — give it a moment, then tap How to Tap again." };
  }
  try {
    await raced(10 * 60_000, () => show.call(edu));
    return { ok: true };
  } catch (e) {
    if (e === TIMED_OUT) {
      return { ok: false, error: "Apple's Tap to Pay on iPhone guide didn't answer — if it never opened, check the internet connection and try again." };
    }
    const code = codeOf(e);
    if (code === "UNAVAILABLE" || code === "UNIMPLEMENTED" || /iOS 18|not available|not supported/i.test(said(e))) {
      return { ok: false, error: NOT_HERE };
    }
    const m = said(e);
    return { ok: false, error: `Couldn't open Apple's Tap to Pay on iPhone guide${m ? ` — ${m}` : ""}. Check the internet connection and try again.` };
  }
}

export type TapCollectResult = { ok: true } | { ok: false; error: string; cancelled?: boolean; notEnabled?: boolean };

/** How long a busy reader gets to finish its last request before the one retry of a collect. */
const BUSY_RETRY_PAUSE_MS = 2_000;

/**
 * TAKE THE TAP. The PaymentIntent already exists (createTapPaymentIntent); this collects the card
 * against it and confirms. `{ ok: true }` means Stripe confirmed the charge — the invoice flips
 * when the webhook lands, so the caller keeps polling invoiceCollectStatus exactly as the QR door
 * does. The plugin never returns the PaymentIntent to JS (its confirmed event is empty), which is
 * why `paymentIntentId` travels with the input: the caller already holds the only copy.
 *
 * `amount` is integer cents, kept on the input so the caller's confirmation copy and this call
 * can't disagree; the charge itself was fixed when the PaymentIntent was minted.
 *
 * On a decline, call again with the SAME clientSecret: Stripe re-uses the PaymentIntent.
 *
 * An unlinked account is NOT connected from here (that would put Apple's terms sheet in front of
 * whoever holds the phone): the answer is `notEnabled` with the sentence, and the checkout — which
 * knows the role — offers enableTapToPay() to an owner/admin (Apple 5.3: pressing the button when
 * not enabled opens the terms) and the sentence to everyone else (3.8.1). When Apple's answer
 * can't be read at all, the same refusal stands for everyone but an owner/admin (the server's
 * canEnable, cached for the page): for them the connect goes on, and the sheet, if Apple raises
 * it, is theirs to read.
 */
export async function collectTapPayment(input: {
  clientSecret: string;
  paymentIntentId: string;
  amount: number;
}): Promise<TapCollectResult> {
  const p = plugin();
  if (!p) return { ok: false, error: NOT_IN_BUILD };
  if (!input.clientSecret) return { ok: false, error: "This payment wasn't started properly — go back and try again." };
  if (inFlight) return { ok: false, error: busySentence() };
  // Claimed BEFORE the first await, so two taps during a warm-up can't both pass the line above.
  inFlight = true;
  cancelRequested = false;
  readerArmed = false;
  // CANCEL IS ANSWERED AT ONCE UNTIL THE READER IS ARMED (2026-09-23). Finding and connecting the
  // reader can take a minute or more, and the plugin cannot stop a connect: Cancel used to sit
  // under a spinner until the SDK answered, and a connect that succeeded after it went straight
  // on to Apple's card sheet. So the sheet gets its answer the moment Cancel is pressed, while
  // the attempt runs on in the background to its own end (the SDK queue keeps the next turn off
  // the connect still settling) and never arms the reader: it asks cancelRequested right before.
  // The claim is held until it ends, and a press meanwhile is told the last attempt is finishing.
  const cancelled = new Promise<TapCollectResult>((resolve) => {
    cancelBeforeReader = () => resolve(CANCELLED);
  });
  const attempt = collectAttempt(p, input).finally(() => {
    inFlight = false;
    readerArmed = false;
    cancelBeforeReader = null;
  });
  return Promise.race([attempt, cancelled]);
}

/** One attempt at the tap, location to Stripe's confirm. collectTapPayment holds the claim on it. */
async function collectAttempt(p: TerminalPlugin, input: { clientSecret: string }): Promise<TapCollectResult> {
  // WHERE it got stuck, so a hang names itself instead of spinning forever.
  let stage: string = STAGE.location;
  try {
    // A warm-up or an enable mid-connect shares the SDK singleton; let it finish rather than
    // collide with it. (Neither rejects — each returns its own { ok } — so a plain await is enough.)
    if (preparing) await preparing;
    if (enabling) await enabling;
    // Cancelled while it waited: nothing has been touched for this attempt yet.
    if (cancelRequested) return CANCELLED;
    // Apple 5.6: the Tap to Pay on iPhone screen within a second. A tap on a warm reader must
    // not wait on a cold server function, so the context is the page's cached one (exactly as the
    // warm-up reads it) and the server is asked only for what nobody on this page has asked yet:
    // the location when the cache is empty; the role when no probe has read the context. The two
    // are started side by side so a cold page costs one round-trip, not two — and the role read
    // may fail without failing the payment: null is the safe side (an unknown terms status is
    // refused, never connected).
    const roleRead = canEnableCache === null ? readContext().catch(() => null) : null;
    const takeCtx = async (): Promise<Ctx | { error: string }> => {
      if (ctxCache) return ctxCache;
      publish(STAGE.location);
      const r = await raced(20_000, () => ensureTerminalLocation());
      if (!r.ok) return { error: r.error };
      noteTapIdentity(r.identity);
      ctxCache = r;
      return r;
    };
    let got = await takeCtx();
    if ("error" in got) {
      publish(STAGE.notReady);
      return { ok: false, error: got.error };
    }
    if (roleRead) {
      await roleRead;
      // That answer also said WHO is signed in. If it moved, the location above belonged to the
      // company they left and the stamp has just emptied the cache — read the right one before
      // any of this touches the reader.
      if (!ctxCache) {
        got = await takeCtx();
        if ("error" in got) {
          publish(STAGE.notReady);
          return { ok: false, error: got.error };
        }
      }
    }
    const c: Ctx = got;
    // The server's word, read fresh on THIS page load — never a flag anyone could set here.
    const canEnable = canEnableCache === true;
    const outcome = await withSdk(async () => {
      // Cancelled while the location and role were read: start nothing. A connect nobody wants now
      // could still raise Apple's terms sheet over a Pay Now sheet that has already said Cancelled.
      if (cancelRequested) return "cancelled" as const;
      stage = STAGE.starting;
      publish(stage);
      await raced(10_000, () => initialise(p, !c.livemode));
      await connectIfNeeded(
        p,
        c,
        (s) => {
          stage = s;
        },
        { terms: "refuse", canEnable, connectMs: 180_000 },
      );
      // NEVER ARM THE READER AFTER A CANCEL. The sheet was answered when it was pressed; the
      // reader stays connected (connectIfNeeded has said "ready") for the next press.
      if (cancelRequested) return "cancelled" as const;
      // Apple takes the screen from here until the card is read (or the customer walks off).
      stage = STAGE.tapping;
      publish(stage);
      // A read a timed-out turn left armed on Apple's reader would answer this one with "reader
      // busy" (code 20); `inFlight` is this page's flag, not the reader's. Clearing it first
      // costs nothing — the native side no-ops when there is nothing to cancel.
      await raced(5_000, () => p.cancelCollectPaymentMethod()).catch(() => {});
      // The one await between the question above and Apple's card sheet: ask it again.
      if (cancelRequested) {
        publish(STAGE.ready);
        return "cancelled" as const;
      }
      readerArmed = true;
      cancelBeforeReader = null;
      const collect = () => raced(120_000, () => p.collectPaymentMethod({ paymentIntent: input.clientSecret }));
      try {
        await collect();
      } catch (e) {
        if (cancelRequested || !isBusy(e)) throw e;
        // Apple's reader was still on its last request — a reconnect finishing under the tap, a
        // read being torn down. Clear, give it a beat, once more; the second answer is the answer.
        await raced(5_000, () => p.cancelCollectPaymentMethod()).catch(() => {});
        await pause(BUSY_RETRY_PAUSE_MS);
        if (cancelRequested) throw e;
        await collect();
      }
      // Stripe: authorize or cancel within 30 seconds of collection — confirm straight away.
      // The caller's "processing" screen (Apple 5.8) is this stage.
      stage = STAGE.confirming;
      publish(stage);
      await raced(45_000, () => p.confirmPaymentIntent());
      return "confirmed" as const;
    });
    if (outcome === "cancelled") return CANCELLED;
    publish(STAGE.ready);
    return { ok: true };
  } catch (e) {
    // The reader is still there after a failed tap or confirm; it isn't after a failed connect.
    publish(stage === STAGE.tapping || stage === STAGE.confirming ? STAGE.ready : STAGE.notReady);
    if (e instanceof NotEnabledError) {
      // Only Apple's own "no" throttles the warm-up; its silence is asked again next foreground.
      if (e.why === "unlinked") notEnabledAt = Date.now();
      return { ok: false, notEnabled: true, error: e.message };
    }
    if (e === TIMED_OUT) {
      // A tap nobody made must not stay armed on the reader.
      if (stage === STAGE.tapping) void p.cancelCollectPaymentMethod().catch(() => {});
      const hint =
        stage === STAGE.connecting
          ? " The first connect can take a few minutes while Apple sets the phone up — try again in a moment."
          : " If this app was just updated, fully close it and reopen, then try again.";
      return { ok: false, error: `Tap to Pay on iPhone didn't finish (stuck at: ${stage}).${hint}` };
    }
    if (cancelRequested || /cancel/i.test(said(e))) return CANCELLED;
    const decline = declineOf(e);
    if (decline) {
      return {
        ok: false,
        error: `The card was declined (${decline.replace(/_/g, " ")}). Nothing was charged — try another card on the same payment.`,
      };
    }
    if (stage === STAGE.location || stage === STAGE.starting || stage === STAGE.checking || stage === STAGE.finding || stage === STAGE.connecting) {
      ctxCache = null;
    }
    return { ok: false, error: describeFailure(stage, e) };
  }
}

/**
 * The customer changed their mind. While the reader is waiting for a card, the collect promise
 * is the one that answers (with cancelled: true) and this tells the reader to stop listening.
 * Before the reader is armed there is nothing native to stop, so the payment answers now.
 */
export async function cancelTapPayment(): Promise<void> {
  const p = plugin();
  if (!p) return;
  cancelRequested = true;
  cancelBeforeReader?.();
  try {
    await raced(5_000, () => p.cancelCollectPaymentMethod());
  } catch {
    /* nothing to cancel, or the collect already settled */
  }
}

/**
 * NORT'S VOICE AND THE READER (Erik's phone, 2026-09-24). Every spoken reply crackled in the app
 * and played clean in Safari, and neither releasing the mic nor swapping the player changed it.
 * A live device console during a three-turn conversation showed the app doing nothing native while
 * Nort talked, except that the Tap to Pay reader had connected in the background a moment before
 * and stayed connected; the crackle was first heard the night the listener fix made that connect
 * reliable. So while Nort's voice is on, the reader stands down. It costs nothing: Pay Now connects
 * on demand (connectIfNeeded) and the warm-up reconnects on the next return to the foreground.
 * Never mid-payment or mid-setup.
 */
export async function standDownReaderForVoice(): Promise<void> {
  if (!plugin() || inFlight || enabling) return;
  await disconnectTapReader();
}

/** Let go of the reader (Settings, sign-out). Resolves immediately if nothing is connected. */
export async function disconnectTapReader(): Promise<void> {
  const p = plugin();
  if (!p) return;
  try {
    await withSdk(() => raced(5_000, () => p.disconnectReader()));
  } catch {
    /* already gone */
  }
  publish(STAGE.notReady);
}
