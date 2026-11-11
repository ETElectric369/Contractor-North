"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Plus, Camera, Briefcase, CalendarPlus, ClipboardCheck, FileText, Receipt, UserSearch, X, type LucideIcon } from "lucide-react";
import { SnapOrNoteProvider, openSnapOrNote, snapStillSending } from "@/components/snap-or-note";
import { QuickMeasureRows, useLidarDoors } from "@/components/quick-measure-rows";
import { QuickMeasureSheet } from "@/components/quick-measure-sheet";
import { GLASS_MENU_CLASS } from "@/components/ui/glass-menu";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { featureOn, type FeatureKey, type FeatureMap } from "@/lib/features";
import {
  heldModelOf,
  measureAppLeft,
  measureHeld,
  askMeasureContext,
  measureOwnerKey,
  measureStore,
  reopenHeldModel,
  runQuickMeasure,
  setMeasureOwner,
  subscribeMeasure,
  type MeasureContext,
  type MeasureKind,
} from "@/lib/quick-measure";
import { discardModel } from "@/lib/quick-measure-save";

/**
 * THE + (W1-11: eight rows to six). It lives in the top bar on every page.
 *
 * The office: Snap or Note first (the one paper door: a photo, a PDF, a list or a note), then the
 * typed creates, each landing on its create form, never a list to hunt through (a ?new=1 the page
 * reads to open its form, or a route that IS the form). A switch that is off removes only its own
 * row (the switch board, 0352).
 *
 * CUT: New Customer (a customer is made inside New Job, New Estimate and New Invoice, and
 * Customers keeps its own Add) and New Reminder (My Day's Add line, the Reminders page's own line
 * and Nort make Reminders). /crm?new=1 and /tasks?new=1 still open those forms from a link.
 *
 * The crew: the + IS Snap or Note (a photo of a receipt for the job he's on, or a note for the
 * office). He is never offered New Job, Appointment, Estimate, Invoice or Lead: those saves are the
 * office's (createJob is requireStaff; a tech's New Job failed on Save).
 *
 * Papers waiting to be filed show up as Needs You rows on My Day; Add Cost stays on My Day's Now
 * card and the job's own page (job-scoped).
 *
 * MEASURE FROM THE + (cn-v1160). The owner, 2026-11-10: "a quick measure button on the top bar ...
 * with dropdown for the 3 options", and, shown that a seventh 44px button does not fit a phone's bar
 * (33px over at 375), "in the + menu agreed". The office's menu carries a Lidar group right under Snap
 * or Note (components/quick-measure-rows): Measure, Measure Area and 3D Scan, drawn only where the
 * plugin is on the bridge, which is read once after mount, so a browser's + and the server's render
 * are what they were. A tap closes this menu FIRST and then opens the camera; where the result goes is
 * lib/quick-measure's to say (the Inspector's own flow on a visit, else the one sheet mounted below,
 * beside Snap or Note's). The crew's + is untouched: still Snap or Note in one tap, and nothing of
 * the group mounts for a tech.
 *
 * THE WORDS (cn-v1139): each verb is a key in the nav catalog (lib/words/nav.ts nv_add_), read
 * through the person's translator when the rows are built (quickAddActions), so the English is
 * byte for byte what the row said and a Spanish reader sees Nuevo Trabajo. No English literal
 * lives here: this file is one the leak scan reads (tests/tech-words-in-the-catalog.test.ts).
 */
export const ACTIONS: { key: string; href: string; icon: LucideIcon; staffOnly?: boolean; feature?: FeatureKey }[] = [
  { key: "nv_add_newLead", href: "/leads?new=1", icon: UserSearch, staffOnly: true, feature: "leads" },
  { key: "nv_add_newJob", href: "/jobs?new=1", icon: Briefcase, staffOnly: true },
  { key: "nv_add_newAppointment", href: "/schedule?new=appointment", icon: CalendarPlus, staffOnly: true },
  // The Inspector's visit (Erik, 2026-10-15: "Add new inspection to plus menu"): the schedule's one
  // create form, opened on the inspection type. Leads off = no inspections = no door.
  { key: "nv_add_newInspection", href: "/schedule?new=inspection", icon: ClipboardCheck, staffOnly: true, feature: "leads" },
  { key: "nv_add_newEstimate", href: "/quotes/new", icon: FileText, staffOnly: true, feature: "estimates" },
  { key: "nv_add_newInvoice", href: "/billing?new=1", icon: Receipt, staffOnly: true },
];

/** A verb as the menu draws it: the row's data with its words in the person's language. */
export type QuickAddAction = (typeof ACTIONS)[number] & { label: string };

/** The + menu's typed verbs for this person: role first, then the switches, each with its words in
 *  the translator's language (English when not handed one). No map = everything on. */
export function quickAddActions(isStaff: boolean, features?: FeatureMap | null, t: (key: string) => string = translator("en")): QuickAddAction[] {
  return ACTIONS.filter((a) => (isStaff || !a.staffOnly) && (!a.feature || featureOn(features, a.feature))).map((a) => ({ ...a, label: t(a.key) }));
}

/** What a tap on the + does: the office's menu, or (the crew) Snap or Note itself. */
export function plusOpens(isStaff: boolean): "menu" | "snap-or-note" {
  return isStaff ? "menu" : "snap-or-note";
}

/**
 * WHOSE + CARRIES THE LIDAR GROUP (cn-v1160): the office's, on a company in good standing. The group
 * is rows in a menu, and only the office's + is a menu; giving it to the crew would turn their one-tap
 * + into one. So for a tech nothing of it mounts, whatever his phone can do: no rows, no sheet, no
 * mark, and the bridge is not asked. (A crew lead keeps the Inspector's own buttons on his visit.)
 */
export function plusMeasures(isStaff: boolean, lapsed = false): boolean {
  return !lapsed && plusOpens(isStaff) === "menu";
}

/** A soft navigation that hasn't landed in this long, tapped again, is stuck: the next tap loads. */
export const STUCK_MS = 10_000;

export type QuickAddGo = { way: "soft" } | { way: "full" } | { way: "offline"; said: string } | { way: "wait"; said: string };

/**
 * THE TAP THAT DID NOTHING, TWICE (bug-report triage 2026-09-27; the 09-23 sweep's "Didn't open new
 * job"). With no signal the first New Job tap failed to load and the shell said "That page didn't
 * load"; a second tap, still with no signal, did nothing and said nothing: Next's router was still
 * waiting on the failed load, and it never retries a load to the same address.
 *
 *   · no signal (navigator.onLine false): say so in words, right where the tap was, and don't try;
 *   · the last navigation failed (the shell's cn:navigation-failed, cleared as soon as a later
 *     navigation lands), or the same tap's soft navigation never landed: a FULL load, which really
 *     retries;
 *   · but never a full load while Snap or Note is still sending files: its queue lives in this
 *     page's memory and a reload would drop them without a word. That tap says so and waits;
 *   · nor while the + is holding a 3D model that is not saved yet (cn-v1160, `holding`): the model
 *     is 40 to 130 MB of this page's memory and minutes of walking, and nothing can bring it back
 *     after a reload. That tap says so too, with the two ways out (save it, or discard it). The
 *     files are said first: they finish on their own, the model waits for him;
 *   · otherwise the ordinary soft navigation.
 *
 * What it says comes from the nav catalog in the translator's language (cn-v1139), with the row's
 * own word in the {label} slot (the held model's sentence is the shell catalog's, beside the rest of
 * Measure's words); English when not handed a translator.
 */
export function quickAddGo(
  o: { online: boolean; lastFailed: boolean; stuck: boolean; label: string; sending?: number; holding?: boolean },
  t: (key: string) => string = translator("en"),
): QuickAddGo {
  if (!o.online) return { way: "offline", said: fillText(t("nv_add_noSignal"), { label: o.label }) };
  if (o.lastFailed || o.stuck) {
    const n = o.sending ?? 0;
    if (n > 0)
      return {
        way: "wait",
        said: n === 1 ? fillText(t("nv_add_stillSendingOne"), { label: o.label }) : fillText(t("nv_add_stillSendingMany"), { n: String(n), label: o.label }),
      };
    if (o.holding) return { way: "wait", said: fillText(t("sh_measure_holdingModel"), { label: o.label }) };
    return { way: "full" };
  }
  return { way: "soft" };
}

/** One mount's asking of who is on the phone: `live` until the + unmounts, `out` while an ask is. */
export type WhoAsk = { live: boolean; out: boolean };

/**
 * WHO IS ON THE PHONE (cn-v1160). A 3D model the + holds is page memory, and a sign-out is a soft
 * navigation, so the store hides what it holds whenever the + unmounts and gives it back only to the
 * same person in the same company (lib/quick-measure `left`, setMeasureOwner). The name is a read over
 * the network (POST /api/measure/context through askMeasureContext, the office's alone: a route, so
 * with no signal it never stands in front of his saves the way a server action would). One ask at a time. An answer that comes back
 * after the + unmounted is dropped: it names whoever was here when it was asked, and naming them now
 * would hand what was hidden at the leaving to whoever is here instead. The mount on screen asks for
 * itself. A failed ask names nobody, and the + asks again later (see its caller).
 */
export async function askWho(a: WhoAsk, ask: () => Promise<MeasureContext> = () => askMeasureContext("")): Promise<void> {
  if (!a.live || a.out) return;
  a.out = true;
  try {
    const c = await ask();
    if (a.live) setMeasureOwner(measureOwnerKey(c));
  } catch {
    // A dropped connection says nothing about who is signed in: nobody is named by it.
  } finally {
    a.out = false;
  }
}

const ROW =
  "relative z-10 flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15";

/** The office's menu rows: Snap or Note first, then (where the phone can) the Lidar group, then the
 *  typed creates. */
export function QuickAddMenu({
  isStaff,
  features,
  onSnap,
  onGo,
  said = null,
  lidar,
}: {
  isStaff: boolean;
  features?: FeatureMap | null;
  onSnap: () => void;
  onGo: (a: QuickAddAction) => void;
  /** A tap that couldn't go (no signal), said under the rows. */
  said?: string | null;
  /** The Lidar group (components/quick-measure-rows), drawn right under Snap or Note: the two capture
   *  doors together, the typed creates after them. With none, the menu is what it always was. */
  lidar?: ReactNode;
}) {
  // The paper door's name (cn-v1138) and the typed verbs (cn-v1139) in the person's language.
  const t = translator(useLang());
  return (
    <>
      <button type="button" onClick={onSnap} className={ROW}>
        <Camera className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {t("sh_snapOrNote")}
      </button>
      {lidar}
      {quickAddActions(isStaff, features, t).map((a) => (
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
  lapsed = false,
}: {
  placement?: "topbar";
  isStaff?: boolean;
  /** The shell's switch map: a switched-off feature's "New …" verb isn't offered. */
  features?: FeatureMap;
  /** The company has lapsed and this person is on an open door (the layout's red bar): every verb
   *  of the + is a closed door, so the + is not drawn at all (skeptic #43, S1). */
  lapsed?: boolean;
}) {
  const router = useRouter();
  const lang = useLang();
  const t = translator(lang);
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

  // A NAVIGATION LANDED (the dock, a link, anything): the last one no longer failed. Without this,
  // one offline tap hours ago made every later + tap a full reload.
  const pathname = usePathname();
  const landedOn = useRef(pathname);
  useEffect(() => {
    if (landedOn.current === pathname) return;
    landedOn.current = pathname;
    failed.current = false;
  }, [pathname]);

  // ── MEASURE FROM THE + (cn-v1160) ──────────────────────────────────────────────────────────
  // The doors are the phone's own answer, read once after mount and only for a person whose + has
  // the group at all (plusMeasures): until then, and in a browser, nothing of it is drawn.
  const measures = plusMeasures(isStaff, lapsed);
  const doors = useLidarDoors(measures);
  const hasDoors = measures && (doors.measure || doors.scan);
  const store = useSyncExternalStore(subscribeMeasure, measureStore, measureStore);
  /** The 3D model waiting in the +, when it is this person's to see: the mark on the + and its rows. */
  const held = measures ? heldModelOf(store) : null;
  /** The held model is on its way out: a discard's trip, which first takes back down a file that had
   *  already gone up. Kept HERE and not in the rows: the menu unmounts its rows when it closes, and a
   *  menu opened again in the middle of that trip must find them waiting. The row above Discard opens
   *  the sheet on the model, and its Finish Saving would write a job's row for a file being removed. */
  const [letting, setLetting] = useState(false);

  // WHOSE IT IS. The + is on every page of the app and on none outside it, so its unmounting IS the
  // app being left (a sign-out, or a page outside the shell such as a paper's preview): what is held
  // is hidden from that moment (measureAppLeft), and the mount that follows asks who is here.
  const who = useRef<WhoAsk>({ live: false, out: false });
  useEffect(() => {
    if (!hasDoors) return;
    const a: WhoAsk = { live: true, out: false };
    who.current = a;
    // EVERY MOUNT ASKS FOR ITSELF, whatever the store already says: a name in it is the answer to a
    // question some earlier mount asked, and who is here now is this one's to find out.
    void askWho(a);
    return () => {
      a.live = false;
      measureAppLeft();
    };
  }, [hasDoors]);
  // ONE ASK IS ENOUGH WHEN IT ANSWERS, and it nearly always does: the name is kept and nothing asks
  // again. With no signal when the app opened it does not, and then nobody is named while a scan,
  // which needs no signal, can still be held; the store drops a model left behind unnamed rather than
  // hand it to the next person. So for as long as nobody is named the ask is made again at the
  // moments that cost nothing: the menu opening or closing, a model coming to be held, the signal
  // coming back. Never on a timer: the app sends its saves one at a time, and a read repeating over a
  // bad connection would stand in front of his own.
  const unnamed = hasDoors && (store.owner === null || store.left);
  const holding = store.held !== null;
  useEffect(() => {
    if (!unnamed) return;
    const ask = () => void askWho(who.current);
    ask();
    window.addEventListener("online", ask);
    return () => window.removeEventListener("online", ask);
  }, [unnamed, holding, open]);

  /** A LIDAR ROW WAS TAPPED. The menu closes FIRST and then the screen opens: the measuring screen is
   *  the phone's own, drawn over the page, and a menu left open under it would be the first thing he
   *  met on the way back. Where the result goes is lib/quick-measure's to say. */
  function pick(kind: MeasureKind) {
    setSaid(null);
    setOpen(false);
    void runQuickMeasure(kind, { lang, words: t });
  }

  function go(a: QuickAddAction) {
    const here = window.location.href;
    const p = pending.current;
    // Landed: the address moved since that tap.
    if (p && p.from !== here) pending.current = null;
    const stuck = !!p && p.from === here && p.href === a.href && Date.now() - p.at > STUCK_MS;
    const next = quickAddGo(
      {
        online: typeof navigator === "undefined" || navigator.onLine !== false,
        lastFailed: failed.current,
        stuck,
        label: a.label,
        sending: snapStillSending(),
        holding: measureHeld(),
      },
      t,
    );
    if (next.way === "offline" || next.way === "wait") {
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
  // After the hooks, so the mount is the same shape whatever the standing says.
  if (lapsed) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          if (crew) return openSnapOrNote();
          setSaid(null);
          setOpen((v) => !v);
        }}
        aria-label={crew ? t("sh_snapOrNote") : t("sh_quickAdd")}
        title={crew ? t("sh_snapOrNote") : t("sh_quickAdd")}
        // `data-upright`: in the App Store app the top bar never rotates, so when the phone is turned
        // this button's face is painted through the same quarter turn and reads upright. ON THE BUTTON,
        // never on the wrapper above — the menu below is a SIBLING, and a transform on an ancestor
        // would make it the containing block for the menu's position:fixed (globals.css says why).
        data-upright
        aria-haspopup={crew ? undefined : "menu"}
        aria-expanded={crew ? undefined : open}
        className="btn-gloss inline-flex h-11 w-11 items-center justify-center rounded-full bg-slate-900 text-white shadow-sm hover:bg-slate-700"
      >
        {open ? <X className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
      </button>
      {/* A 3D MODEL IS WAITING IN THE +: a mark, never a count (a badge counts what is open, and this is
          one thing that waits). Beside the button and not inside it: the button clips what it holds to
          its circle, and its face turns with the phone. It takes no tap; the row in the menu is the door. */}
      {held && (
        <span
          role="img"
          aria-label={t("sh_btn_measureHeldModel")}
          className="pointer-events-none absolute right-0 top-0 h-3 w-3 rounded-full bg-amber-400 ring-2 ring-white"
        />
      )}
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
              lidar={
                <QuickMeasureRows
                  doors={doors}
                  busy={store.busy !== null || letting}
                  held={held !== null}
                  // A model is in the + that this person has not been named for yet: it cannot be
                  // shown and it cannot be scanned over, so 3D Scan waits for the name.
                  scanWaits={store.held !== null && held === null}
                  onPick={pick}
                  onReopen={() => {
                    // The sheet opens over the page, never under an open menu.
                    setSaid(null);
                    setOpen(false);
                    reopenHeldModel();
                  }}
                  // The menu stays open: the group going back to 3D Scan, and the mark leaving the +,
                  // are how he sees that it went. A sentence a tap had said about the held model is
                  // no longer true once it has gone, so it goes too.
                  onDiscard={async () => {
                    setLetting(true);
                    try {
                      await discardModel();
                    } finally {
                      setLetting(false);
                    }
                    setSaid(null);
                  }}
                />
              }
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
      {/* MEASURE'S ONE RESULT SHEET, mounted once, beside it (nothing while no result is open). Outside
          the menu, so closing the menu never takes an open sheet with it; and NEVER KEYED: a key around
          an open Modal makes the new one close itself (the cn-v1156 law). It resets with state. */}
      {measures && <QuickMeasureSheet features={features} />}
    </div>
  );
}
