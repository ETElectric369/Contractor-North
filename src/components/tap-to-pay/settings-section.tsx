"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getPosition, type GeoResult } from "@/lib/geo";
import {
  enableTapToPay,
  onTapProgress,
  showHowToTap,
  tapToPayAccountLinked,
  tapToPayDeviceStatus,
  tapToPayPluginPresent,
  type TapDeviceStatus,
  type TapProgress,
} from "@/lib/native-tap";
import { announceTapToPay } from "@/app/(app)/billing/tap-actions";

/**
 * TAP TO PAY ON IPHONE — the Settings card (2026-09-11), mounted directly under "Card payments"
 * in Getting Paid. That placement is Apple 3.4: the step that ends merchant onboarding (Stripe
 * connected, cards accepted) is where the phone-as-reader gets switched on, and 3.6: it is a
 * door OUTSIDE the checkout, so an owner can enable it at the kitchen table, not in a driveway
 * with a customer waiting.
 *
 * WHAT IS OURS AND WHAT IS APPLE'S. Every fact on this card that matters to Apple's review is
 * read from the phone, not from a column: can this iPhone tap (tapToPayDeviceStatus), has the
 * company accepted Apple's terms (tapToPayAccountLinked — Apple's own answer through the SDK on
 * every call, Apple 1.6), how far along the configuration is (onTapProgress, the SDK's update
 * events, Apple 3.9.1). The server's only say is the role (owner/admin may accept the terms,
 * Apple 3.8 — everyone else gets the "ask an admin" sentence, 3.8.1) and whether the company
 * can take cards at all.
 *
 * THE LOCATION PRE-ALERT. Apple's onboarding rules want system permissions explained BEFORE they
 * are requested, and requested well ahead of checkout; Stripe's SDK refuses to connect the reader
 * without location access. So the Enable tap explains why, then asks iOS for a fix — and it asks
 * INSIDE the tap, before any await, because that is the one shape iOS honours with a real prompt
 * (THE iOS RULE in lib/geo.ts). A denial stops here with the Settings path named; a timeout does
 * not, because the permission was answered and the SDK takes its own fix.
 *
 * COPY: "Tap to Pay on iPhone" in full in every sentence; the short form is for a button only.
 * Anything that SELLS the feature is one of Apple's own sentences (the constants below); ours
 * only say where a door is. No illustration, icon or photo of the feature — Apple allows text
 * until its own toolkit assets arrive.
 *
 * THE LEGAL HOME. Apple's short disclaimer ("Terms apply.") may stand in wherever space is short,
 * but it has to click through to the product page where the full one is displayed — this card
 * is that page: the awareness card's Terms link lands on this tab, and the full disclaimer sits
 * at the bottom of the card, always, not behind a state.
 */

const OFF_SHELL_LINE = "Tap to Pay on iPhone: take a card on your iPhone with no reader. Available in the North iPhone app.";

/**
 * APPLE'S OWN WORDS — the Tap to Pay on iPhone Marketing Guide (U.S.), the copy blocks Apple
 * hands a partner, verbatim with "North" in the partner slot and "readers" where it offered
 * [terminals/readers]. Exported so every surface that sells the feature (this card, the
 * once-only awareness card) says the same thing from ONE string; a reworded copy is the review
 * finding these exist to prevent. The Apple Pay sentence is required wherever "Apple Pay" is
 * mentioned — and the short copy mentions it.
 */
export const TAP_TO_PAY_SHORT_COPY =
  "With Tap to Pay on iPhone and North, you can accept all types of in-person, contactless payments right on your iPhone—from physical debit and credit cards to Apple Pay and other digital wallets—no extra readers or hardware needed. It’s easy, secure, and private.";
export const TERMS_APPLY = "Terms apply.";
export const APPLE_PAY_DISCLAIMER =
  "Apple Pay is a service provided by Apple Payments Services LLC, a subsidiary of Apple Inc. Neither Apple Inc. nor Apple Payments Services LLC is a bank. Any card used in Apple Pay is offered by the card issuer.";
export const TAP_TO_PAY_FULL_DISCLAIMER =
  "Tap to Pay on iPhone Requirements: Tap to Pay on iPhone requires a supported payment app and the latest version of iOS. Update to the latest version by going to Settings > General > Software Update. Tap Download and Install. Some contactless cards may not be accepted by your payment app. Transaction limits may apply. The Contactless Symbol is a trademark owned by and used with permission of EMVCo, LLC. Tap to Pay on iPhone is not available in all markets. For Tap to Pay on iPhone countries and regions, see https://developer.apple.com/tap-to-pay/regions/.";
/** The one URL inside the full disclaimer — rendered as a tappable link, the rest as text. */
const REGIONS_URL = "https://developer.apple.com/tap-to-pay/regions/";

/**
 * The awareness card's "Learn more" lands here when Apple's how-to sheet couldn't open on that
 * iPhone (awareness.tsx). The card re-runs How to Tap on arrival, so the person gets the
 * bridge's real sentence and the written steps — not a Settings tab with no word of why.
 */
const HOW_TO_PARAM = "howto";

const LOCATION_DENIED =
  "Location was turned down, so Tap to Pay on iPhone can't be enabled — Apple requires a location fix to accept a card. Allow it in Settings › North › Location (While Using the App), then tap Enable Tap to Pay on iPhone again.";

/** How long the Enable tap waits on a location fix. The timer is armed BEFORE the request. */
const GEO_TIMEOUT_MS = 15_000;

/**
 * A timer that exists before the call it rescues. `run` is invoked synchronously inside the
 * executor, so a caller that must stay inside a user gesture (getPosition) still does.
 */
function withTimeout<T>(ms: number, onTimeout: T, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(onTimeout);
    }, ms);
    run().then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(onTimeout);
      },
    );
  });
}

/** The reader is being touched right now — the states that earn a progress line. */
function inProgress(p: TapProgress | null): p is TapProgress {
  return !!p && p.stage !== "ready" && p.stage !== "not ready";
}

type Linked = boolean | null | "checking";

/** Apple 1.6: the line under the buttons says what APPLE says, or that it is Apple's to say. */
function linkedLine(l: Linked): string {
  if (l === "checking") return "Checking with Apple whether this company has accepted the Tap to Pay on iPhone terms…";
  if (l === true) return "Enabled: Apple confirms this company has accepted the Tap to Pay on iPhone terms.";
  if (l === false) return "Not enabled yet: Apple says this company hasn't accepted the Tap to Pay on iPhone terms.";
  return "Whether the Tap to Pay on iPhone terms are accepted is Apple's answer, read at the first tap — nothing here stores it.";
}

/**
 * Apple 3.9.1 / 5.7: the configuration indicator. Determinate while the SDK reports a percent
 * (Apple's device configuration arrives as a reader software update), indeterminate for this
 * bridge's own stages — HIG: "if the API shows that configuration is ongoing, display a
 * determinate progress indicator". Says in words that a card can't be taken yet.
 */
function ProgressLine({ p }: { p: TapProgress }) {
  const determinate = p.percent !== null;
  return (
    <div role="status" aria-live="polite" className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <p className="flex items-center gap-2 text-slate-700">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-500" />
        <span>
          Preparing Tap to Pay on iPhone — {p.stage}
          {determinate ? ` · ${p.percent}%` : ""}. Not ready for a card yet.
        </span>
      </p>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-label="Tap to Pay on iPhone setup"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={p.percent ?? undefined}
      >
        <div
          className={
            determinate
              ? "h-full rounded-full bg-[rgb(var(--glass-ink))] transition-[width] duration-300"
              : "h-full w-1/3 animate-pulse rounded-full bg-[rgb(var(--glass-ink))]/60"
          }
          style={determinate ? { width: `${p.percent}%` } : undefined}
        />
      </div>
    </div>
  );
}

const ERROR_BOX = "rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700";
const NOTICE_BOX = "rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800";

export function TapToPaySettingsSection({ isAdmin, canAccept }: { isAdmin: boolean; canAccept: boolean }) {
  const searchParams = useSearchParams();
  // null until mounted: the server can't see the bridge, and the first client render must match
  // it — so nothing is drawn until the phone has said which side of the shell it is on.
  const [shell, setShell] = useState<boolean | null>(null);
  const [device, setDevice] = useState<TapDeviceStatus | null>(null);
  const [linked, setLinked] = useState<Linked>("checking");
  const [progress, setProgress] = useState<TapProgress | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [guide, setGuide] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
  const [announce, setAnnounce] = useState<{ busy: boolean; line: string | null; bad: boolean }>({
    busy: false,
    line: null,
    bad: false,
  });
  // Every await below may land after the tab has been left; a dead component takes no state.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refreshLinked = useCallback(async () => {
    setLinked("checking");
    const l = await tapToPayAccountLinked();
    if (live.current) setLinked(l);
  }, []);

  const checkDevice = useCallback(async () => {
    setDevice(null);
    const d = await tapToPayDeviceStatus();
    if (!live.current) return;
    setDevice(d);
    // Only a phone that can tap is worth asking Apple about — and the two calls share one SDK
    // queue, so the second waits for the first anyway.
    if (d.ok && d.supported) void refreshLinked();
  }, [refreshLinked]);

  useEffect(() => {
    const here = tapToPayPluginPresent();
    setShell(here);
    if (!here) return;
    // Subscribed for the life of the card, not just the Enable tap: a warm-up started by the
    // shell, or a foreground reconnect, is "the reader preparing" too (Apple 3.9.1's "typical
    // usage"), and the last state is replayed on subscribe.
    const off = onTapProgress((p) => {
      if (live.current) setProgress(p);
    });
    void checkDevice();
    return off;
  }, [checkDevice]);

  /** Apple's sheet, or its sentence plus the written steps below the button. Stable: the arrival effect depends on it. */
  const runHowTo = useCallback(async () => {
    setGuide({ busy: true, note: null });
    const r = await showHowToTap();
    if (live.current) setGuide({ busy: false, note: r.ok ? null : r.error });
  }, []);

  // ?howto=1 — the awareness card's "Learn more" arriving after Apple's sheet failed there. Once
  // per mount (the ref survives StrictMode's replay), only inside the shell: a browser tab has
  // no sheet to try and the off-shell line already says so.
  const howToAsked = useRef(false);
  const howToWanted = searchParams.get(HOW_TO_PARAM) === "1";
  useEffect(() => {
    if (!howToWanted || howToAsked.current || !tapToPayPluginPresent()) return;
    howToAsked.current = true;
    void runHowTo();
  }, [howToWanted, runHowTo]);

  function onEnable() {
    if (enabling) return;
    // THE iOS RULE (lib/geo.ts): the location request rides the tap itself — no await ahead of
    // it. The helper's own timeout is belt; the timer armed here, first, is braces.
    const fix = withTimeout<GeoResult>(GEO_TIMEOUT_MS, { status: "timeout" }, () =>
      getPosition({ timeout: GEO_TIMEOUT_MS }),
    );
    setEnabling(true);
    setEnableError(null);
    setEnabled(false);
    setGuide({ busy: false, note: null });
    void (async () => {
      const geo = await fix;
      if (!live.current) return;
      if (geo.status === "denied") {
        setEnableError(LOCATION_DENIED);
        setEnabling(false);
        return;
      }
      // timeout / unavailable / insecure: the permission question was put and answered, which is
      // what the pre-alert exists for. The SDK takes its own fix at connect, and if location is
      // truly off it says so — the bridge turns that into the sentence with the Settings path.
      const r = await enableTapToPay();
      if (!live.current) return;
      setEnabling(false);
      if (!r.ok) {
        setEnableError(r.error);
        return;
      }
      setEnabled(true);
      // Apple 1.6: the status line re-reads APPLE's answer — not our memory of a connect.
      void refreshLinked();
      // Apple 4.2: education right after the terms. Apple's own sheet (iOS 18+); an older iOS
      // gets its sentence plus the written steps below the How to Tap button.
      setGuide({ busy: true, note: null });
      const edu = await showHowToTap();
      if (live.current) setGuide({ busy: false, note: edu.ok ? null : edu.error });
    })();
  }

  async function onHowTo() {
    // While Enable is in flight the SDK may be holding Apple's terms sheet, and the Enable run
    // presents Apple's how-to itself the moment the terms are accepted (Apple 4.2) — a second
    // sheet on top of either is a stack Apple's sheets are not built for. The button is disabled
    // for the same reason; this is the guard for a tap that landed before the re-render.
    if (guide.busy || enabling) return;
    await runHowTo();
  }

  async function onAnnounce() {
    if (announce.busy) return;
    setAnnounce({ busy: true, line: null, bad: false });
    const r = await announceTapToPay();
    if (!live.current) return;
    setAnnounce(
      r.ok
        ? {
            busy: false,
            bad: false,
            line: `Sent to ${r.sent} ${r.sent === 1 ? "person" : "people"} — each phone's own notification settings still apply.`,
          }
        : { busy: false, bad: true, line: r.error },
    );
  }

  if (shell === null) return null;
  // Apple 3.1: the feature is named on the web too — as a fact about the iPhone app, in words.
  if (!shell) return <p className="text-sm text-slate-600">{OFF_SHELL_LINE}</p>;

  const supported = device !== null && device.ok && device.supported;

  return (
    <div className="space-y-4 text-sm text-slate-600">
      {/* Apple's short copy, verbatim — the one sentence pair here that sells the feature. */}
      <p>{TAP_TO_PAY_SHORT_COPY}</p>

      {device === null ? (
        <p className="flex items-center gap-2 text-slate-500">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          Checking whether this iPhone can take Tap to Pay on iPhone…
        </p>
      ) : !device.ok ? (
        <div className="space-y-2">
          <p className={ERROR_BOX}>{device.error}</p>
          <Button size="sm" variant="outline" onClick={() => void checkDevice()}>
            Check Again
          </Button>
        </div>
      ) : !device.supported ? (
        <div className={NOTICE_BOX}>
          {/* Apple 1.4: an iOS too old for the feature is told to update iOS, in those words. */}
          {device.osTooOld && <p className="font-medium">Update iOS to use Tap to Pay on iPhone.</p>}
          <p>{device.reason}</p>
        </div>
      ) : (
        <p className="text-emerald-700">This iPhone can take Tap to Pay on iPhone.</p>
      )}

      {inProgress(progress) && <ProgressLine p={progress} />}
      {progress?.stage === "ready" && <p className="text-xs text-slate-500">Reader ready on this iPhone.</p>}

      {!canAccept && <p className={NOTICE_BOX}>Set up card payments above first.</p>}

      {supported &&
        canAccept &&
        (isAdmin ? (
          <div className="space-y-3">
            {!enabled && (
              <>
                <p>
                  Before the first card, iOS will ask to use this iPhone&apos;s location — Apple requires a location
                  fix to accept a card, so allow it or Tap to Pay on iPhone can&apos;t run.
                  {linked === true
                    ? " Then this iPhone gets its one-time setup from Apple; you'll see the progress here."
                    : " Then Apple's Tap to Pay on iPhone terms appear once, for you to accept on the company's behalf, and this iPhone gets its one-time setup — you'll see the progress here."}
                </p>
                {/* "Enable Tap to Pay on iPhone" is Apple's own label for the terms step. Once
                    Apple says the terms are accepted, the same door is only this iPhone's
                    configuration, and the label says that instead of "Enable" under "Enabled". */}
                <Button onClick={onEnable} disabled={enabling}>
                  {enabling ? (
                    <>
                      <Loader2 className="animate-spin" />
                      {linked === true ? "Getting Ready…" : "Enabling…"}
                    </>
                  ) : linked === true ? (
                    "Get This iPhone Ready"
                  ) : (
                    "Enable Tap to Pay on iPhone"
                  )}
                </Button>
              </>
            )}
            {enableError && <p className={ERROR_BOX}>{enableError}</p>}
            {enabled && (
              // Apple 3.9: the invitation to try it, right after the terms and the walkthrough.
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-emerald-800">
                <p className="font-medium">You are set — try it out.</p>
                <p className="mt-1">Open any unpaid invoice → Pay Now → Tap to Pay on iPhone.</p>
                <Link
                  href="/billing"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-dark"
                >
                  Open Invoices
                </Link>
              </div>
            )}
          </div>
        ) : (
          // Apple 3.8.1: not authorised to accept the terms → told who is, not shown a wall.
          <p>Ask an owner or admin to enable Tap to Pay on iPhone for this company first.</p>
        ))}

      {supported && (
        <div className="space-y-2">
          {/* Apple 4.3: the education, reachable later from Settings — Apple's own sheet. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void onHowTo()} disabled={guide.busy || enabling}>
              {guide.busy && <Loader2 className="animate-spin" />}
              How to Tap
            </Button>
            <span className="text-slate-500">Apple&apos;s own walkthrough of taking a tap, PIN entry included.</span>
          </div>
          {guide.note && (
            // Text-only fallback for an iPhone that can't show Apple's sheet (iOS < 18): the same
            // ground Apple's guide covers — cards, wallets, PIN and its accessibility options, and
            // the pay link as the way out. No imagery, on purpose.
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-600">
              <p>{guide.note}</p>
              <p className="mt-2">
                The written steps: open the unpaid invoice, tap Pay Now, then Tap to Pay on iPhone. Hold the iPhone
                still and ask the customer to hold their contactless card, iPhone or Apple Watch to the top of it
                until the screen shows Done. If Apple asks for a PIN, hand the customer the iPhone — the PIN screen
                has accessibility options for anyone who can&apos;t see it. A card that won&apos;t read can pay by
                the pay link instead.
              </p>
            </div>
          )}
          <p className="text-xs text-slate-500">{linkedLine(linked)}</p>
        </div>
      )}

      {isAdmin && canAccept && (
        // Apple 3.3 / 6.3: every eligible person told at least once — a push, sent by the company
        // once (the server keeps the once; a second press is answered with the date).
        <div className="space-y-2 border-t border-slate-100 pt-4">
          <p>
            Tell the crew, once, by push: every active owner, admin and office phone gets Apple&rsquo;s own line —
            &ldquo;Accept in-person payments with Tap to Pay on iPhone.&rdquo; — and where to find it. It goes out one time per company.
          </p>
          <Button size="sm" variant="outline" onClick={() => void onAnnounce()} disabled={announce.busy}>
            {announce.busy && <Loader2 className="animate-spin" />}
            Announce Tap to Pay on iPhone to the Crew
          </Button>
          {announce.line && <p className={announce.bad ? "text-rose-700" : "text-emerald-700"}>{announce.line}</p>}
        </div>
      )}

      {/* Apple's disclaimers, in full, HERE — the page every "Terms apply." in the app clicks
          through to (the awareness card's Terms link lands on this tab). Unconditional: it is
          displayed whatever the phone or the role says above. The Apple Pay sentence rides along
          because the short copy at the top names Apple Pay. The regions URL is the one thing in
          the paragraph a thumb can use, so it is a link and the rest is text. */}
      <div className="space-y-2 border-t border-slate-100 pt-4 text-xs text-slate-500">
        <p>
          {TAP_TO_PAY_FULL_DISCLAIMER.split(REGIONS_URL)[0]}
          <a href={REGIONS_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-slate-700">
            {REGIONS_URL}
          </a>
          {TAP_TO_PAY_FULL_DISCLAIMER.split(REGIONS_URL)[1]}
        </p>
        <p>{APPLE_PAY_DISCLAIMER}</p>
      </div>
    </div>
  );
}
