"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { LogOut, Settings } from "lucide-react";
import { GLASS_MENU_CLASS } from "@/components/ui/glass-menu";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ShareQrButton } from "@/components/share-qr-button";
import { initials } from "@/lib/utils";
import { signOut } from "@/app/login/actions";
import {
  removePushSubscription,
  releaseDeviceTokenOnSignOut,
  reportPushRegistrationFailure,
} from "@/app/(app)/settings/push-actions";
import { isNativeShell } from "@/lib/native-shell";
import { nativePushPermission, registerForNativePush } from "@/lib/native-push";
import type { Profile } from "@/lib/types";

/**
 * The topbar's ACCOUNT seek door — the avatar, always visible, far right.
 * One small glass menu holds the rare deliberate verbs that used to sit as
 * always-on bar buttons: the estimate QR, the language toggle, the Settings
 * door (the phone-app convention — settings live behind the avatar), and Sign out
 * (the app's most destructive one-tap verb, now one deliberate tap away
 * instead of beside Quick-add).
 *
 * THE MODAL RULE: ShareQrButton renders its QR <Modal> PORTALED to <body> (fixed-inset inside a backdrop-filter panel would clip),
 * so this panel must stay MOUNTED while that modal is open. The outside-click
 * and Escape close handlers therefore bail while <body> has `modal-open`
 * (Modal always sets it) — the z-[120] modal simply covers the z-[90] panel.
 * Same pattern as job-manage-menu.tsx; do NOT "fix" it with conditional
 * rendering or display:none on the panel.
 */
export function AccountMenu({
  profile,
  lang,
}: {
  profile: Profile | null;
  lang?: string;
}) {
  const [open, setOpen] = useState(false);
  // The TOUR opened it, not the user. While that's true, outside-clicks must not close it: the
  // tour's dimmer swallows every click and those land outside this panel, so one stray tap would
  // yank the menu out from under the step that is pointing at it.
  const [byTour, setByTour] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Nort drives this menu during the guided tour — see TourStep.opens. A plain window event so no
  // component has to know a tour exists beyond this one listener.
  useEffect(() => {
    const onTour = (e: Event) => {
      const d = (e as CustomEvent<{ menu?: string; open?: boolean }>).detail;
      if (d?.menu !== "account") return;
      setByTour(!!d.open);
      setOpen(!!d.open);
    };
    window.addEventListener("cn:tour-menu", onTour);
    return () => window.removeEventListener("cn:tour-menu", onTour);
  }, []);

  useEffect(() => {
    if (!open || byTour) return;
    const modalOpen = () => document.body.classList.contains("modal-open");
    const onDoc = (e: MouseEvent) => {
      // The QR modal is open (in-place, above us at z-[120]) — never close
      // underneath it; unmounting the panel would kill the modal mid-view.
      if (modalOpen()) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return; // Escape belongs to the open modal, not the panel
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, byTour]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          setByTour(false);
          setOpen((v) => !v);
        }}
        aria-label="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Account"
        className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-slate-100"
      >
        {profile?.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profile.avatar_url}
            alt=""
            className="h-9 w-9 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white">
            {initials(profile?.full_name)}
          </span>
        )}
      </button>
      {open && (
        /* Anchored to the VIEWPORT, not the button: the topbar can scroll/offset,
           which would drag an absolute menu up behind the bar (the documented
           quick-add gotcha). position is set INLINE because .glass-gloss forces
           position:relative (for its ::before sheen), which would override a
           Tailwind `fixed`. top 4.5rem clears the 4rem header. The max-height
           (viewport minus header + mobile bottom nav) + y-scroll keeps Sign Out
           reachable on short/landscape viewports — no row may ever hide under
           the dock (the /team "Remove blocked by menu bar" class of bug). */
        <div
          // THE TOUR ANCHORS ON THE WHOLE PANEL, not the Settings row inside it — the hole in the
          // tour's dimmer is the only place anything is visible, and a row-sized hole leaves the
          // rest of this menu under 72% black.
          data-tour="account-menu"
          style={{
            position: "fixed",
            top: "calc(4.5rem + var(--sat, 0px))",
            right: "0.5rem",
            maxHeight: "calc(100dvh - 9.5rem - var(--sat, 0px))",
            overflowY: "auto",
          }}
          className={`${GLASS_MENU_CLASS} w-60`}
        >
          {/* Who am I — moved out of the bar (it was hidden < sm anyway). */}
          <div className="relative z-10 border-b border-white/50 px-4 pb-2.5 pt-1">
            <div className="truncate text-sm font-medium text-slate-900">
              {profile?.full_name ?? "—"}
            </div>
            <div className="text-xs capitalize text-slate-400">{profile?.role ?? "user"}</div>
          </div>
          {/* Every employee's personal estimate link/QR — leads through it are
              credited to them. The control keeps its known face from the bar. */}
          <div className="relative z-10 flex min-h-[44px] items-center justify-between gap-3 px-4 py-1">
            <span className="text-sm font-medium text-slate-700">Estimate QR</span>
            <ShareQrButton />
          </div>
          <div className="relative z-10 flex min-h-[44px] items-center justify-between gap-3 px-4 py-1">
            <span className="text-sm font-medium text-slate-700">Language</span>
            <LanguageSwitcher current={lang} />
          </div>
          {/* THE settings door — every phone app parks Settings behind the avatar.
              (The Office-list entry stays too; this is the reachable one.) */}
          <Link
            href="/settings"
            // The tour points HERE, not at the /settings page — it's the door people can't find.
            data-tour="settings-link"
            onClick={() => setOpen(false)}
            className="relative z-10 flex min-h-[44px] w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15"
          >
            <Settings className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> Settings
          </Link>
          <div className="relative z-10 my-1 border-t border-white/50" />
          <form action={signOutAfterUnbindingPush}>
            <SignOutButton />
          </form>
        </div>
      )}
    </div>
  );
}

/** How long Sign Out will wait on the push teardown before leaving anyway. Long enough for the
 *  usual case (the OS hands back a token it already holds in a few hundred ms), short enough that
 *  a phone in airplane mode never feels like Sign Out is broken. */
const PUSH_TEARDOWN_MS = 4000;

/**
 * UNBIND THIS DEVICE'S PUSH BEFORE LEAVING (audit v921 high; the native half, 2026-09-16).
 *
 * On a shared crew phone the push row is pointed at whoever last registered — so after A signs
 * out, A's org notifications kept arriving on the device until B re-registered: job names,
 * customer names, invoice amounts, on a phone A no longer has any right to.
 *
 * The web half did this already. Inside the NATIVE SHELL it did nothing at all: there is no
 * service worker in a WKWebView, so `navigator.serviceWorker` has no registration, the whole
 * teardown fell through, and the APNs row survived the sign-out untouched. The shell's
 * counterpart to saveDeviceToken is the token, not an endpoint — so ask the OS for it and release
 * that row instead.
 *
 * Registering again does NOT raise a system prompt here: we only do it when permission is already
 * granted, and a granted permission means register() just hands back the token the OS is holding.
 */
async function unbindThisDevicesPush(): Promise<void> {
  if (isNativeShell()) {
    const perm = await nativePushPermission();
    if (perm !== "granted") return; // nothing was ever registered from this phone
    const r = await registerForNativePush();
    if (r.ok) await releaseDeviceTokenOnSignOut(r.token);
    // Nobody is watching this screen (we are on our way to /login), so the ops log is the sink.
    else await reportPushRegistrationFailure("signOut.register", r.error);
    return;
  }
  const reg = await navigator.serviceWorker?.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub?.endpoint) {
    await removePushSubscription(sub.endpoint);
    await sub.unsubscribe();
  }
}

/**
 * THE TEARDOWN IS NOW WAITED ON, WITH A CEILING (2026-09-16).
 *
 * It used to be fire-and-forget from onSubmit. That was survivable for web push, whose request is
 * dispatched in the same tick — but the native path has to ask the OS for the token first, and
 * `signOut` redirects to /login long before that answer comes back. An unbind that loses the race
 * every time is not an unbind. So Sign Out waits for it, capped: whatever happens in
 * PUSH_TEARDOWN_MS, the sign-out proceeds. It can never fail over the teardown, and can never
 * hang on it either. (The button already says "Signing Out…" for the whole wait.)
 */
async function signOutAfterUnbindingPush(): Promise<void> {
  try {
    await Promise.race([
      unbindThisDevicesPush(),
      new Promise<void>((resolve) => setTimeout(resolve, PUSH_TEARDOWN_MS)),
    ]);
  } catch {
    /* device push may be unavailable; signing out is not allowed to depend on it */
  }
  await signOut();
}

/** Sign Out goes quiet while the action runs: a second tap must never fire a second sign-out. */
function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      aria-busy={pending || undefined}
      className="relative z-10 flex min-h-[44px] w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15 disabled:opacity-60"
    >
      <LogOut className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {pending ? "Signing Out…" : "Sign Out"}
    </button>
  );
}
