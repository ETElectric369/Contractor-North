"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useModalLock } from "@/components/ui/modal-lock";
import { isNativeShell } from "@/lib/native-shell";
import { STAFF_ROLES } from "@/lib/actions/perms";
import { showHowToTap, tapToPayPluginPresent } from "@/lib/native-tap";
import { tapToPayIntroSeen, tapToPayIntroState, tapToPayRole } from "@/app/(app)/billing/tap-actions";
import { APPLE_PAY_DISCLAIMER, TAP_TO_PAY_SHORT_COPY, TERMS_APPLY } from "./settings-section";

/**
 * THE ONCE-ONLY AWARENESS MOMENT for Tap to Pay on iPhone (2026-09-11) — Apple 3.1 / 3.2 / 3.3
 * / 6.2: every eligible person is told, once, on a FULL SCREEN, that the phone in their hand
 * can take a card. Mounted in the app shell so it can appear on whatever screen the app opened
 * on. Its own overlay, not <Modal>: Modal's largest size is a max-w-2xl sheet in a dimmed page,
 * and 3.2 wants the awareness moment to BE the screen — so this is a fixed, inset-0, scrollable
 * white surface above the dock (the Modal tier, z-[120]; dock is 70), padded under the notch
 * with var(--sat). Text only: Apple forbids custom imagery of the feature.
 *
 * THE WORDS ARE APPLE'S. Headline, subheadline, body and the two CTAs are the Tap to Pay on
 * iPhone marketing toolkit's, verbatim (settings-section.tsx keeps the shared strings) — which
 * is the one place Erik's Title Case law yields: "Enable now" and "Learn more" are Apple's
 * approved CTA strings and stay as written; "Got It" is ours and Title Case. The footnote is
 * Apple's law for a short placement: "Terms apply." plus the Apple Pay sentence (the body names
 * Apple Pay), clicking through to the Settings card where the full disclaimer is displayed.
 *
 * WHO IT IS FOR: STAFF ONLY. Billing is staff-only in this app — the dock hides Money from a
 * tech, createTapPaymentIntent and the token route are requireStaff — so a card announcing a
 * door a tech can't walk through would be the wrong kind of once. The server's `eligible`
 * (tapToPayIntroState) is the gate; STAFF_ROLES below is the belt on it, read from the role the
 * server also answers, so a wider `eligible` can never show this to a tech from here.
 *
 * ONCE MEANS ONCE, AND THE ONCE IS THE SERVER'S. Whether this person has seen the card is
 * profiles.tap_to_pay_intro_seen_at, read through tapToPayIntroState and stamped by
 * tapToPayIntroSeen BEFORE the card closes — checked, so a stamp that didn't land is a sentence
 * on the card, not a card that comes back tomorrow with no explanation. A local flag would reset
 * with the app's storage; a column doesn't. (This is the ONLY stored fact here: whether Apple's
 * terms are accepted is never stored — Apple 1.6 — and this card doesn't claim to know it.)
 *
 * NOT ANNOYING, by construction: iOS shell only (the plugin has to be on the bridge, or the card
 * would announce a door that isn't there); never on the login page; never within the first
 * 1.5 s of paint, so it can't land under a thumb mid-tap; never on top of something already
 * open (body.modal-open) — a launch it skips is still a launch it owes, so the once comes next
 * time. Every button leaves; none of them is a dead end.
 */

/** The Getting Paid cluster — settings/page.tsx's tab id, the same URL the crew push points at. */
const SETTINGS_DOOR = "/settings?tab=getpaid";
/**
 * Where "Learn more" lands when Apple's how-to sheet can't open on this iPhone: the same card,
 * told to run How to Tap on arrival (settings-section.tsx) so the person gets the bridge's real
 * sentence and the written steps instead of a tab with no word of why.
 */
const HOW_TO_DOOR = `${SETTINGS_DOOR}&howto=1`;
const FIRST_PAINT_GRACE_MS = 1_500;
/** The roles that take payments in this app (staff-guard.ts) — the only people this card is for. */

const HEADLINE = "Tap to Pay on iPhone";
const SUBHEADLINE = "Accept contactless payments right on your iPhone.";

export function TapToPayAwareness() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [canEnable, setCanEnable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The server is asked once per app load, not once per navigation: the layout persists across
  // client navigations, so this ref lives as long as the app does.
  const asked = useRef(false);
  // A stamp that failed once gets a second tap that simply closes — the sentence has said the
  // card will be back, and holding someone in a card they can't leave is the nag it exists to spare.
  const failedOnce = useRef(false);
  // Unmount, not navigation, is what cancels an in-flight ask: the layout stays mounted while the
  // app moves between screens, and a card that was owed shouldn't be lost to a redirect that
  // happened to land while the server was answering.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The shared ref-counted body lock: the page under the card can't scroll and the bottom nav
  // is hidden (body.modal-open), the same way every other full-screen surface does it.
  useModalLock(open);

  // A dialog takes focus when it opens, so a screen reader announces the headline and not the
  // page underneath. Focusing a div raises no keyboard.
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) surface.current?.focus();
  }, [open]);

  useEffect(() => {
    if (asked.current) return;
    if (!isNativeShell() || !tapToPayPluginPresent()) return;
    // The (app) layout never serves /login today (it redirects), but the rule is the rule, and a
    // guard that costs nothing outlives a route reshuffle.
    if (pathname.startsWith("/login")) return;
    // The grace timer IS re-armed by a navigation inside it (asked is still false then) — that is
    // the "never under a thumb mid-tap" rule holding across a redirect, not a lost card.
    const t = setTimeout(async () => {
      asked.current = true;
      const [state, role] = await Promise.all([tapToPayIntroState(), tapToPayRole()]);
      if (!mounted.current) return;
      // A server that couldn't answer is skipped, not shown: the column is still null, so the
      // card is still owed — the next launch asks again.
      if (!state.ok || !state.eligible || state.seenAt !== null) return;
      // Belt on the server's braces: a role we can read that isn't staff never sees this card,
      // whatever `eligible` said. A role that couldn't be read leaves it to `eligible`.
      if (role.ok && !STAFF_ROLES.includes(role.role)) return;
      if (typeof document !== "undefined" && document.body.classList.contains("modal-open")) return;
      setCanEnable(role.ok && role.canEnable);
      setOpen(true);
    }, FIRST_PAINT_GRACE_MS);
    return () => clearTimeout(t);
  }, [pathname]);

  /**
   * Stamp the once on the server, then close. False = the card is still up: the stamp didn't
   * land and the sentence says the card will be back — the NEXT tap closes regardless
   * (failedOnce), and whatever the tap was for still happens then.
   */
  async function close(): Promise<boolean> {
    if (busy) return false;
    if (failedOnce.current) {
      setOpen(false);
      return true;
    }
    setBusy(true);
    const r = await tapToPayIntroSeen();
    if (!mounted.current) return false;
    setBusy(false);
    if (!r.ok) {
      failedOnce.current = true;
      setNote(r.error);
      return false;
    }
    setOpen(false);
    return true;
  }

  /** Owner/admin: the Settings card, where Apple's terms are accepted (Apple 3.5 / 3.8). */
  async function onEnable() {
    if (await close()) router.push(SETTINGS_DOOR);
  }

  /**
   * Everyone: Apple's own how-to sheet (Apple 4.1, iOS 18+). The card closes first — the sheet
   * takes the whole screen and holds until the person closes it, and a card still up underneath
   * would only be waiting to be dismissed a second time. An iPhone that can't show the sheet is
   * sent to the Settings card instead, which runs How to Tap on arrival and shows the written
   * steps with the bridge's sentence.
   */
  async function onLearnMore() {
    if (!(await close())) return;
    const r = await showHowToTap();
    if (!mounted.current) return;
    if (!r.ok) router.push(HOW_TO_DOOR);
  }

  /** The footnote's Terms link: the full disclaimer lives on the Settings card. */
  async function onTerms() {
    if (await close()) router.push(SETTINGS_DOOR);
  }

  if (!open) return null;

  return (
    <div
      ref={surface}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tap-to-pay-intro-headline"
      className="fixed inset-0 z-[120] overflow-y-auto overscroll-contain bg-white outline-none"
    >
      {/* Under the notch (var(--sat)) and above the home indicator; the column centres on a
          tablet and fills a phone. min-h-full so the buttons sit low with the copy centred
          above them on a tall screen, and everything simply stacks and scrolls on a short one. */}
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,calc(var(--sat,0px)+1rem))]">
        <div className="flex flex-1 flex-col justify-center py-6">
          <h1 id="tap-to-pay-intro-headline" className="text-3xl font-semibold tracking-tight text-slate-900">
            {HEADLINE}
          </h1>
          <p className="mt-3 text-lg font-medium text-slate-800">{SUBHEADLINE}</p>
          <p className="mt-5 text-base leading-relaxed text-slate-700">{TAP_TO_PAY_SHORT_COPY}</p>
          {/* Ours, not Apple's: where the door is, for people who can walk through it (staff). */}
          <p className="mt-5 text-sm text-slate-600">
            <span className="font-medium text-slate-900">Where it lives:</span> open any unpaid invoice, tap Pay
            Now, then Tap to Pay on iPhone.
          </p>
          <p className="mt-2 text-sm text-slate-600">
            {canEnable
              ? "Enable now takes you to Settings › Getting Paid, where Apple’s Tap to Pay on iPhone terms are accepted once for the whole company."
              : "An owner or admin turns Tap to Pay on iPhone on once for the whole company in Settings › Getting Paid."}
          </p>
        </div>

        {/* Apple's CTA copy, verbatim (see the header); Got It is the plain way out. */}
        <div className="flex flex-col gap-2">
          {canEnable && (
            <Button type="button" size="lg" onClick={() => void onEnable()} disabled={busy}>
              Enable now
            </Button>
          )}
          <Button type="button" size="lg" variant={canEnable ? "outline" : "primary"} onClick={() => void onLearnMore()} disabled={busy}>
            Learn more
          </Button>
          <Button type="button" size="lg" variant="ghost" onClick={() => void close()} disabled={busy}>
            Got It
          </Button>
        </div>

        {note && <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{note}</p>}

        {/* The short disclaimer, the Apple Pay sentence, and the click-through to the full one. */}
        <p className="mt-6 text-xs leading-relaxed text-slate-500">
          {TERMS_APPLY} {APPLE_PAY_DISCLAIMER}{" "}
          <button
            type="button"
            onClick={() => void onTerms()}
            disabled={busy}
            className="underline underline-offset-2 hover:text-slate-700 disabled:opacity-50"
          >
            Terms
          </button>
        </p>
      </div>
    </div>
  );
}
