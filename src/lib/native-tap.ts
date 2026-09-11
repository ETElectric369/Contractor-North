"use client";

import { isNativeShell } from "@/lib/native-shell";
import { ensureTerminalLocation, tapToPayContext, type TapToPayContext } from "@/app/(app)/billing/tap-actions";

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
  addListener(event: string, cb: (data: unknown) => void): Promise<{ remove: () => Promise<void> }>;
};

type CapacitorGlobal = { Plugins?: Record<string, unknown>; getPlatform?: () => string };

function plugin(): TerminalPlugin | null {
  if (typeof window === "undefined" || !isNativeShell()) return null;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  // Tap to Pay on iPHONE. The Android shell, if it ever carries this plugin, is a different
  // product (Tap to Pay on Android) with its own gates; don't offer a door it can't open.
  if (cap?.getPlatform && cap.getPlatform() !== "ios") return null;
  return (cap?.Plugins?.StripeTerminal as TerminalPlugin | undefined) ?? null;
}

// ── module state ────────────────────────────────────────────────────────────────────────────
// One page load, one SDK. The plugin guards Terminal.initWithTokenProvider behind its own
// `isInitialize`, and re-reads `isTest` on every initialize() — so initialize is cheap to repeat,
// but the token LISTENER must be registered exactly once or every request gets answered twice.
let tokenListenerArmed = false;
/** Why the last connection-token fetch failed — the SDK's own message for that is generic. */
let lastTokenError: string | null = null;
let inFlight = false;
let cancelRequested = false;
let supportedOnce = false;
/** The warm-up in progress, if any — collect waits for it, a second prepare shares it. */
let preparing: Promise<TapPrepareResult> | null = null;

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

// ── the connection token, answered from the session, not from a bare native POST ───────────
/**
 * The SDK asks for a token whenever it needs to talk to Stripe (first connect, every reconnect),
 * by emitting `terminalRequestedConnectionToken`; we answer with setConnectionToken. The plugin's
 * alternative — a `tokenProviderEndpoint` it POSTs to natively — sends no cookies, so it could
 * never pass requireStaff. This listener is registered BEFORE initialize(), as the plugin's
 * README insists, and kept for the life of the page.
 *
 * On failure the SDK is handed an EMPTY token on purpose: the native side turns that into an
 * error on its pending request, so the operation that needed the token fails now with a message,
 * instead of the SDK waiting forever for an answer that isn't coming. The real reason is kept in
 * lastTokenError and folded into the sentence the caller sees.
 */
async function feedToken(p: TerminalPlugin): Promise<void> {
  let secret = "";
  try {
    const r = await fetch("/api/stripe/terminal/token", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    const body = (await r.json().catch(() => ({}))) as { secret?: unknown; error?: unknown };
    if (r.ok && typeof body.secret === "string" && body.secret) {
      secret = body.secret;
      lastTokenError = null;
    } else {
      lastTokenError = typeof body.error === "string" && body.error ? body.error : `the server answered ${r.status}`;
    }
  } catch (e) {
    lastTokenError = e instanceof Error ? e.message : "no network";
  }
  try {
    await p.setConnectionToken({ token: secret });
  } catch {
    /* an empty token rejects by design — the SDK has already been told no */
  }
}

async function armTokenProvider(p: TerminalPlugin): Promise<void> {
  if (tokenListenerArmed) return;
  // Set before the await so two callers racing here don't both register.
  tokenListenerArmed = true;
  try {
    await p.addListener("terminalRequestedConnectionToken", () => {
      void feedToken(p);
    });
  } catch (e) {
    tokenListenerArmed = false;
    throw e;
  }
}

/** Listener first, THEN initialize — the SDK may ask for a token as part of initializing. */
async function initialise(p: TerminalPlugin, isTest: boolean): Promise<void> {
  await armTokenProvider(p);
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

const STAGE_PREFIX: Record<string, string> = {
  "getting your Stripe location": "Couldn't set up Tap to Pay for this company",
  "starting the card reader": "Couldn't start the card reader",
  "checking the reader": "Couldn't check the card reader",
  "finding the reader": "Couldn't find the Tap to Pay reader on this iPhone",
  "connecting the reader": "Couldn't connect the Tap to Pay reader",
  "waiting for the tap": "The tap didn't go through",
  "confirming with Stripe": "Stripe couldn't confirm the payment",
};

function describeFailure(stage: string, e: unknown): string {
  const prefix = STAGE_PREFIX[stage] ?? "Tap to Pay didn't finish";
  const msg = said(e);
  const token = lastTokenError ? ` (Stripe session: ${lastTokenError})` : "";
  lastTokenError = null;
  return `${prefix}${msg ? ` — ${msg}` : ""}${token}.`;
}

// ── the reader ──────────────────────────────────────────────────────────────────────────────
type Ctx = { locationId: string; merchantDisplayName: string; livemode: boolean };

/**
 * Discover + connect, unless a reader is already connected (Stripe recommends connecting ahead
 * and staying connected; the reader drops on its own when the app backgrounds). The FIRST
 * connect on a phone for a given Stripe account is the slow one: Apple presents its Tap to Pay
 * terms (Apple ID sign-in, an admin's job) and may run a configuration update "up to a few
 * minutes" — hence the long timeout and the stage text that says what's happening.
 *
 * locationId is REQUIRED at discovery: the native side stores it there and force-unwraps it at
 * connect, so a discover without it doesn't reject, it crashes the app on connect.
 */
async function connectIfNeeded(p: TerminalPlugin, ctx: Ctx, setStage: (s: string) => void): Promise<void> {
  setStage("checking the reader");
  const { reader: already } = await raced(5_000, () => p.getConnectedReader());
  if (already) return;
  setStage("finding the reader");
  // The SDK allows ONE discovery at a time — a probe (tapToPaySupported) that timed out on a slow
  // network may still have one running. Clear it first; the native side no-ops when there's none.
  await raced(3_000, () => p.cancelDiscoverReaders()).catch(() => {});
  const { readers } = await raced(20_000, () => p.discoverReaders({ type: "tap-to-pay", locationId: ctx.locationId }));
  const reader = readers?.[0];
  if (!reader) {
    throw new Error("this iPhone didn't offer one. Tap to Pay needs an iPhone XS or newer on a current, non-beta iOS");
  }
  setStage("connecting the reader");
  await raced(180_000, () =>
    p.connectReader({
      reader,
      merchantDisplayName: ctx.merchantDisplayName,
      // Direct charges: NO onBehalfOf — the connection token already belongs to the tenant.
      autoReconnectOnUnexpectedDisconnect: true,
    }),
  );
}

// ── the bridge API ──────────────────────────────────────────────────────────────────────────

/**
 * Can this phone, in this build, for this company, take a tap? False IMMEDIATELY when the bridge
 * or plugin is absent (browser, PWA, a shell build without it); false when the company can't take
 * cards; false when the SDK won't offer a Tap to Pay reader on this device. Never throws, never
 * hangs. A "true" is remembered for the page load; a "false" is re-asked, because the reasons
 * for "false" (network, entitlement, setup) can change under the same page.
 *
 * The probe only ever DISCOVERS — discovery is the only support signal this plugin exposes
 * (Apple's PaymentCardReader.isSupported isn't surfaced) — and it takes its SDK turn like every
 * other caller, so it can never slip between a warm-up's discover and connect.
 */
export async function tapToPaySupported(): Promise<boolean> {
  const p = plugin();
  if (!p) return false;
  if (supportedOnce) return true;
  // A payment or a warm-up is using the SDK right now: the screen already decided this phone can
  // tap, and a second discovery would only collide with theirs.
  if (inFlight || preparing) return true;
  // The server round-trip gets its own clock, OUTSIDE the SDK's turn and outside the SDK's
  // budget — a cold function on driveway LTE must not eat the seconds the discovery needs.
  let ctx: TapToPayContext;
  try {
    ctx = await raced(10_000, () => tapToPayContext());
  } catch {
    return false;
  }
  if (!ctx.ok || !ctx.canAccept) return false;
  // Re-asked after the await: a warm-up or a payment may have started meanwhile. They own the
  // SDK now and have already answered this question for the screen.
  if (inFlight || preparing) return true;
  const locationId = ctx.locationId;
  const livemode = ctx.livemode;
  try {
    const ok = await withSdk((turn) =>
      raced(10_000, async () => {
        await initialise(p, !livemode);
        // The org's location when it already has one — the native side keeps the LAST location
        // it was handed, and a real discover always passes its own, but there is no reason to
        // leave nil behind. Never connects.
        const { readers } = await p.discoverReaders({ type: "tap-to-pay", ...(locationId ? { locationId } : {}) });
        const found = (readers?.length ?? 0) > 0;
        // Leave nothing running behind a probe — awaited, so a real discovery started after this
        // can never be the one this cancel lands on. Unless this turn already timed out and the
        // queue moved on: then the discovery running now belongs to someone else. Leave it.
        if (turn === turnSeq) await p.cancelDiscoverReaders().catch(() => {});
        return found;
      }),
    );
    // Remembered HERE, on the answer the caller actually receives — not inside a closure that
    // may resolve after a timeout already told the caller "no".
    if (ok) supportedOnce = true;
    return ok;
  } catch {
    return false;
  }
}

export type TapPrepareResult = { ok: true } | { ok: false; error: string };

/**
 * WARM UP: location + SDK + reader, ahead of the customer standing there. Apple's review
 * checklist asks for this at launch/foreground; it also moves the slow first connect (terms,
 * configuration update) off the moment money changes hands. Safe to call repeatedly.
 */
export async function prepareTapToPay(): Promise<TapPrepareResult> {
  const p = plugin();
  if (!p) return { ok: false, error: "Tap to Pay isn't available in this app build." };
  if (inFlight) return { ok: true };
  // One warm-up at a time; a second caller shares the first one's answer.
  if (preparing) return preparing;
  preparing = (async (): Promise<TapPrepareResult> => {
    let stage = "starting";
    try {
      stage = "getting your Stripe location";
      const ctx = await raced(20_000, () => ensureTerminalLocation());
      if (!ctx.ok) return { ok: false, error: ctx.error };
      await withSdk(async () => {
        stage = "starting the card reader";
        await raced(10_000, () => initialise(p, !ctx.livemode));
        await connectIfNeeded(p, ctx, (s) => {
          stage = s;
        });
      });
      return { ok: true };
    } catch (e) {
      if (e === TIMED_OUT) return { ok: false, error: `Tap to Pay didn't get ready (stuck at: ${stage}).` };
      return { ok: false, error: describeFailure(stage, e) };
    }
  })();
  try {
    return await preparing;
  } finally {
    preparing = null;
  }
}

export type TapCollectResult = { ok: true } | { ok: false; error: string; cancelled?: boolean };

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
 */
export async function collectTapPayment(input: {
  clientSecret: string;
  paymentIntentId: string;
  amount: number;
}): Promise<TapCollectResult> {
  const p = plugin();
  if (!p) return { ok: false, error: "Tap to Pay isn't available in this app build." };
  if (!input.clientSecret) return { ok: false, error: "This payment wasn't started properly — go back and try again." };
  if (inFlight) return { ok: false, error: "A card payment is already in progress on this phone." };
  // Claimed BEFORE the first await, so two taps during a warm-up can't both pass the line above.
  inFlight = true;
  cancelRequested = false;
  // WHERE it got stuck, so a hang names itself instead of spinning forever.
  let stage = "starting";
  try {
    // A warm-up mid-connect shares the SDK singleton; let it finish rather than collide with it.
    // (It never rejects — it returns its own { ok } — so a plain await is enough.)
    if (preparing) await preparing;
    stage = "getting your Stripe location";
    const ctx = await raced(20_000, () => ensureTerminalLocation());
    if (!ctx.ok) return { ok: false, error: ctx.error };
    await withSdk(async () => {
      stage = "starting the card reader";
      await raced(10_000, () => initialise(p, !ctx.livemode));
      await connectIfNeeded(p, ctx, (s) => {
        stage = s;
      });
      // Apple takes the screen from here until the card is read (or the customer walks off).
      stage = "waiting for the tap";
      await raced(120_000, () => p.collectPaymentMethod({ paymentIntent: input.clientSecret }));
      // Stripe: authorize or cancel within 30 seconds of collection — confirm straight away.
      stage = "confirming with Stripe";
      await raced(45_000, () => p.confirmPaymentIntent());
    });
    return { ok: true };
  } catch (e) {
    if (e === TIMED_OUT) {
      // A tap nobody made must not stay armed on the reader.
      if (stage === "waiting for the tap") void p.cancelCollectPaymentMethod().catch(() => {});
      const hint =
        stage === "connecting the reader"
          ? " The first connect can take a few minutes while Apple sets the phone up — try again in a moment."
          : " If this app was just updated, fully close it and reopen, then try again.";
      return { ok: false, error: `Tap to Pay didn't finish (stuck at: ${stage}).${hint}` };
    }
    if (cancelRequested || /cancel/i.test(said(e))) {
      return { ok: false, cancelled: true, error: "Cancelled — nothing was charged." };
    }
    const decline = declineOf(e);
    if (decline) {
      return {
        ok: false,
        error: `The card was declined (${decline.replace(/_/g, " ")}). Nothing was charged — try another card on the same payment.`,
      };
    }
    return { ok: false, error: describeFailure(stage, e) };
  } finally {
    inFlight = false;
  }
}

/**
 * The customer changed their mind while the reader was waiting. The collect promise is the one
 * that answers (with cancelled: true); this just tells the reader to stop listening.
 */
export async function cancelTapPayment(): Promise<void> {
  const p = plugin();
  if (!p) return;
  cancelRequested = true;
  try {
    await raced(5_000, () => p.cancelCollectPaymentMethod());
  } catch {
    /* nothing to cancel, or the collect already settled */
  }
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
}
