"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Loader2, MapPin } from "lucide-react";
import { adoptGeofenceAnchor, geoClockOut } from "@/app/(app)/timeclock/actions";
import { ClockStartPicker } from "@/app/(app)/timeclock/clock-start-picker";
import { Button } from "@/components/ui/button";
import { speakSmart } from "@/lib/tts";
import { geoPermission, getPosition, watchPosition } from "@/lib/geo";
import type { GeoPoint } from "@/lib/types";

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
// How long after clock-in a missing anchor may still be adopted from a live fix — long
// enough for "punched from My Day, opened the app at the site", short enough that a
// reopen-from-home can never become "where the job is".
const ADOPT_WINDOW_MS = 15 * 60_000;
// Wake-time exit checks (visibility/focus/route) run at most this often.
const WAKE_THROTTLE_MS = 60_000;
// The live-watch prompt sat unanswered this long, with GPS STILL outside → close the
// entry at the last GPS-observed at-site time (the pre-existing auto_gps behavior, now
// always preceded by a visible prompt).
const AUTO_FALLBACK_MS = 5 * 60_000;

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

type Phase = "idle" | "prompt" | "picking" | "saving" | "confirmed";

/**
 * Global geofence watcher (mounted in the app shell while the user is clocked in).
 * Layered, honest-within-web-physics design — an iOS PWA gets NO background
 * geolocation, so everything here runs while the app is foregrounded:
 *
 *  1. ANCHOR — the entry's clock-in GPS. When clock-in couldn't capture one (My Day /
 *     job-page punches, a punch that outran the iOS permission dialog), the first good
 *     fix within 15 min of clock-in is adopted and persisted (adoptGeofenceAnchor), so
 *     the fence works for EVERY clock-in surface, not just the GPS-stamped one.
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
  radiusM,
  graceMin = 4,
  jobLabel = "the job site",
}: {
  entryId: string;
  gpsIn: GeoPoint | null;
  clockInIso: string;
  radiusM: number;
  graceMin?: number;
  jobLabel?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  // ── one shared truth for both detection paths + the sheet's handlers ──────────
  const doneRef = useRef(false);
  const seenInsideRef = useRef(false);
  const lastInsideMsRef = useRef(0);
  const firstOutsideMsRef = useRef<number | null>(null);
  const lastFixRef = useRef<GeoPoint | null>(null); // stamps gps_out on close
  const promptShownAtRef = useRef(0);
  const promptSourceRef = useRef<"live" | "wake">("wake");
  const lastWakeCheckRef = useRef(0);

  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [pickedIso, setPickedIso] = useState<string | null>(null);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The fence anchor. Depend on PRIMITIVE lat/lng everywhere — the layout re-renders on
  // every navigation and hands us a fresh gpsIn object ref, which would otherwise tear
  // down the watch + reset the seen-inside state on every page change.
  const [anchor, setAnchor] = useState<GeoPoint | null>(gpsIn ?? null);
  const anchorLat = anchor?.lat;
  const anchorLng = anchor?.lng;
  const propLat = gpsIn?.lat;
  const propLng = gpsIn?.lng;
  useEffect(() => {
    if (typeof propLat === "number" && typeof propLng === "number") {
      setAnchor({ lat: propLat, lng: propLng });
    }
  }, [entryId, propLat, propLng]);

  // Fresh entry ⇒ fresh trip state (the monitor can survive a clock-out → clock-in
  // cycle without unmounting if renders batch).
  useEffect(() => {
    doneRef.current = false;
    seenInsideRef.current = false;
    lastInsideMsRef.current = clockInIso ? Date.parse(clockInIso) || Date.now() : Date.now();
    firstOutsideMsRef.current = null;
    promptShownAtRef.current = 0;
    setPhase("idle");
    setError(null);
    setClosedAt(null);
  }, [entryId, clockInIso]);

  // Opens the sheet. Only touches refs + stable setters, so a stale closure is harmless.
  function openPrompt(source: "live" | "wake") {
    promptSourceRef.current = source;
    promptShownAtRef.current = Date.now();
    setPickedIso(null);
    setError(null);
    setPhase("prompt");
    try {
      navigator.vibrate?.(40);
    } catch {}
  }

  // The one write path for every close. `atIso` is now / the user's pick / the
  // observed last-at-site time — see the component doc.
  function submit(gps: GeoPoint | null, atIso: string, auto = false) {
    setError(null);
    setPhase("saving");
    geoClockOut(gps, atIso)
      .then((res) => {
        if (!res.ok) {
          if (/not clocked in/i.test(res.error ?? "")) {
            // Already closed elsewhere (the panel, the office) — terminal; sync the UI.
            doneRef.current = true;
            setPhase("idle");
            router.refresh();
            return;
          }
          setError(res.error ?? "Could not clock out — try again.");
          setPhase("prompt");
          return;
        }
        doneRef.current = true;
        setClosedAt(atIso);
        setPhase("confirmed");
        try {
          navigator.vibrate?.([60, 40, 60]);
        } catch {}
        if (auto) {
          try {
            speakSmart("Clocked out — you left the job site.");
          } catch {}
          // Works while the page is alive even if it was just backgrounded; if
          // notifications aren't granted, the in-app banner on /timeclock catches them.
          try {
            if ("Notification" in window && Notification.permission === "granted") {
              const n = new Notification("Clocked out — you left the job site", {
                body: "Tap to log which job codes you worked today.",
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
        setError("No connection — your shift is untouched, try again.");
        setPhase("prompt");
      });
  }

  function clockOutNow() {
    submit(lastFixRef.current, new Date().toISOString());
  }

  function clockOutPicked() {
    const iso = pickedIso ?? new Date().toISOString(); // picker's "Use now" ⇒ now
    const ms = Date.parse(iso);
    const ci = Date.parse(clockInIso);
    if (isNaN(ms) || (!isNaN(ci) && ms < ci) || ms > Date.now() + 60_000) {
      setError("Pick a time between clock-in and now.");
      return;
    }
    submit(lastFixRef.current, iso);
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
      // Pad the radius by the fix's uncertainty so a fuzzy-but-usable fix can't trip it.
      if (d <= radiusM + acc) {
        seenInsideRef.current = true;
        lastInsideMsRef.current = now;
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
        phaseRef.current === "prompt" &&
        promptSourceRef.current === "live" &&
        promptShownAtRef.current > 0 &&
        now - promptShownAtRef.current >= AUTO_FALLBACK_MS
      ) {
        submit(lastFixRef.current, new Date(lastInsideMsRef.current).toISOString(), true);
      }
    };
    const onErr = (s: string) => {
      // Don't swallow: a watch that never arms (GPS off / permission revoked mid-shift)
      // means the fence can't track movement. The wake check still runs its own fixes.
      console.warn(`[geofence] location watch error: ${s} — live exit tracking degraded`);
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
      if ((await geoPermission()) !== "granted") {
        if (!warnedGate) {
          warnedGate = true;
          console.warn("[geofence] location not granted yet — live exit tracking waits for the first granted fix");
        }
        return;
      }
      if (disposed || doneRef.current) return;
      stop();
      stop = watchPosition(onFix, onErr, opts);
    };
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
      document.removeEventListener("visibilitychange", rearm);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, anchorLat, anchorLng, radiusM, graceMin]);

  // ── 1 + 3. WAKE EXIT-CHECK (and anchor adoption) ───────────────────────────────
  // Kept in a ref so the route-change effect below always calls the CURRENT check.
  const checkRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    let inFlightStamp = 0; // this effect's not-yet-finished check's throttle stamp

    const check = async () => {
      if (cancelled || doneRef.current) return;
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
        if ((await geoPermission()) !== "granted") {
          if (lastWakeCheckRef.current === now) lastWakeCheckRef.current = 0;
          return;
        }
        if (cancelled || doneRef.current || phaseRef.current !== "idle") return;
        // No anchor (clock-in couldn't capture GPS) → adopt one from a good fix, but
        // only near clock-in. Past the window the fence stays honestly quiet for this
        // shift — the evening sweep still flags a forgotten entry.
        if (typeof anchorLat !== "number" || typeof anchorLng !== "number") {
          const ciMs = Date.parse(clockInIso);
          if (isNaN(ciMs) || now - ciMs > ADOPT_WINDOW_MS) return;
          const r = await getPosition({ enableHighAccuracy: true, timeout: 4_000, maximumAge: 30_000 });
          if (cancelled || doneRef.current || r.status !== "ok" || (r.accuracy ?? 0) > 150) return;
          const fix = { lat: r.coords.lat, lng: r.coords.lng, accuracy: r.accuracy };
          const res = await adoptGeofenceAnchor(entryId, fix);
          if (!cancelled && res.ok) setAnchor(fix); // arms the live watch
          return;
        }

        if (now < snoozedUntil(entryId)) return;
        // One quick capped fix — never hangs the wake past ~4s.
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
    return () => {
      cancelled = true;
      // A check dying mid-fix (effect re-run: remount, anchor arrival, entry change)
      // must give its throttle slot back SYNCHRONOUSLY — before the successor effect
      // runs — or the successor's mount check is silently muted for 60s.
      if (inFlightStamp && lastWakeCheckRef.current === inFlightStamp) lastWakeCheckRef.current = 0;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
    };
  }, [entryId, anchorLat, anchorLng, radiusM, clockInIso]);

  // Route changes are wakes too (throttled inside check).
  useEffect(() => {
    checkRef.current();
  }, [pathname]);

  if (phase === "idle") return null;

  const closedTime = closedAt
    ? new Date(closedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";
  const pickedMs = pickedIso ? Date.parse(pickedIso) : null;
  const ciMs = Date.parse(clockInIso);
  const pickedValid =
    pickedMs == null ||
    (!isNaN(pickedMs) && (isNaN(ciMs) || pickedMs >= ciMs) && pickedMs <= Date.now() + 60_000);

  // Non-blocking sheet (NOT a Modal — nothing behind it is disabled): floats above the
  // bottom nav like a toast, below the toast channel itself.
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[130] lg:inset-x-auto lg:bottom-6 lg:right-6 lg:w-96"
    >
      <div className="rounded-2xl border border-amber-300 bg-white p-4 shadow-xl">
        {phase === "confirmed" ? (
          <div className="flex items-start gap-2">
            <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <div className="text-sm">
              <div className="font-semibold text-slate-900">
                Clocked out at {closedTime} — you left {jobLabel}.
              </div>
              <Link href="/timeclock" className="mt-0.5 inline-block font-medium text-brand hover:underline">
                Add your job codes →
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <div className="text-sm">
                <div className="font-semibold text-slate-900">
                  Looks like you left {jobLabel}. Clock out?
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  You&apos;re still on the clock. Left a while ago with the app closed? Pick the
                  time you actually left.
                </div>
              </div>
            </div>

            {phase === "picking" && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                {/* Free pick is payroll-safe here: a backdated clock-OUT can only reduce
                    hours, and the server clamps it to [clock-in, now]. */}
                <ClockStartPicker
                  startExpanded
                  caption="Clocking out at the time above — pick when you actually left."
                  onChange={setPickedIso}
                />
              </div>
            )}

            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            {phase === "picking" && !pickedValid && (
              <p className="mt-2 text-xs text-amber-600">Pick a time between clock-in and now.</p>
            )}

            <div className="mt-3 space-y-2">
              {phase === "picking" ? (
                <>
                  <Button className="w-full" disabled={!pickedValid} onClick={clockOutPicked}>
                    Clock out at that time
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => {
                        setPickedIso(null);
                        setError(null);
                        setPhase("prompt");
                      }}
                    >
                      Back
                    </Button>
                    <Button variant="ghost" className="flex-1" onClick={stillWorking}>
                      Still working
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <Button className="w-full" disabled={phase === "saving"} onClick={clockOutNow}>
                    {phase === "saving" ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Clocking out…
                      </>
                    ) : (
                      "Clock out now"
                    )}
                  </Button>
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
                      Pick the time…
                    </Button>
                    <Button variant="ghost" className="flex-1" disabled={phase === "saving"} onClick={stillWorking}>
                      Still working
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
