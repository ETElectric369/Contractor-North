"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { geoClockOut } from "@/app/(app)/timeclock/actions";
import { speakSmart } from "@/lib/tts";
import { watchPosition } from "@/lib/geo";
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

/**
 * Global geofence watcher (mounted in the app shell only while the user is clocked
 * in). Compares the live GPS to where they CLOCKED IN; if they move beyond the radius
 * and stay out past the grace window, it clocks them out — at the time they were last
 * at the site (so a forgotten clock-out never over-bills). It only fires after it has
 * confirmed them AT the site this session, so a bad first fix or a reopen-from-afar
 * never guesses a clock-out time.
 *
 * PWA limit: web geolocation runs while the app is foregrounded; backgrounded it
 * resumes on reopen. (A true background geofence needs the native app — later track.)
 */
export function GeofenceMonitor({
  entryId,
  gpsIn,
  clockInIso,
  radiusM,
  graceMin = 4,
}: {
  entryId: string;
  gpsIn: GeoPoint;
  clockInIso: string;
  radiusM: number;
  graceMin?: number;
}) {
  const router = useRouter();
  const doneRef = useRef(false);
  // Depend on the PRIMITIVE lat/lng, not the gpsIn object — the layout re-renders on
  // every navigation and hands us a fresh object ref, which would otherwise tear down
  // the watch + reset the grace/seen-inside state on every page change.
  const lat = gpsIn?.lat;
  const lng = gpsIn?.lng;

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    if (typeof lat !== "number" || typeof lng !== "number") return;
    const center = { lat, lng };
    doneRef.current = false;
    let seenInside = false;
    let lastInsideMs = clockInIso ? Date.parse(clockInIso) || Date.now() : Date.now();
    let firstOutsideMs: number | null = null;
    const graceMs = Math.max(60_000, graceMin * 60_000);
    // A fix fuzzier than this tells us nothing — it neither confirms "inside" nor
    // triggers a clock-out, so a junk reading can't false-fire.
    const ignoreAccuracy = Math.max(radiusM, 200);

    const onFix = (fix: { coords: { lat: number; lng: number }; accuracy: number }) => {
      if (doneRef.current) return;
      const acc = fix.accuracy || 0;
      if (acc > ignoreAccuracy) return;
      const here = fix.coords;
      const d = haversineM(center, here);
      const now = Date.now();
      // Pad the radius by the fix's uncertainty so a fuzzy-but-usable fix can't trip it.
      if (d <= radiusM + acc) {
        seenInside = true;
        lastInsideMs = now;
        firstOutsideMs = null;
        return;
      }
      if (!seenInside) return; // never confirmed at the site this session — don't guess
      if (firstOutsideMs == null) firstOutsideMs = now;
      if (now - firstOutsideMs >= graceMs) {
        doneRef.current = true;
        geoClockOut(here, new Date(lastInsideMs).toISOString()).then((res) => {
          if (!res.ok) {
            // "Not clocked in" → already closed elsewhere; terminal. Anything else is
            // transient: re-arm, but make the grace window re-elapse before retrying
            // (no per-fix retry storm).
            if (!/not clocked in/i.test(res.error ?? "")) {
              doneRef.current = false;
              firstOutsideMs = now;
            }
            return;
          }
          try {
            speakSmart("Clocked out — you left the job site.");
          } catch {}
          try {
            navigator.vibrate?.([60, 40, 60]);
          } catch {}
          // Push the "answer the clock-out questions" prompt — works while the page is
          // alive even if backgrounded. If notifications aren't granted, the in-app
          // banner on /timeclock catches them when they reopen. (SMS is a future add,
          // pending Twilio provisioning.)
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
          router.refresh();
        });
      }
    };

    return watchPosition(
      onFix,
      (s) => {
        // Don't swallow: a watch that never arms (GPS off / permission revoked mid-shift) means the
        // auto clock-out silently can't track movement. Surface it so it's diagnosable, not mysterious.
        console.warn(`[geofence] location watch error: ${s} — auto clock-out can't track movement`);
      },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 60_000 },
    );
  }, [entryId, lat, lng, radiusM, clockInIso, graceMin, router]);

  return null;
}
