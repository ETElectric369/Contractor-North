"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Bug, ChevronDown, GraduationCap, LogOut, Settings } from "lucide-react";
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
import { featureOn, type FeatureMap } from "@/lib/features";
import { menuSections, visibleDock } from "@/lib/dock";
import { isStaffRole } from "@/lib/actions/perms";
import { helpRows, openSetup } from "@/lib/onboarding/help-rows";
import type { Answers } from "@/lib/playbook/types";
import type { Profile } from "@/lib/types";

/** Every row in this menu: a 44px target, icon then words, the glass tint on hover. */
const ROW = "relative z-10 flex min-h-[44px] w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15";

/** Bug Watch's row: the open count after a middot ("Bug Watch · 31"), nothing at zero or when the
 *  count couldn't be read — a count is a call to act, never a total and never a false zero. */
export const bugWatchLabel = (open: number | null | undefined): string =>
  typeof open === "number" && open > 0 ? `Bug Watch · ${open}` : "Bug Watch";

type Pending<T> = T | PromiseLike<T>;
const thenable = (v: unknown): v is PromiseLike<unknown> =>
  !!v && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";

/** A count the layout may hand over still in flight (it never holds up the shell): a plain number
 *  is used at once; a pending one fills in when it lands; a failure shows no number. Promise.resolve
 *  adopts React's RSC thenable, whose then() returns undefined (the cn-v930 crash, see dock.tsx). */
function useCount(v: Pending<number | null> | undefined): number | null {
  const [n, setN] = useState<number | null>(() => (thenable(v) ? null : typeof v === "number" ? v : null));
  useEffect(() => {
    let live = true;
    if (thenable(v)) {
      Promise.resolve(v).then(
        (x) => {
          if (live) setN(typeof x === "number" ? x : null);
        },
        () => {
          if (live) setN(null);
        },
      );
    } else setN(typeof v === "number" ? v : null);
    return () => {
      live = false;
    };
  }, [v]);
  return n;
}

/**
 * The topbar's ACCOUNT seek door — the avatar, always visible, far right.
 * One small glass menu holds the rare deliberate verbs that used to sit as
 * always-on bar buttons: the estimate QR, the language toggle, the Settings
 * door (the phone-app convention — settings live behind the avatar), and Sign out
 * (the app's most destructive one-tap verb, now one deliberate tap away
 * instead of beside Quick-add).
 *
 * OFFICE AND TOOLS LIVE HERE TOO (W1-07): one row per section the dock keeps behind the initials
 * (lib/dock inMenu), landing where visibleDock lands THIS person — Team for staff, Compliance for a
 * tech (Forms with Licenses off) — and Tools only with Calculators on.
 *
 * AND, WITH NORT OFF, HELP (W1-09): the setup rows that sit under Search Or Ask while Nort is on
 * (Start Here, Finish Setting Up, Show Me How, Take The Setup Again — lib/onboarding/help-rows),
 * for staff. Start Here opens the questions (the tour is Nort talking). The avatar carries the
 * setup dot then, because this is the door that holds them.
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
  platformAdmin = false,
  features,
  setup,
  onboarded = true,
  setupDot = false,
  bugCount,
}: {
  profile: Profile | null;
  lang?: string;
  /** North's own team only: Bug Watch, every company's reports and the AI status (Wave 0). */
  platformAdmin?: boolean;
  /** The shell's switch map: the Estimate QR is a Leads door (it hands out the lead link); Tools
   *  goes with Calculators; Help shows with Nort off. */
  features?: FeatureMap;
  /** The company's setup answers (the layout's), for Help's Finish Setting Up row. */
  setup?: Answers;
  /** profiles.onboarded_at: Help leads with Start Here until this person has been walked through. */
  onboarded?: boolean;
  /** Setup waits on this person and Help is the door that holds it (Nort off): a dot, never a count. */
  setupDot?: boolean;
  /** Bug Watch's open count (platform admins only), possibly still in flight. */
  bugCount?: Pending<number | null>;
}) {
  const [open, setOpen] = useState(false);
  // The TOUR opened it, not the user. While that's true, outside-clicks must not close it: the
  // tour's dimmer swallows every click and those land outside this panel, so one stray tap would
  // yank the menu out from under the step that is pointing at it.
  const [byTour, setByTour] = useState(false);
  // Show Me How's lessons, folded under their row until it's tapped.
  const [lessonsOpen, setLessonsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isStaff = isStaffRole(profile?.role ?? "");
  // The sections the dock keeps behind the initials, for THIS person and these switches.
  const inMenu = menuSections(visibleDock({ isStaff, features }));
  // Nort on, these rows live under Search Or Ask instead (command-bar.tsx); techs have none.
  const help = featureOn(features, "nort") ? [] : helpRows({ isStaff, onboarded, setup, nortOn: false, features });
  const bugs = useCount(platformAdmin ? bugCount : null);

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
        // `data-upright`: the top bar never rotates in the App Store app, so when the phone is turned
        // this 44px square's face is painted through the same quarter turn and the avatar reads upright.
        // ON THE BUTTON — the panel below is a SIBLING, and a transform on the wrapper would anchor its
        // position:fixed to this control instead of the viewport (globals.css says why).
        data-upright
        title={setupDot ? "Account — setup is waiting under Help" : "Account"}
        className="relative flex h-11 w-11 items-center justify-center rounded-full hover:bg-slate-100"
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
        {setupDot && (
          <span data-x="setup-dot" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-white" />
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
              credited to them. The control keeps its known face from the bar. It goes with
              the Leads switch (0352): it is the lead link, handed out. */}
          {featureOn(features, "leads") && (
            <div className="relative z-10 flex min-h-[44px] items-center justify-between gap-3 px-4 py-1">
              <span className="text-sm font-medium text-slate-700">Estimate QR</span>
              <ShareQrButton />
            </div>
          )}
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
            className={ROW}
          >
            <Settings className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> Settings
          </Link>
          {/* Office, then Tools (Calculators on): the sections off the bar, with their own icons. */}
          {inMenu.map((s) => {
            const Icon = s.icon;
            return (
              <Link key={s.key} href={s.href} data-tour={`menu-${s.key}`} onClick={() => setOpen(false)} className={ROW}>
                <Icon className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {s.label}
              </Link>
            );
          })}
          {platformAdmin && (
            <Link
              href="/bugs"
              onClick={() => setOpen(false)}
              className={ROW}
            >
              {/* The open reports, counted the Bugs page's way (layout.tsx), after a middot. */}
              <Bug className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {bugWatchLabel(bugs)}
            </Link>
          )}
          {help.length > 0 && (
            <>
              <div className="relative z-10 my-1 border-t border-white/50" />
              <div className="relative z-10 px-4 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Help</div>
              {help.map((r) =>
                r.key === "lessons" ? (
                  <div key={r.key}>
                    <button type="button" aria-expanded={lessonsOpen} onClick={() => setLessonsOpen((v) => !v)} className={ROW}>
                      <GraduationCap className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {r.label}
                      <ChevronDown className={`ml-auto h-4 w-4 shrink-0 text-slate-400 transition-transform ${lessonsOpen ? "rotate-180" : ""}`} />
                    </button>
                    {lessonsOpen &&
                      r.lessons.map((l) => (
                        <button
                          key={l.key}
                          type="button"
                          // openSetup unlocks audio INSIDE this tap, then asks SetupHost to run it.
                          onClick={() => {
                            openSetup(l.request);
                            setOpen(false);
                          }}
                          className={`${ROW} pl-11`}
                        >
                          <span className="min-w-0">
                            <span className="block">{l.label}</span>
                            <span className="block text-xs font-normal text-slate-500">{l.sub}</span>
                          </span>
                        </button>
                      ))}
                  </div>
                ) : (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => {
                      openSetup(r.request);
                      setOpen(false);
                    }}
                    className={ROW}
                  >
                    <GraduationCap className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {r.label}
                  </button>
                ),
              )}
            </>
          )}
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
