"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Loader2, MapPin } from "lucide-react";
import { adoptGeofenceAnchor, geoClockOut, notifyGeofenceExit } from "@/app/(app)/timeclock/actions";
import { adoptOpensAtMs, adoptTick, adoptWindowMs } from "@/app/(app)/timeclock/adopt-window";
import { firePunchLocation, fixWord, lastPunchMiss } from "@/lib/punch-gps";
import { newPunchTally, punchTracePayload, sendPunchTrace, tallyCheck, type PunchOutcome, type PunchTally } from "@/lib/punch-trace";
import { ClockStartPicker } from "@/app/(app)/timeclock/clock-start-picker";
import { isLongOpenShift, pickWithinCeiling, stopWindow } from "@/lib/long-shift";
import { splitClock } from "@/lib/split-preview";
import { fallbackArmed, type GeofencePhase } from "./geofence-fallback";
import { Button } from "@/components/ui/button";
import { speakSmart } from "@/lib/tts";
import { geoPermission, getPosition, getPunchPosition, hasNativeRead, nativeDeclares, shellAuthorization, shellMayReadLocation, watchPosition } from "@/lib/geo";
import { armFence, canOpenLocationSettings, disarmFence, fenceArmOptions, fenceReadiness, onFenceExit, openLocationSettings, takePendingExit, type FenceReadiness, type PendingExit } from "@/lib/native-geofence";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { trace } from "@/lib/nort/trace";
import type { GeoPoint } from "@/lib/types";
import { FENCE_REPORT_EVENT } from "@/lib/fence-report-event";

/**
 * May the fence read the phone's location without a tap? Off the shell, the web rule (geo.ts: a live
 * grant, never a read in "prompt" — the installed PWA silently denies an off-gesture prompt and it can
 * persist). Inside the shell, the phone's own answer (geo.ts shellMayReadLocation): the app
 * holds location permission itself, so a voice punch's fence can take the fix that adopts its site.
 */
async function mayReadLocation(): Promise<boolean> {
  return (await shellMayReadLocation()) ?? ((await geoPermission()) === "granted");
}

/**
 * LOCATION HAS NOT BEEN ASKED YET — which is not "no" (cn-v1137; Bug Watch: Time Clock says nothing
 * while permission is still "prompt"). The gate above refuses an off-gesture read in "prompt" (the
 * iOS rule), and until now the fence then went quietly dark: a console.warn and a tech who thought
 * the clock would notice him leaving. Off the shell this is the web's "prompt"; inside the shell it
 * is the phone before its first answer (shellMayReadLocation null). A denial is never this — the
 * denied banner says that.
 */
async function locationUnasked(): Promise<boolean> {
  if ((await shellMayReadLocation()) !== null) return false;
  return (await geoPermission()) === "prompt";
}

/**
 * WHAT THE FENCE SAYS WHILE NOTHING ELSE IS HAPPENING — one line, or none. Pure, so the words can be
 * rendered in a test without a phone. The order is the order of what matters: a denial beats
 * everything (there is no fence to turn on), then the ask, then the screen-off readiness, then a
 * lost anchor. `onTurnOn` must run navigator.geolocation.getCurrentPosition INSIDE the tap (the iOS
 * rule): a prompt fired off a gesture is denied silently by the installed PWA, and that can persist.
 */
export function GeofenceIdleLine({
  watchOff,
  waitingGrant,
  grantBusy = false,
  grantNote = null,
  fenceDark,
  anchorLost,
  anchorKnown,
  jobLabel,
  onTurnOn,
  canOpenSettings = false,
  onOpenSettings,
  onGotIt,
}: {
  watchOff: boolean;
  waitingGrant: boolean;
  grantBusy?: boolean;
  grantNote?: string | null;
  fenceDark: FenceReadiness | null;
  anchorLost: boolean;
  anchorKnown: boolean;
  jobLabel: string;
  onTurnOn: () => void;
  /** The shell has GeofencePlugin.openSettings (native-geofence canOpenLocationSettings). */
  canOpenSettings?: boolean;
  onOpenSettings?: () => void;
  /** Puts the lost-anchor line away for this clock-in (2026-11-18). Without it the words stand alone. */
  onGotIt?: () => void;
}) {
  // The person's language (cn-v1138): every line is a gf_ key; outside a provider (a test) it is English.
  const t = translator(useLang());
  const line = "mx-auto mb-3 max-w-2xl rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800";
  // OPEN SETTINGS (2026-11-16, "always on went away"): the off line, the While Using line and the
  // fence's off line tell a person to go to Settings; a shell that has the door also takes them
  // there. An older shell and a browser draw the words alone, as before; a refused open says
  // nothing more (the words say where).
  const withSettings = (words: string) =>
    canOpenSettings && onOpenSettings ? (
      <div className={line}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{words}</span>
          <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={onOpenSettings}>
            {t("sh_btn_openSettings")}
          </Button>
        </div>
      </div>
    ) : (
      <div className={line}>{words}</div>
    );
  if (watchOff) return withSettings(t("gf_locationOffForApp"));
  if (waitingGrant)
    return (
      <div className={line}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{fillText(t("gf_locationNotOnYet"), { label: jobLabel })}</span>
          <Button type="button" size="sm" variant="outline" className="shrink-0" disabled={grantBusy} onClick={onTurnOn}>
            {grantBusy && <Loader2 className="animate-spin" />} {t("gf_turnOnLocation")}
          </Button>
        </div>
        {grantNote && <p className="mt-1">{grantNote}</p>}
      </div>
    );
  if (fenceDark) {
    const words =
      fenceDark === "unavailable" ? t("gf_phoneCantWatchScreenOff") : fenceDark === "denied" ? t("gf_locationOffForNorth") : t("gf_locationWhileUsing");
    // A phone that cannot watch regions: Settings cannot help, so no door there.
    if (fenceDark === "unavailable") return <div className={line}>{words}</div>;
    return withSettings(words);
  }
  if (anchorLost && !anchorKnown) {
    const words = fillText(t("gf_couldntGetLocationAt"), { label: jobLabel });
    // GOT IT (2026-11-18): this line is about ONE clock-in (its anchor window closed), there is
    // nothing on the phone to turn on for it, and it stood for the whole shift. It is said until the
    // person says they read it; the tap puts it away for this entry, and the next entry says its own.
    if (!onGotIt) return <div className={line}>{words}</div>;
    return (
      <div className={line}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{words}</span>
          <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={onGotIt}>
            {t("cs_gotIt")}
          </Button>
        </div>
      </div>
    );
  }
  return null;
}

/**
 * WHERE THE IDLE LINE IS DRAWN: a strip in the page's own column, under the top bar (2026-11-18).
 *
 * The line above is an ordinary block. From 2026-08-18 the monitor was mounted as a child of the
 * shell's ROOT, which is a flex ROW (the dock beside the page's column), so the line was laid out
 * as a third COLUMN: stretched to the full height of the screen and as wide as its sentence. On a
 * phone that is every pixel but the dock. Every sentence belongs to a state a set-up phone is rarely
 * in (location off, not asked yet, While Using, a phone that cannot watch regions, no anchor), which
 * is how it stood unseen for three months. Some of them end at a button; the lost-anchor one never
 * does and lasts the shift, and on 2026-11-18 it covered the owner's phone from his clock-in on.
 * Nothing had crashed: the page was under it.
 *
 * So the layout mounts the monitor INSIDE the column, above <main> (tests/fence-line-in-the-column
 * pins that), and the line sits in this strip: the page's own gutters and the page's own tint (the
 * same wash <main> wears, so it reads as the top of the page and not a band under the bar), never
 * printed, and no box at all while there is no line (`empty:hidden`, so an idle fence costs the page
 * no pixel). The sheet the monitor draws when it has a question is `position: fixed` and does not
 * care where it is mounted.
 */
export const IDLE_STRIP = "no-print bg-slate-50/70 px-4 pt-3 empty:hidden shell:px-6";

/** Great-circle distance in meters. */
function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// A fix fuzzier than max(radius, this) tells us nothing — it neither confirms "inside"
// nor proves "left", so a junk reading can never false-fire or false-clear.
const ACCURACY_FLOOR_M = 200;
// "Still working" quiets every prompt/auto path for this long.
const SNOOZE_MS = 45 * 60_000;
// The window in which a missing anchor may still be adopted from a live fix is the SHARED
// adopt-window rule (imported so it can't drift from the server that enforces it): 15 min
// after clock-in, but a WIDER 45 min after a mid-shift switch — the switch cleared the
// anchor on purpose and the tech still has to drive to the new site (see adoptWindowMs).
// Wake-time exit checks (visibility/focus/route) run at most this often.
const WAKE_THROTTLE_MS = 60_000;
// The live-watch prompt sat unanswered this long, with GPS STILL outside → close the
// entry at the last GPS-observed at-site time (the pre-existing auto_gps behavior, now
// always preceded by a visible prompt).
const AUTO_FALLBACK_MS = 5 * 60_000;
/** Longer than this between accepted fixes and the watch was asleep, not the person (audit 6). */
const STREAM_GAP_MS = 15 * 60_000;

// Snooze survives the (frequent) iOS PWA page reload — an in-memory flag would re-prompt
// on every reopen right after the tech said "Still working".
const SNOOZE_KEY = "cn-geofence-snooze";
function snoozedUntil(entryId: string): number {
  try {
    const v = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "null");
    return v?.entryId === entryId ? Number(v.until) || 0 : 0;
  } catch {
    return 0;
  }
}
function setSnooze(entryId: string, until: number) {
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify({ entryId, until }));
  } catch {
    /* private mode etc. — snooze just won't survive a reload */
  }
}

// "Got It" on the lost-anchor line survives the reload for the same reason, and names ONE entry:
// the next clock-in says its own line.
const LOST_SEEN_KEY = "cn-geofence-lost-seen";
export function lostSeenFor(entryId: string): boolean {
  try {
    return localStorage.getItem(LOST_SEEN_KEY) === entryId;
  } catch {
    return false;
  }
}
export function markLostSeen(entryId: string) {
  try {
    localStorage.setItem(LOST_SEEN_KEY, entryId);
  } catch {
    /* private mode etc. — the line just comes back after a reload */
  }
}

// THE PUNCH'S LOCATION TRACE IS ONE ROW PER MOMENT OF A TRIP (cn-v1201, lib/punch-trace). The check
// says the window closed on every wake after it closed, and iOS reloads the page on most reopens, so
// the trip's mark is kept on the phone (the same way as Got It above) as well as in memory. The mark
// stays on the phone and in memory: it is never in the row, the title or the console.
const GEO_TRACE_KEY = "cn-geofence-trace-sent";
const geoTraceSent = new Set<string>();
export function firstGeoTrace(tripKey: string, outcome: PunchOutcome): boolean {
  const mark = `${tripKey}#${outcome}`;
  if (geoTraceSent.has(mark)) return false;
  geoTraceSent.add(mark);
  try {
    const seen: unknown = JSON.parse(localStorage.getItem(GEO_TRACE_KEY) ?? "[]");
    const list = Array.isArray(seen) ? seen.filter((x): x is string => typeof x === "string") : [];
    if (list.includes(mark)) return false;
    localStorage.setItem(GEO_TRACE_KEY, JSON.stringify([...list, mark].slice(-6)));
  } catch {
    /* private mode etc. — memory alone keeps it to one row per page load */
  }
  return true;
}

type Phase = GeofencePhase;

/**
 * WHAT THE SHEET DOES WITH AN EXIT IOS OBSERVED (carried 1123, #24).
 *
 * The phone forgets an exit the moment the page reads it (takePendingExit clears its copy), so every
 * early return between that read and the sheet used to be a deletion: reopen the app while the sheet
 * was already up, or let the effect re-run between the read and its .then, and the observed time was
 * gone and the person typed it by hand — the very thing the fence was built to remove. Now only an
 * exit that is truly MOOT is let go (the shift is over, it belongs to another shift, he already said
 * Still Working, this very exit is already on the sheet, or he was seen at the site AFTER it: he came
 * back, and "Looks like you left" over a man on site is a lie). Every other one is used or kept:
 *   open — the sheet is down: open it with the time filled in.
 *   fill — the sheet is up asking the question and promising nothing: put the time in its picker.
 *   keep — the sheet is up and busy (a live prompt that promises its own observed time, a picker he is
 *          using, a close in flight) or the effect that read it was torn down: hold it for the next
 *          free sheet / the effect that replaced this one.
 */
export type ExitHandoff = "open" | "fill" | "keep" | "drop";
export function exitHandoff(s: {
  /** The shift this monitor fences has been closed. */
  done: boolean;
  /** The exit is about THIS entry on THIS trip (a switch re-points the trip). */
  ours: boolean;
  /** He answered "Still Working" and the quiet is still running. */
  snoozed: boolean;
  /** This very exit (same entry, same moment) has already been put on the sheet. */
  handled: boolean;
  /** The effect that read the exit has been torn down since. */
  cancelled: boolean;
  phase: GeofencePhase;
  /** The sheet promises to close the shift on its own (fallbackArmed) — a time stated over it would end that promise. */
  armed: boolean;
  /** When iOS observed the exit (ms; NaN or absent = unknown, which never makes it moot). */
  exitedAtMs?: number;
  /** The last time a fix confirmed him AT the site on this trip (ms; 0 or absent = never confirmed). */
  insideAtMs?: number;
}): ExitHandoff {
  if (s.done || !s.ours || s.snoozed || s.handled) return "drop";
  // Seen at the site after the exit was observed: he is back. Moot beats busy and beats cancelled, so a
  // kept exit is not replayed over a man on site when the sheet that kept it closes.
  if (s.exitedAtMs != null && s.insideAtMs != null && s.insideAtMs > s.exitedAtMs) return "drop";
  if (s.cancelled) return "keep";
  if (s.phase === "idle") return "open";
  if (s.phase === "prompt" && !s.armed) return "fill";
  return "keep";
}

/**
 * WHETHER OPENING THE SHEET ASKS THE SERVER TO RING (carried 1123, #43). One site exit rings once: the
 * shell's own "Still on the clock?" already rang for an exit it saw (`alreadyRang`), and the server's
 * "Clock out?" is the same alert on the same phone. Once per entry per page-life, as before.
 */
export function shouldPushExit(s: { sentFor: string | null; entryId: string; alreadyRang: boolean }): boolean {
  return s.sentFor !== s.entryId && !s.alreadyRang;
}

/**
 * Global geofence watcher (mounted in the app shell while the user is clocked in).
 * Layered, honest-within-web-physics design — an iOS PWA gets NO background
 * geolocation, so everything here runs while the app is foregrounded:
 *
 *  1. ANCHOR — the entry's clock-in GPS. When clock-in couldn't capture one (a phone that
 *     did not answer inside the punch's few-second cap, a punch that outran the iOS
 *     permission dialog, the assistant's clock-in), the first good fix within 15 min of
 *     the clock-in is adopted and persisted (adoptGeofenceAnchor), so the fence works for
 *     EVERY clock-in, not just one whose punch got a position. The 15 minutes count from the TAP
 *     (the row's made-at time), not from a start that was typed or rounded back, and
 *     while they run the phone is asked again once a minute (cn-v1169).
 *  2. LIVE WATCH — while the app is open, watchPosition tracks the fence. Confirmed
 *     at-site → outside past the grace window ⇒ the prompt sheet opens. If it sits
 *     unanswered 5 min with GPS still outside, the entry closes at the time they were
 *     last OBSERVED at the site (never a guess — and never over-bills). The watch
 *     re-arms on visibility, since iOS kills it on suspension.
 *  3. WAKE EXIT-CHECK — on visibility/focus/route-change/mount (throttled), one quick
 *     capped fix; outside the fence ⇒ the same prompt sheet. This is what catches the
 *     drove-off-with-the-app-closed shift (the 30-hour Brian case) the moment the app
 *     is next opened. Wake prompts NEVER auto-close: this session never saw them at
 *     the site, so there is no observed exit time — the human states one.
 *
 * PAYROLL BOUNDARY: the sheet's "Clock out now" writes now (a true statement); "Pick
 * the time…" writes the USER's pick; the live auto-fallback writes the last
 * GPS-observed at-site time. Nothing is ever invented.
 */
export function GeofenceMonitor({
  entryId,
  gpsIn,
  clockInIso,
  madeAtIso = null,
  source = null,
  radiusM,
  graceMin = 4,
  jobLabel: jobLabelProp,
  jobId = null,
  startedBySwitch = false,
  shiftStartIso = null,
  tz,
  notify = true,
}: {
  entryId: string;
  gpsIn: GeoPoint | null;
  clockInIso: string;
  /** When the entry's row was MADE (the tap) and how it was made (time_entries.source). A missing
   *  anchor's clock-in window opens at the tap, not at a start that was typed or rounded back, except
   *  for an offline punch, whose row is made wherever the phone found a signal again (cn-v1169,
   *  adoptOpensAtMs). Left out, the window opens at the start, as it did. */
  madeAtIso?: string | null;
  source?: string | null;
  radiusM: number;
  graceMin?: number;
  jobLabel?: string;
  /** The entry's CURRENT job. A mid-shift switch re-points the entry (and moves or
   *  clears gps_in server-side), so this is the signal that the whole trip — anchor,
   *  seen-inside, last-inside — belongs to a different site now. Without it the fence
   *  kept judging the tech against the FIRST job's centre for the rest of the day. */
  jobId?: string | null;
  /** This entry began at a Switch Job (0288 cut, split_how 'live'). Its missing anchor gets the wider
   *  post-switch adoption window, like the server's (audit v994 SW2): the tech still has to drive to
   *  the new site, and Nort's switches never carry a fix. */
  startedBySwitch?: boolean;
  /** When the SHIFT began (lib/shift-chain). "Past twelve hours" counts from here (audit v994 SW1). */
  shiftStartIso?: string | null;
  /** The org's timezone: every time this sheet says or takes is on its clock (audit v994 TZ1). */
  tz?: string;
  /** The lock-screen "Still on the clock?" alert: techs only, as the server push is (audit v1120). */
  notify?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // The person's language (cn-v1138): the sheet, the idle line, the spoken and lock-screen words, and
  // the words handed to the shell's compiled alert (fenceArmOptions). A job with no label is "the job
  // site" in that language.
  const lang = useLang();
  const t = translator(lang);
  const jobLabel = jobLabelProp ?? t("gf_theJobSite");

  // ── one shared truth for both detection paths + the sheet's handlers ──────────
  const doneRef = useRef(false);
  const seenInsideRef = useRef(false);
  const lastInsideMsRef = useRef(0);
  /**
   * WHEN THE LAST ACCEPTED FIX ARRIVED — the stream, not the position (audit 6).
   *
   * The auto-close fires at `lastInsideMsRef`, "the last time we saw you at the site". That is a
   * sound conservative choice ONLY while the fix stream is continuous. iOS suspends a PWA in a
   * pocket and kills watchPosition; `seenInsideRef` stays true and `lastInsideMsRef` stays at
   * 07:20. Brian drives home at 16:00, the page wakes in the same page-life, the watch re-arms
   * OUTSIDE the fence, and four minutes later the monitor closes his shift at 07:20 — twenty
   * recorded minutes for a nine-hour day.
   *
   * A gap in the stream means the last-seen-inside time is a MEMORY, not an observation of an
   * exit. This is what tells the two apart.
   */
  const lastFixMsRef = useRef(0);
  const streamGapRef = useRef(false);
  const firstOutsideMsRef = useRef<number | null>(null);
  const lastFixRef = useRef<GeoPoint | null>(null); // stamps gps_out on close
  const promptShownAtRef = useRef(0);
  const promptSourceRef = useRef<"live" | "wake">("wake");
  const lastWakeCheckRef = useRef(0);
  // The complementary "Clock out?" push (techs only; server checks role) — sent at most
  // once per entry per page-life so GPS drift retract/re-prompt cycles can't spam.
  // Context rides in a ref so openPrompt keeps touching ONLY refs + stable setters
  // (the property both detection effects rely on to omit it from their deps).
  const exitPushSentRef = useRef<string | null>(null);
  // The label goes as given (undefined for a job with none): the server says "the job site" in the
  // reader's own language.
  const exitPushCtxRef = useRef<{ entryId: string; jobLabel: string | undefined }>({ entryId, jobLabel: jobLabelProp });
  exitPushCtxRef.current = { entryId, jobLabel: jobLabelProp };
  // An exit iOS saw that the sheet could not take yet (see exitHandoff). The phone cleared its own
  // copy when the page read it, so this ref is the only one left; takeKeptRef is how the live fence
  // effect takes it up again once a sheet is free (or when it replaced the effect that read it).
  const keptExitRef = useRef<PendingExit | null>(null);
  const takeKeptRef = useRef<() => void>(() => {});
  // The exit already on the sheet ("entry|moment"): iOS hands the same one over twice while the app is
  // awake (the live event, then the next foreground read) and the second must not pull him back.
  const handledExitRef = useRef("");

  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [pickedIso, setPickedIso] = useState<string | null>(null);
  const pickedIsoRef = useRef(pickedIso);
  pickedIsoRef.current = pickedIso;
  /** This prompt opened on a clock already running LONG_SHIFT_HOURS (straight onto the picker). */
  const longPromptRef = useRef(false);
  /** When the SHIFT began (the first piece after a Switch Job; else this entry's clock-in), in a ref
   *  so openPrompt still touches only refs and stable setters. */
  const shiftStartOf = () => {
    const ci = Date.parse(clockInIso);
    const s = shiftStartIso ? Date.parse(shiftStartIso) : NaN;
    return Number.isFinite(s) && (!Number.isFinite(ci) || s < ci) ? s : ci;
  };
  const shiftStartRef = useRef(shiftStartOf());
  shiftStartRef.current = shiftStartOf();
  /** The anchor window closed with no anchor: the fence cannot work on this shift, and he is told. */
  const [anchorLost, setAnchorLost] = useState(false);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Location permission is off/revoked — the fence can't watch, and he needs to know. */
  const [watchOff, setWatchOff] = useState(false);
  /** Location has not been asked yet (locationUnasked): the fence waits for a tap, and says so. */
  const [waitingGrant, setWaitingGrant] = useState(false);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantNote, setGrantNote] = useState<string | null>(null);
  /** The live watch's arm(), so the tap that wins the grant can arm it at once (set by the effect below). */
  const armRef = useRef<() => void>(() => {});
  /** iOS's fence can't work with the screen off (While Using, Denied, or no region monitoring): said, not swallowed. */
  const [fenceDark, setFenceDark] = useState<FenceReadiness | null>(null);
  /** The shell has the Open Settings door (2026-11-16); read after mount, so the first render is the server's. */
  const [canSettings, setCanSettings] = useState(false);
  useEffect(() => setCanSettings(canOpenLocationSettings()), []);
  /** He tapped Got It on the lost-anchor line for THIS entry (read after mount, kept on the phone). */
  const [lostSeen, setLostSeen] = useState(false);
  useEffect(() => setLostSeen(lostSeenFor(entryId)), [entryId]);

  // The fence anchor. Depend on PRIMITIVE lat/lng everywhere — the layout re-renders on
  // every navigation and hands us a fresh gpsIn object ref, which would otherwise tear
  // down the watch + reset the seen-inside state on every page change.
  const [anchor, setAnchor] = useState<GeoPoint | null>(gpsIn ?? null);
  const anchorLat = anchor?.lat;
  const anchorLng = anchor?.lng;
  const propLat = gpsIn?.lat;
  const propLng = gpsIn?.lng;
  // A NEW TRIP is "different entry" or "different job on the same entry" (a mid-shift
  // switch). Tracked as one key so both the anchor and the trip state below turn over
  // together and can't disagree about which site we're judging.
  const tripKey = `${entryId}|${jobId ?? ""}`;
  const tripKeyRef = useRef(tripKey);
  // When the CURRENT trip's anchor window opened — clock-in, or the moment we saw the
  // job change under us. Anchor adoption is measured from here, not from clock-in, or a
  // switch-cleared anchor could never be re-armed and the fence would stay dead all day.
  const tripStartMsRef = useRef(Date.parse(clockInIso) || Date.now());
  // What each adoption check of THIS trip got (cn-v1201, lib/punch-trace): counts and the best
  // accuracy only, for the one trace row. A new trip starts a new tally.
  const tallyRef = useRef<{ key: string; tally: PunchTally }>({ key: tripKey, tally: newPunchTally() });
  if (tallyRef.current.key !== tripKey) tallyRef.current = { key: tripKey, tally: newPunchTally() };
  useEffect(() => {
    const newTrip = tripKeyRef.current !== tripKey;
    tripKeyRef.current = tripKey;
    if (newTrip) tripStartMsRef.current = Date.now();
    if (typeof propLat === "number" && typeof propLng === "number") {
      setAnchor({ lat: propLat, lng: propLng });
    } else if (newTrip) {
      // Switched jobs with no fix to anchor on (switchJob nulls gps_in in that case).
      // DROP the old site's centre rather than keep fencing on it — a null anchor makes
      // the live watch stand down until adoptGeofenceAnchor re-arms it at the new site.
      // Only on a new trip: a plain re-render must never clear an adopted anchor.
      setAnchor(null);
    }
  }, [tripKey, propLat, propLng]);

  // Fresh trip ⇒ fresh trip state. Entry change (the monitor can survive a clock-out →
  // clock-in cycle without unmounting if renders batch) AND job change: after a switch,
  // a stale seenInside/lastInsideMs from site A would still be the auto-close timestamp,
  // so the fence could close the shift at the time they left the FIRST job.
  useEffect(() => {
    doneRef.current = false;
    seenInsideRef.current = false;
    lastInsideMsRef.current = clockInIso ? Date.parse(clockInIso) || Date.now() : Date.now();
    lastFixMsRef.current = 0;
    streamGapRef.current = false;
    firstOutsideMsRef.current = null;
    promptShownAtRef.current = 0;
    keptExitRef.current = null; // an exit from the last trip's site means nothing at this one
    setPhase("idle");
    setError(null);
    setClosedAt(null);
  }, [tripKey, clockInIso]);

  // Opens the sheet. Only touches refs + stable setters, so a stale closure is harmless.
  function openPrompt(source: "live" | "wake", alreadyRang = false) {
    promptSourceRef.current = source;
    promptShownAtRef.current = Date.now();
    setPickedIso(null);
    setError(null);
    // A CLOCK RUNNING LONG_SHIFT_HOURS (TWELVE) OR MORE (lib/long-shift) opens straight onto the picker, seeded at
    // the clock-in, with no "Clock Out Now": a close at now on a forgotten shift writes the night
    // onto payroll, and the server refuses it anyway.
    const long = isLongOpenShift(shiftStartRef.current, Date.now());
    longPromptRef.current = long;
    setPhase(long ? "picking" : "prompt");
    // Site-leave PUSH (Erik: "push at geofence for clock out only for techs") — the sheet
    // only renders while the app is foregrounded; the push also lands on the lock screen.
    // Fire-and-forget (never delays the sheet); the server no-ops for staff and for anyone
    // no longer clocked in. Detection behavior itself is untouched.
    // `alreadyRang`: the shell's own alert rang for this exit (carried 1123, #43) — the server's would be
    // the same alert twice on the same phone, so it is told once and not sent.
    const pushCtx = exitPushCtxRef.current;
    const push = shouldPushExit({ sentFor: exitPushSentRef.current, entryId: pushCtx.entryId, alreadyRang });
    exitPushSentRef.current = pushCtx.entryId;
    if (push) notifyGeofenceExit(pushCtx.jobLabel).catch(() => {});
    try {
      navigator.vibrate?.(40);
    } catch {}
  }

  /**
   * A PROMISE ON SCREEN NEEDS A CLOCK BEHIND IT (audit 8).
   *
   * Both the fallback check and this label used to run only when a GPS fix arrived. Pocket the
   * phone at the fence line and the stream stops: nothing re-evaluated, so the sheet kept
   * saying "we'll clock you out at 3:00" — a promise no code was going to keep — and the tech
   * trusted it. This heartbeat re-renders while the prompt is open so the label tells the truth
   * (and disappears when the observation goes stale), on a timer that doesn't depend on the
   * thing that died. It only ever ADDS evaluations; the conditions for an auto-close are
   * unchanged, so it cannot cause one that wasn't already earned.
   */
  const [, forcePromptTick] = useState(0);
  const armedNow = fallbackArmed({
    phase,
    longPrompt: longPromptRef.current,
    picked: pickedIso != null,
    source: promptSourceRef.current,
    lastInsideMs: lastInsideMsRef.current,
    streamGap: streamGapRef.current,
  });
  const heartbeat = phase === "prompt" || (phase === "picking" && longPromptRef.current && pickedIso == null);
  useEffect(() => {
    if (!heartbeat) return;
    const t = setInterval(() => forcePromptTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [heartbeat]);

  // What the un-answered fallback WOULD write, in his words — null when it cannot fire (a wake
  // prompt, or an observation we no longer trust). Same source as the submit() call below, so the
  // sheet can never promise a time the code wouldn't use. On the org's clock (TZ1).
  const autoAtLabel = armedNow ? splitClock(lastInsideMsRef.current, tz) : null;

  // The one write path for every close. `atIso` is now / the user's pick / the
  // observed last-at-site time — see the component doc.
  function submit(gps: GeoPoint | null, atIso: string, auto = false, picked = false) {
    setError(null);
    setPhase("saving");
    // `auto` here means "nobody answered" — the same flag the notification below keys on. It is
    // what marks the row for review, so an unattended close is never indistinguishable from one a
    // person agreed to.
    // The entry this monitor fenced rides along: a Switch Job closes it and opens a new one (0288),
    // and a leave-site verdict about the old shift must never close the new one.
    // `picked`: the person STATED this time in the picker. Past LONG_SHIFT_HOURS only a picked time
    // (or the unanswered observed close) is accepted by the server.
    geoClockOut(gps, atIso, auto, entryId, picked)
      .then((res) => {
        if (!res.ok) {
          // `ended` is the server's own word for a terminal refusal (cn-v1138); the English match stays
          // for a server built before it.
          if (res.ended || /not clocked in|already ended/i.test(res.error ?? "")) {
            // Already closed elsewhere (the panel, the office) — terminal; sync the UI.
            doneRef.current = true;
            setPhase("idle");
            router.refresh();
            return;
          }
          setError(res.error ?? t("gf_couldNotClockOut"));
          // The clock crossed LONG_SHIFT_HOURS while the sheet was up: the answer is a picked time.
          if (res.needsTime) {
            longPromptRef.current = true;
            setPickedIso(null);
            setPhase("picking");
            return;
          }
          setPhase(picked || longPromptRef.current ? "picking" : "prompt");
          return;
        }
        doneRef.current = true;
        setClosedAt(atIso);
        setPhase("confirmed");
        if (!auto && !res.undone) window.dispatchEvent(new Event(FENCE_REPORT_EVENT)); // the person's own tap: the daily report (cn-v1175), never an unattended close
        try {
          navigator.vibrate?.([60, 40, 60]);
        } catch {}
        if (auto) {
          try {
            speakSmart(t("gf_clockedOutYouLeftSpoken"));
          } catch {}
          // Works while the page is alive even if it was just backgrounded; if
          // notifications aren't granted, the in-app banner on /timeclock catches them.
          try {
            if ("Notification" in window && Notification.permission === "granted") {
              const n = new Notification(t("gf_clockedOutYouLeftTitle"), {
                // /timeclock asks only about lunch now (audit v994 SI8): no job codes to log.
                body: t("gf_tapToFinishTimecard"),
                tag: "geo-clockout",
              });
              n.onclick = () => {
                window.focus();
                window.location.href = "/timeclock";
              };
            }
          } catch {}
        }
        // Let the confirmation land before the refresh unmounts this (the entry is
        // closed, so the layout stops rendering the monitor).
        setTimeout(() => router.refresh(), 2600);
      })
      .catch(() => {
        setError(t("gf_noConnectionUntouched"));
        setPhase("prompt");
      });
  }

  function clockOutNow() {
    submit(lastFixRef.current, new Date().toISOString(), false, false);
  }

  function clockOutPicked() {
    const ci = Date.parse(clockInIso);
    // On a long shift nothing counts as picked until the person picks: "now" is the very default
    // this sheet exists to avoid. Long = twelve hours of the SHIFT (SW1).
    const long = longPromptRef.current || isLongOpenShift(shiftStartRef.current, Date.now());
    if (long && !pickedIso) {
      setError(pickWithinCeiling(lang));
      return;
    }
    const iso = pickedIso ?? new Date().toISOString(); // picker's "Use now" ⇒ now
    const ms = Date.parse(iso);
    const win = Number.isFinite(ci) ? stopWindow(ci, Date.now()) : null;
    if (isNaN(ms) || (win && (ms < win.minMs || ms > win.maxMs)) || ms > Date.now() + 60_000) {
      setError(pickWithinCeiling(lang));
      return;
    }
    submit(lastFixRef.current, iso, false, true);
  }

  function stillWorking() {
    // The human said so — quiet every path (prompt AND live auto) for 45 min, across
    // reloads. The exit clock restarts from scratch after the snooze.
    setSnooze(entryId, Date.now() + SNOOZE_MS);
    firstOutsideMsRef.current = null;
    promptShownAtRef.current = 0;
    setPhase("idle");
  }

  // ── 2. LIVE WATCH ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    if (typeof anchorLat !== "number" || typeof anchorLng !== "number") return;
    const center = { lat: anchorLat, lng: anchorLng };
    const graceMs = Math.max(60_000, graceMin * 60_000);
    const ignoreAccuracy = Math.max(radiusM, ACCURACY_FLOOR_M);

    const onFix = (fix: { coords: { lat: number; lng: number }; accuracy: number }) => {
      if (doneRef.current) return;
      const acc = fix.accuracy || 0;
      if (acc > ignoreAccuracy) return;
      const here = fix.coords;
      lastFixRef.current = { lat: here.lat, lng: here.lng, accuracy: acc };
      const d = haversineM(center, here);
      const now = Date.now();
      // A silence longer than a few fix intervals means the watch was DEAD, not that he stood
      // still. Everything we "know" about where he was is from before the silence.
      if (lastFixMsRef.current > 0 && now - lastFixMsRef.current > STREAM_GAP_MS) streamGapRef.current = true;
      lastFixMsRef.current = now;
      // Pad the radius by the fix's uncertainty so a fuzzy-but-usable fix can't trip it.
      if (d <= radiusM + acc) {
        seenInsideRef.current = true;
        lastInsideMsRef.current = now;
        streamGapRef.current = false; // presence re-observed — the memory is current again
        firstOutsideMsRef.current = null;
        // Back inside with the sheet un-actioned (GPS drift, or a quick run they
        // returned from) — retract it rather than nag. Never mid-pick/save.
        if (phaseRef.current === "prompt") {
          promptShownAtRef.current = 0;
          setPhase("idle");
        }
        return;
      }
      if (!seenInsideRef.current) return; // never confirmed at the site this page-life — the wake check owns that case
      if (firstOutsideMsRef.current == null) firstOutsideMsRef.current = now;
      if (now - firstOutsideMsRef.current < graceMs) return;
      // Confirmed exit: observed AT the site, then outside past the grace window.
      if (phaseRef.current === "idle") {
        if (now < snoozedUntil(entryId)) return;
        openPrompt("live");
        return;
      }
      // Prompt sat unanswered while GPS kept them outside → close at the last
      // OBSERVED at-site time (the pre-existing auto_gps path; conservative, never
      // over-bills). Only for live-sourced prompts — a wake prompt has no observed
      // exit, so it waits for the human.
      if (
        // A long-shift sheet opens on the picker; untouched, it is the same unanswered prompt. The
        // SAME predicate the on-screen promise uses (fallbackArmed), so it never fires unsaid.
        fallbackArmed({
          phase: phaseRef.current,
          longPrompt: longPromptRef.current,
          picked: pickedIsoRef.current != null,
          source: promptSourceRef.current,
          lastInsideMs: lastInsideMsRef.current,
          streamGap: streamGapRef.current,
        }) &&
        promptShownAtRef.current > 0 &&
        now - promptShownAtRef.current >= AUTO_FALLBACK_MS &&
        // THE OBSERVATION HAS TO BE AN OBSERVATION (audit 6). Two ways it isn't:
        //   · the fix stream had a hole — the watch was dead, so "last seen inside" is a memory;
        //   · the last inside fix is older than this whole exit could plausibly be.
        // In either case a human states the time. Nothing is lost by waiting: detectStrayTime
        // already surfaces a still-open entry as something the office must chase, and refusing
        // to guess is the difference between a late timecard and a wrong one.
        !streamGapRef.current &&
        now - lastInsideMsRef.current <= graceMs + AUTO_FALLBACK_MS + STREAM_GAP_MS
      ) {
        submit(lastFixRef.current, new Date(lastInsideMsRef.current).toISOString(), true);
      }
    };
    const onErr = (s: string) => {
      // Don't swallow: a watch that never arms (GPS off / permission revoked mid-shift)
      // means the fence can't track movement. The wake check still runs its own fixes.
      console.warn(`[geofence] location watch error: ${s} — live exit tracking degraded`);
      // AND TELL THE PERSON RELYING ON IT (audit 8). A safety net that quietly stopped
      // existing is worse than no safety net: he drives home assuming he'll be prompted, and
      // finds an open shift on Friday. Permission problems say so on the clock surface; a
      // transient timeout stays in the console where it belongs.
      if (/denied|permission/i.test(s)) setWatchOff(true);
    };
    const opts: PositionOptions = { enableHighAccuracy: true, maximumAge: 30_000, timeout: 60_000 };

    // THE iOS RULE (geo.ts): mounting is NOT a gesture — arming a watch pre-grant would fire an
    // off-gesture permission prompt, which the installed PWA silently denies and can PERSIST. Only arm
    // once the permission is granted (live, or memoized by the clock-in tap's fix); until then the
    // fence stays honestly quiet, and the rearm path below self-heals the moment a grant lands.
    let disposed = false;
    let warnedGate = false;
    let stop: () => void = () => {};
    const arm = async () => {
      if (disposed || doneRef.current) return;
      if (!(await mayReadLocation())) {
        // NOT ASKED YET IS SAID, NOT SWALLOWED (cn-v1137): in "prompt" the idle line offers Turn On
        // Location, whose tap is the gesture the rule needs; a denial leaves this false and the
        // denied banner (onErr / the tap's own answer) speaks instead.
        const unasked = await locationUnasked();
        if (!disposed) setWaitingGrant(unasked);
        if (!warnedGate) {
          warnedGate = true;
          console.warn("[geofence] location not granted yet — live exit tracking waits for the first granted fix");
        }
        return;
      }
      if (disposed || doneRef.current) return;
      setWaitingGrant(false);
      stop();
      stop = watchPosition(onFix, onErr, opts);
      trace("fence watch", "armed");
    };
    armRef.current = () => void arm();
    void arm();
    // iOS quietly kills the watch when the PWA suspends — re-arm it on every return
    // to the foreground (the old monitor never did, so it went deaf after one pocket).
    const rearm = () => {
      if (document.visibilityState !== "visible" || doneRef.current) return;
      void arm();
    };
    document.addEventListener("visibilitychange", rearm);
    return () => {
      disposed = true;
      armRef.current = () => {};
      document.removeEventListener("visibilitychange", rearm);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripKey, anchorLat, anchorLng, radiusM, graceMin]);

  /**
   * TURN ON LOCATION — the one read that may fire the permission prompt, because it is INSIDE a tap
   * (the iOS rule). A fix that lands memoizes the grant (geo.ts recordFix), so the gate answers
   * "granted" from here on: the live watch arms at once and the wake check runs with its throttle
   * slot handed back (an anchor the clock-in could not capture is adopted from this very fix). A
   * refusal is the denied banner's to say; a timeout or a phone with no fix keeps the line and says
   * what happened, so a tap that did nothing is never a tap that said nothing.
   */
  const turnOnLocation = () => {
    setGrantBusy(true);
    setGrantNote(null);
    void getPosition({ enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 }).then((r) => {
      setGrantBusy(false);
      if (r.status === "ok") {
        setWaitingGrant(false);
        lastWakeCheckRef.current = 0;
        armRef.current();
        checkRef.current();
        return;
      }
      if (r.status === "denied") {
        setWaitingGrant(false);
        setWatchOff(true);
        return;
      }
      setGrantNote(r.status === "timeout" ? t("gf_phoneDidntAnswerInTime") : t("gf_phoneCouldntGiveLocation"));
    });
  };

  // ── 1 + 3. WAKE EXIT-CHECK (and anchor adoption) ───────────────────────────────
  // Kept in a ref so the route-change effect below always calls the CURRENT check.
  const checkRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    let inFlightStamp = 0; // this effect's not-yet-finished check's throttle stamp

    /**
     * A MISSING ANCHOR'S WINDOW: where it opens and how long it runs. One reading for the check and
     * for the timer below.
     *
     * A mid-shift switch opened this trip iff tripStart is AFTER clock-in (a plain clock-in leaves
     * tripStart == clock-in). Switched ⇒ the wider 45-min window so a switch-cleared anchor can
     * actually be re-armed after the drive to the new site — the client used to cap every adoption
     * at 15 min, making the server's post-switch window dead code.
     *
     * SINCE 0288 A CUT SWITCH IS A NEW ENTRY (audit v994 SW2): the layout remounts this monitor per
     * entry, so tripStart equals the new piece's clock-in and the test above is never true. The
     * piece says it began at a switch (startedBySwitch), which is what the server reads too.
     *
     * THE CLOCK-IN WINDOW OPENS AT THE TAP (cn-v1169, adoptOpensAtMs, the server's own rule): the
     * owner's clock with a start typed eighty-one minutes back had its fifteen minutes spent before
     * the entry existed. tripStart itself is NOT moved to the tap: `switched` reads it against the
     * start, and a tap later than a typed start would then pass for a switch and claim the 45
     * minutes the server would refuse.
     */
    const adoptWindow = () => {
      const ciMs = Date.parse(clockInIso);
      const switched = startedBySwitch || (!isNaN(ciMs) && tripStartMsRef.current > ciMs);
      const opensMs = adoptOpensAtMs({ clockInMs: ciMs, madeAtMs: madeAtIso ? Date.parse(madeAtIso) : null, source });
      return { fromMs: Math.max(opensMs, tripStartMsRef.current || 0), windowMs: adoptWindowMs(switched) };
    };
    /** NOTHING SILENT: the window closed with no anchor, so the fence is off for this clock-in, and
     *  that is said (unless nothing is known about when the window opened: then there is nothing to say).
     *  The Time Clock removes its "still looking" note (cn-v1201: the fence's own line says the rest). */
    const windowClosed = (known = true) => {
      trace("fence window closed");
      if (known && !cancelled) {
        setAnchorLost(true);
        leaveTrace("no-position");
        firePunchLocation("closed");
      }
    };
    /**
     * THE GATE REFUSED A READ WHILE THERE IS NO ANCHOR (cn-v1201): location is off or was never
     * allowed. The Time Clock's "still looking" note becomes the location-off note, and once the
     * window has closed the trace's no-position row is sent all the same (it holds no position, so it
     * needs no read). The fence's "couldn't get a location" line is NOT shown here: a phone whose
     * location cannot be read has its own line.
     */
    const gateRefused = () => {
      if (cancelled || doneRef.current) return;
      firePunchLocation("off");
      const { fromMs, windowMs } = adoptWindow();
      if (fromMs && Date.now() - fromMs > windowMs) leaveTrace("no-position");
    };
    /**
     * THE REASON IS LEFT BEHIND (cn-v1201, lib/punch-trace): one row when the window closes with no
     * position, one when the late stamp lands. Codes and counts only; once per trip and moment.
     */
    const leaveTrace = (outcome: PunchOutcome) => {
      if (!firstGeoTrace(tripKey, outcome)) return;
      const { fromMs } = adoptWindow();
      const tally = tallyRef.current.tally;
      const tap = lastPunchMiss(fromMs);
      const nowMs = Date.now();
      void shellAuthorization().then((auth) =>
        sendPunchTrace(
          punchTracePayload({ outcome, tap, tally, openedMs: fromMs, nowMs, native: hasNativeRead(), shell1116: nativeDeclares("Geofence", "openSettings"), auth }),
        ),
      );
    };
    /**
     * THE SERVER'S WINDOW IS THE AUTHORITY (cn-v1169, skeptic #72). This phone's count can be WIDER
     * than the server's: a job picked on the Which Job sheet after clock-in, or an office move of the
     * punch, changes the job on the SAME entry, which reads here as a switch (45 minutes) and leaves
     * no breadcrumb for the server (15 minutes from the tap). Asked once a minute, the phone would
     * then read its location and be refused some thirty times and say the fence is off half an hour
     * late. So the server's refusal carries a flag (ClockResult.windowClosed): on it the line is said
     * at once, and neither the check nor the timer asks again for this effect's life (an anchor that
     * arrives, or a new trip, re-runs the effect and starts clean).
     */
    let serverClosed = false;

    const check = async () => {
      if (cancelled || doneRef.current || serverClosed) return;
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      if (phaseRef.current !== "idle") return; // sheet already up (or saving)
      const now = Date.now();
      if (now - lastWakeCheckRef.current < WAKE_THROTTLE_MS) return;
      lastWakeCheckRef.current = now;
      inFlightStamp = now;
      try {
        // THE iOS RULE (geo.ts): a wake is NOT a gesture — pre-grant, BOTH fixes below (anchor
        // adoption and the exit check) would fire an off-gesture permission prompt, which the
        // installed PWA silently denies and can PERSIST. Gate on granted (live or memoized by the
        // clock-in tap's fix) and hand the throttle slot back, so the first wake after the grant
        // isn't muted for 60s.
        const may = await mayReadLocation();
        trace("fence check", `${may ? "may read" : "no read"} anchor=${typeof anchorLat === "number" ? "yes" : "none"}`);
        if (!may) {
          if (lastWakeCheckRef.current === now) lastWakeCheckRef.current = 0;
          if (typeof anchorLat !== "number" || typeof anchorLng !== "number") {
            tallyCheck(tallyRef.current.tally, "noRead");
            gateRefused();
          }
          return;
        }
        if (cancelled || doneRef.current || phaseRef.current !== "idle") return;
        // No anchor (clock-in couldn't capture GPS) → adopt one from a good fix, but
        // only near clock-in. Past the window the fence stays honestly quiet for this
        // shift — the evening sweep still flags a forgotten entry.
        if (typeof anchorLat !== "number" || typeof anchorLng !== "number") {
          const { fromMs, windowMs } = adoptWindow();
          if (!fromMs || now - fromMs > windowMs) {
            windowClosed(!!fromMs);
            return;
          }
          // The punch's own read first (cn-v1201): a hundred metres in the shell. A fix rougher than
          // the phone's anchor limit is "rough", one older than STALE_FIX_MS "stale", an invalid
          // accuracy "rough" (fixWord, the punch's own rule): counted for the trace, never adopted.
          // NEVER WORSE THAN BEFORE: in a shell that reads natively, when that read is not "ok" (and
          // location is not off), ONE read follows at once through getPosition with the same options
          // (a Best read, the read this branch made before cn-v1201), and that one is adopted when
          // ITS word is "ok". In a browser the two are the same read, so nothing follows there.
          const ADOPT_READ: PositionOptions = { enableHighAccuracy: true, timeout: 4_000, maximumAge: 30_000 };
          let r = await getPunchPosition(ADOPT_READ);
          let word = fixWord(r);
          trace("fence fix", r.status === "ok" ? `${word} acc=${Math.round(r.accuracy ?? 0)}` : r.status);
          tallyCheck(tallyRef.current.tally, word, r.status === "ok" ? r.accuracy : null);
          if (hasNativeRead() && word !== "ok" && word !== "denied") {
            if (cancelled || doneRef.current) return;
            r = await getPosition(ADOPT_READ);
            word = fixWord(r);
            trace("fence sharp fix", r.status === "ok" ? `${word} acc=${Math.round(r.accuracy ?? 0)}` : r.status);
            tallyCheck(tallyRef.current.tally, word === "ok" ? "sharpOk" : "sharpMiss", r.status === "ok" ? r.accuracy : null);
          }
          if (cancelled || doneRef.current || r.status !== "ok" || word !== "ok") return;
          const fix = { lat: r.coords.lat, lng: r.coords.lng, accuracy: r.accuracy };
          const res = await adoptGeofenceAnchor(entryId, fix);
          trace("fence adopt", res.ok ? "ok" : res.windowClosed ? "window closed" : "refused");
          if (cancelled) return;
          if (res.ok) {
            setAnchor(fix); // arms the live watch
            leaveTrace("stamped-late");
            // The Time Clock swaps its no-location note for "Location added" (cn-v1201).
            firePunchLocation("added");
          } else if (res.windowClosed) {
            serverClosed = true;
            windowClosed();
          }
          return;
        }

        if (now < snoozedUntil(entryId)) return;
        // One quick capped fix: a browser's own 4 s timeout; in the shell the phone's own timer is
        // 10 s whatever `timeout` says. A sharp read on purpose (NOT the punch's hundred metres,
        // cn-v1201): a rough fix here could raise a false "looks like you left" sheet, and that sheet
        // can close a shift when nobody answers.
        const r = await getPosition({ enableHighAccuracy: true, timeout: 4_000, maximumAge: 30_000 });
        if (cancelled || doneRef.current || phaseRef.current !== "idle") return;
        if (r.status !== "ok") return; // denied/timeout — nothing honest to conclude
        const acc = r.accuracy ?? 0;
        if (acc > Math.max(radiusM, ACCURACY_FLOOR_M)) return; // junk fix proves nothing
        lastFixRef.current = { lat: r.coords.lat, lng: r.coords.lng, accuracy: acc };
        const d = haversineM({ lat: anchorLat, lng: anchorLng }, r.coords);
        if (d <= radiusM + acc) {
          // At the site — feed the live watch's confirmed-inside state.
          seenInsideRef.current = true;
          lastInsideMsRef.current = Date.now();
          firstOutsideMsRef.current = null;
          return;
        }
        openPrompt("wake");
      } finally {
        inFlightStamp = 0;
      }
    };
    checkRef.current = () => void check();

    const onVis = () => {
      if (document.visibilityState === "visible") void check();
    };
    const onFocus = () => void check();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    // Mount IS a wake — iOS discards the suspended page, so reopening the app lands
    // here with fresh state (this is the moment that catches a drove-off shift).
    void check();

    // WHILE THERE IS NO ANCHOR AND ITS WINDOW IS OPEN, THE PHONE IS ASKED AGAIN (cn-v1169; the
    // decision is adoptTick's, pure and tested). A check ran only on a wake, so a first read that
    // came back empty was never repeated for someone who left the app on one page, and a window that
    // then closed went unsaid until the next wake. The timer asks once a throttle's length (never
    // inside a minute of another check), and when the window closes it says so once, through the
    // same gate the check uses (a phone whose location cannot be read has its own line, and a wake
    // is not a gesture), then stops. An anchor that arrives re-runs this effect, which clears it.
    let retry: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      retry = null;
      if (cancelled || doneRef.current || serverClosed) return;
      const w = adoptWindow();
      const next = adoptTick({ nowMs: Date.now(), fromMs: w.fromMs, windowMs: w.windowMs, lastCheckMs: lastWakeCheckRef.current, throttleMs: WAKE_THROTTLE_MS });
      if (next.kind === "stop") return;
      if (next.kind === "closed") {
        void mayReadLocation().then((may) => {
          if (cancelled || doneRef.current) return;
          if (may) windowClosed();
          else gateRefused(); // cn-v1201: the trace is not silent for a phone whose location is off
        });
        return;
      }
      if (next.check) void check();
      retry = setTimeout(tick, next.againInMs);
    };
    if (typeof anchorLat !== "number" || typeof anchorLng !== "number") {
      const w = adoptWindow();
      // The mount check above is this minute's ask, so the first tick only waits.
      const first = adoptTick({ nowMs: Date.now(), fromMs: w.fromMs, windowMs: w.windowMs, lastCheckMs: Date.now(), throttleMs: WAKE_THROTTLE_MS });
      if (first.kind === "wait") retry = setTimeout(tick, first.againInMs);
    }
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      // A check dying mid-fix (effect re-run: remount, anchor arrival, entry change)
      // must give its throttle slot back SYNCHRONOUSLY — before the successor effect
      // runs — or the successor's mount check is silently muted for 60s.
      if (inFlightStamp && lastWakeCheckRef.current === inFlightStamp) lastWakeCheckRef.current = 0;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
    };
  }, [tripKey, anchorLat, anchorLng, radiusM, clockInIso, startedBySwitch, madeAtIso, source]);

  // Route changes are wakes too (throttled inside check).
  useEffect(() => {
    checkRef.current();
  }, [pathname]);

  // The one thing worth saying while nothing else is happening: the net is down.
  // THE FENCE WITH THE SCREEN OFF (field feedback 10-13, item 4; native-geofence.ts). In the shell,
  // iOS watches the same circle while the app is asleep or gone: armed the moment the anchor is
  // known (re-armed for a new trip), disarmed when this monitor goes (clock-out). An exit iOS saw
  // — straight away while the app is awake, or remembered for the next open — opens the SAME
  // sheet, with the observed time filled in for the person to confirm or change: a human still
  // states the time (the payroll boundary), the phone only says when it noticed. Off the shell
  // every door is a no-op, so nothing here changes the web app.
  useEffect(() => {
    if (typeof anchorLat !== "number" || typeof anchorLng !== "number") return;
    let cancelled = false;
    const dark = (r: FenceReadiness | null) => { if (!cancelled) setFenceDark(r === null || r === "ready" ? null : r); };
    void armFence(fenceArmOptions({ entryId, lat: anchorLat, lng: anchorLng, radiusM, label: jobLabel, notify }, t)).then(dark);
    // The phone cleared its copy when the page read this one, so nothing here may just return (carried
    // 1123, #24): exitHandoff says whether it opens the sheet, fills the one that is up, is kept for the next
    // free sheet, or is truly moot.
    const takeExit = (e: PendingExit) => {
      if (keptExitRef.current === e) keptExitRef.current = null;
      const key = `${e.entryId}|${e.exitedAt}`;
      const how = exitHandoff({
        done: doneRef.current,
        ours: e.entryId === entryId && tripKey === tripKeyRef.current,
        snoozed: Date.now() < snoozedUntil(entryId),
        handled: handledExitRef.current === key,
        cancelled,
        exitedAtMs: Date.parse(e.exitedAt),
        insideAtMs: seenInsideRef.current ? lastInsideMsRef.current : 0,
        phase: phaseRef.current,
        armed: fallbackArmed({
          phase: phaseRef.current,
          longPrompt: longPromptRef.current,
          picked: pickedIsoRef.current != null,
          source: promptSourceRef.current,
          lastInsideMs: lastInsideMsRef.current,
          streamGap: streamGapRef.current,
        }),
      });
      if (how === "drop") return;
      if (how === "keep") {
        keptExitRef.current = e;
        if (cancelled) takeKeptRef.current(); // the effect that replaced this one takes it up
        return;
      }
      handledExitRef.current = key;
      // `notify`: the shell's "Still on the clock?" rang for this exit (or one within the half hour), so the
      // server's "Clock out?" must not ring it twice (#43).
      if (how === "open") openPrompt("wake", notify);
      const ms = Date.parse(e.exitedAt);
      if (Number.isFinite(ms) && ms <= Date.now()) {
        setPickedIso(new Date(ms).toISOString());
        setPhase("picking");
      }
    };
    takeKeptRef.current = () => { const k = keptExitRef.current; if (k) takeExit(k); };
    takeKeptRef.current(); // an exit the last effect read and could not place
    void takePendingExit(t("gf_theJobSite")).then((e) => { if (e) takeExit(e); });
    let stop: () => void = () => {};
    // A listener that arrives after this effect was torn down must not be left listening.
    void onFenceExit(takeExit, t("gf_theJobSite")).then((s) => { if (cancelled) s(); else stop = s; });
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      void takePendingExit(t("gf_theJobSite")).then((e) => { if (e) takeExit(e); });
      void fenceReadiness().then(dark); // the Always prompt may have been answered while we were away
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis); // an in-app permission alert dismissed fires no visibility change
    const settled = setTimeout(() => { if (!cancelled) void fenceReadiness().then(dark); }, 8000); // the Always prompt, answered
    return () => {
      cancelled = true;
      takeKeptRef.current = () => {};
      stop();
      clearTimeout(settled);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripKey, anchorLat, anchorLng, radiusM, lang]);
  // A sheet that closes (he came back inside, or answered) frees the place a kept exit was waiting for.
  useEffect(() => {
    if (phase === "idle") takeKeptRef.current();
  }, [phase]);
  // Clock-out unmounts the monitor (the layout renders it only while an entry is open): the
  // region goes with it.
  useEffect(() => () => { void disarmFence(); }, []);

  if (phase === "idle")
    return (
      <div className={IDLE_STRIP}>
        <GeofenceIdleLine
          watchOff={watchOff}
          waitingGrant={waitingGrant}
          grantBusy={grantBusy}
          grantNote={grantNote}
          fenceDark={fenceDark}
          anchorLost={anchorLost && !lostSeen}
          anchorKnown={typeof anchorLat === "number"}
          jobLabel={jobLabel}
          onTurnOn={turnOnLocation}
          canOpenSettings={canSettings}
          onOpenSettings={() => void openLocationSettings()}
          onGotIt={() => {
            markLostSeen(entryId);
            setLostSeen(true);
          }}
        />
      </div>
    );

  const closedTime = closedAt ? splitClock(closedAt, tz) : "";
  const pickedMs = pickedIso ? Date.parse(pickedIso) : null;
  const ciMs = Date.parse(clockInIso);
  const longShift = longPromptRef.current || isLongOpenShift(shiftStartRef.current, Date.now());
  // The 18-hour ceiling rides the shared window (lib/long-shift). On a long shift an untouched
  // picker is NOT a valid answer: it would mean "now".
  const pickWin = Number.isFinite(ciMs) ? stopWindow(ciMs, Date.now()) : null;
  const pickedValid =
    pickedMs == null
      ? !longShift
      : !isNaN(pickedMs) &&
        (pickWin ? pickedMs >= pickWin.minMs && pickedMs <= pickWin.maxMs : true) &&
        pickedMs <= Date.now() + 60_000;

  // Non-blocking sheet (NOT a Modal — nothing behind it is disabled): floats above the
  // bottom nav like a toast, below the toast channel itself.
  // UNDER a sheet, never over it (2026-09-16): the Modal sits at z-[120]. At z-[130] this card
  // landed on top of an open Add Cost sheet's Save and Cancel while the person was off-site at
  // the supply house. It waits behind the sheet and is there the moment it closes.
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[110] shell:inset-x-auto shell:bottom-6 shell:right-6 shell:w-96"
    >
      <div className="rounded-2xl border border-amber-300 bg-white p-4 shadow-xl">
        {phase === "confirmed" ? (
          <div className="flex items-start gap-2">
            <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <div className="text-sm">
              <div className="font-semibold text-slate-900">
                {fillText(t("gf_clockedOutAtYouLeft"), { time: closedTime, label: jobLabel })}
              </div>
              {/* /timeclock asks only about lunch now (audit v994 SI8). A geofence close is always
                  auto_gps and unanswered, so the prompt there is pending whenever this shows. */}
              <Link href="/timeclock" className="mt-0.5 inline-block font-medium text-brand hover:underline">
                {t("gf_finishYourTimecard")}
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <div className="text-sm">
                <div className="font-semibold text-slate-900">
                  {fillText(t("gf_looksLikeYouLeftClockOut"), { label: jobLabel })}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{t("gf_stillOnClockPickTime")}</div>
                {/* SAY WHAT HAPPENS IF HE SAYS NOTHING (audit 6).
                    The sheet asks a question and then, five minutes later, answers it for him at
                    a time he was never shown. Naming it is what makes a wrong one catchable by
                    the one person who can catch it — and he is usually driving, so it has to be
                    on screen rather than discovered on Friday's timecard. Rendered only when the
                    fallback can actually fire; a wake prompt waits for a human indefinitely. */}
                {autoAtLabel && (
                  <div className="mt-1 text-xs font-medium text-amber-700">
                    {fillText(t(phase === "picking" ? "gf_noAnswer5MinPicking" : "gf_noAnswerClockOutAt"), { at: autoAtLabel })}
                  </div>
                )}
              </div>
            </div>

            {phase === "picking" && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                {/* Free pick is payroll-safe here: a backdated clock-OUT can only reduce
                    hours, and the server clamps it to [clock-in, now]. */}
                <ClockStartPicker
                  startExpanded
                  fieldLabel="Stop"
                  /* A long shift starts the picker on the clock-in's day and time, so a man who
                     forgot yesterday is not handed today as the answer. An exit iOS observed is
                     already the picked time when the picker mounts: the fields show what will be saved. */
                  initialIso={pickedIso ?? (longShift ? clockInIso : undefined)}
                  tz={tz}
                  /* A long shift's picker starts at the clock-in, which is not a stop time anybody
                     chose, so it never says "the time above" until he has picked one (SI7). */
                  caption={longShift && pickedIso == null ? t("gf_pickWhenYouLeft") : t("gf_clockingOutAtTimeAbove")}
                  onChange={setPickedIso}
                />
              </div>
            )}

            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            {phase === "picking" && !pickedValid && (
              <p className="mt-2 text-xs text-amber-600">{pickWithinCeiling(lang)}</p>
            )}

            <div className="mt-3 space-y-2">
              {phase === "picking" ? (
                <>
                  <Button className="w-full" disabled={!pickedValid} onClick={clockOutPicked}>
                    {t("tc_clockOutAtThatTime")}
                  </Button>
                  <div className="flex gap-2">
                    {/* Back leads to Clock Out Now, which a long shift does not offer. */}
                    {!longShift && (
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => {
                          setPickedIso(null);
                          setError(null);
                          setPhase("prompt");
                        }}
                      >
                        {t("gf_back")}
                      </Button>
                    )}
                    <Button variant="ghost" className="flex-1" onClick={stillWorking}>
                      {t("gf_stillWorking")}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {phase === "saving" ? (
                    <Button className="w-full" disabled>
                      <Loader2 className="h-4 w-4 animate-spin" /> {t("tc_clockingOut")}
                    </Button>
                  ) : (
                    !longShift && (
                      <Button className="w-full" onClick={clockOutNow}>
                        {t("gf_clockOutNow")}
                      </Button>
                    )
                  )}
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      disabled={phase === "saving"}
                      onClick={() => {
                        setError(null);
                        setPickedIso(null);
                        setPhase("picking");
                      }}
                    >
                      {t("gf_pickTheTime")}
                    </Button>
                    <Button variant="ghost" className="flex-1" disabled={phase === "saving"} onClick={stillWorking}>
                      {t("gf_stillWorking")}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
