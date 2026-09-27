"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Camera, Briefcase, CalendarPlus, FileText, Receipt, UserSearch, X, type LucideIcon } from "lucide-react";
import { SnapOrNoteProvider, openSnapOrNote } from "@/components/snap-or-note";
import { GLASS_MENU_CLASS } from "@/components/ui/glass-menu";
import { featureOn, type FeatureKey, type FeatureMap } from "@/lib/features";

/**
 * THE + (W1-11: eight rows to six). It lives in the top bar on every page.
 *
 * The office: Snap Or Note first (the one paper door: a photo, a PDF, a list or a note), then the
 * typed creates, each landing on its create form, never a list to hunt through (a ?new=1 the page
 * reads to open its form, or a route that IS the form). A switch that is off removes only its own
 * row (the switch board, 0352).
 *
 * CUT: New Customer (a customer is made inside New Job, New Estimate and New Invoice, and
 * Customers keeps its own Add) and New Reminder (My Day's Add line, the Reminders page's own line
 * and Nort make Reminders). /crm?new=1 and /tasks?new=1 still open those forms from a link.
 *
 * The crew: the + IS Snap Or Note (a photo of a receipt for the job he's on, or a note for the
 * office). He is never offered New Job, Appointment, Estimate, Invoice or Lead: those saves are the
 * office's (createJob is requireStaff; a tech's New Job failed on Save).
 *
 * Papers waiting to be filed show up as Needs You rows on My Day; Add Cost stays on My Day's Now
 * card and the job's own page (job-scoped).
 */
export const ACTIONS: { label: string; href: string; icon: LucideIcon; staffOnly?: boolean; feature?: FeatureKey }[] = [
  { label: "New Lead", href: "/leads?new=1", icon: UserSearch, staffOnly: true, feature: "leads" },
  { label: "New Job", href: "/jobs?new=1", icon: Briefcase, staffOnly: true },
  { label: "New Appointment", href: "/schedule?new=appointment", icon: CalendarPlus, staffOnly: true },
  { label: "New Estimate", href: "/quotes/new", icon: FileText, staffOnly: true, feature: "estimates" },
  { label: "New Invoice", href: "/billing?new=1", icon: Receipt, staffOnly: true },
];

/** The + menu's typed verbs for this person: role first, then the switches. No map = everything on. */
export function quickAddActions(isStaff: boolean, features?: FeatureMap | null) {
  return ACTIONS.filter((a) => (isStaff || !a.staffOnly) && (!a.feature || featureOn(features, a.feature)));
}

/** What a tap on the + does: the office's menu, or (the crew) Snap Or Note itself. */
export function plusOpens(isStaff: boolean): "menu" | "snap-or-note" {
  return isStaff ? "menu" : "snap-or-note";
}

/** A soft navigation that hasn't landed in this long, tapped again, is stuck: the next tap loads. */
export const STUCK_MS = 10_000;

export type QuickAddGo = { way: "soft" } | { way: "full" } | { way: "offline"; said: string };

/**
 * THE TAP THAT DID NOTHING, TWICE (bug-report triage 2026-09-27; the 09-23 sweep's "Didn't open new
 * job"). With no signal the first New Job tap failed to load and the shell said "That page didn't
 * load"; a second tap, still with no signal, did nothing and said nothing: Next's router was still
 * waiting on the failed load, and it never retries a load to the same address.
 *
 *   · no signal (navigator.onLine false): say so in words, right where the tap was, and don't try;
 *   · the last navigation failed (the shell's cn:navigation-failed), or the same tap's soft
 *     navigation never landed: a FULL load, which really retries;
 *   · otherwise the ordinary soft navigation.
 */
export function quickAddGo(o: { online: boolean; lastFailed: boolean; stuck: boolean; label: string }): QuickAddGo {
  if (!o.online) return { way: "offline", said: `No signal right now, so ${o.label} can't open. Tap it again once you have a bar or two.` };
  if (o.lastFailed || o.stuck) return { way: "full" };
  return { way: "soft" };
}

const ROW =
  "relative z-10 flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15";

/** The office's menu rows: Snap Or Note first, then the typed creates. */
export function QuickAddMenu({
  isStaff,
  features,
  onSnap,
  onGo,
  said = null,
}: {
  isStaff: boolean;
  features?: FeatureMap | null;
  onSnap: () => void;
  onGo: (a: (typeof ACTIONS)[number]) => void;
  /** A tap that couldn't go (no signal), said under the rows. */
  said?: string | null;
}) {
  return (
    <>
      <button type="button" onClick={onSnap} className={ROW}>
        <Camera className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> Snap Or Note
      </button>
      {quickAddActions(isStaff, features).map((a) => (
        <button type="button" key={a.href} onClick={() => onGo(a)} className={ROW}>
          <a.icon className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {a.label}
        </button>
      ))}
      {said && (
        <p className="relative z-10 px-4 py-2 text-sm text-amber-900" role="status">
          {said}
        </p>
      )}
    </>
  );
}

/** The + in the top bar. `placement` is accepted and ignored: the + only lives in the top bar now
 *  (the floating button is gone), and the top bar still names it. */
export function GlobalQuickAdd({
  isStaff = false,
  features,
}: {
  placement?: "topbar";
  isStaff?: boolean;
  /** The shell's switch map: a switched-off feature's "New …" verb isn't offered. */
  features?: FeatureMap;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  /** The shell said the last navigation failed: the next tap is a full load. */
  const failed = useRef(false);
  /** The last soft navigation this + started, until the page it asked for is on screen. */
  const pending = useRef<{ href: string; from: string; at: number } | null>(null);

  useEffect(() => {
    const onFail = () => {
      failed.current = true;
    };
    window.addEventListener("cn:navigation-failed", onFail);
    return () => window.removeEventListener("cn:navigation-failed", onFail);
  }, []);

  function go(a: (typeof ACTIONS)[number]) {
    const here = window.location.href;
    const p = pending.current;
    // Landed: the address moved since that tap.
    if (p && p.from !== here) pending.current = null;
    const stuck = !!p && p.from === here && p.href === a.href && Date.now() - p.at > STUCK_MS;
    const next = quickAddGo({
      online: typeof navigator === "undefined" || navigator.onLine !== false,
      lastFailed: failed.current,
      stuck,
      label: a.label,
    });
    if (next.way === "offline") {
      // Said right where the tap was: the menu stays open with the sentence under the rows.
      setSaid(next.said);
      return;
    }
    setSaid(null);
    setOpen(false);
    if (next.way === "full") {
      failed.current = false;
      pending.current = null;
      window.location.assign(a.href);
      return;
    }
    pending.current = { href: a.href, from: here, at: Date.now() };
    router.push(a.href);
  }

  const crew = plusOpens(isStaff) === "snap-or-note";
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          if (crew) return openSnapOrNote();
          setSaid(null);
          setOpen((v) => !v);
        }}
        aria-label={crew ? "Snap Or Note" : "Quick Add"}
        title={crew ? "Snap Or Note" : "Quick Add"}
        aria-haspopup={crew ? undefined : "menu"}
        aria-expanded={crew ? undefined : open}
        className="btn-gloss inline-flex h-11 w-11 items-center justify-center rounded-full bg-slate-900 text-white shadow-sm hover:bg-slate-700"
      >
        {open ? <X className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
      </button>
      {open && !crew && (
        <>
          <div className="fixed inset-0 z-[80]" onClick={() => setOpen(false)} />
          {/* Anchored to the VIEWPORT, not the button: the topbar can scroll/offset, which dragged an
              absolute menu up behind the bar. position is set INLINE because .glass-gloss forces
              position:relative (for its ::before sheen), which would override a Tailwind `fixed`.
              top 4.5rem clears the 4rem header. max-height (viewport minus header + mobile bottom
              nav) + y-scroll keeps the last verbs reachable on short/landscape viewports. */}
          <div
            style={{
              position: "fixed",
              top: "calc(4.5rem + var(--sat, 0px))",
              right: "0.5rem",
              maxHeight: "calc(100dvh - 9.5rem - var(--sat, 0px))",
              overflowY: "auto",
            }}
            className={`${GLASS_MENU_CLASS} w-60`}
          >
            <QuickAddMenu
              isStaff={isStaff}
              features={features}
              said={said}
              onSnap={() => {
                setOpen(false);
                openSnapOrNote();
              }}
              onGo={go}
            />
          </div>
        </>
      )}
      {/* THE ONE PAPER DOOR'S QUEUE AND SHEET, mounted once, here (it renders nothing while closed). */}
      <SnapOrNoteProvider isStaff={isStaff} />
    </div>
  );
}
