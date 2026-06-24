"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { geoClockOut } from "@/app/(app)/timeclock/actions";
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

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation || !gpsIn) return;
    if (typeof gpsIn.lat !== "number" || typeof gpsIn.lng !== "number") return;
    doneRef.current = false;
    let seenInside = false;
    let lastInsideMs = clockInIso ? Date.parse(clockInIso) || Date.now() : Date.now();
    let firstOutsideMs: number | null = null;
    const graceMs = Math.max(60_000, graceMin * 60_000);

    const onPos = (pos: GeolocationPosition) => {
      if (doneRef.current) return;
      const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      // Pad the radius by the fix's own uncertainty so a fuzzy GPS reading can't
      // false-trigger a clock-out.
      const margin = Math.min(pos.coords.accuracy || 0, 150);
      const d = haversineM(gpsIn, here);
      const now = Date.now();
      if (d <= radiusM + margin) {
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
            doneRef.current = false; // let it retry on the next reading
            return;
          }
          try {
            window.speechSynthesis?.speak(new SpeechSynthesisUtterance("Clocked out — you left the job site."));
          } catch {}
          try {
            navigator.vibrate?.([60, 40, 60]);
          } catch {}
          router.refresh();
        });
      }
    };

    const id = navigator.geolocation.watchPosition(onPos, () => {}, {
      enableHighAccuracy: true,
      maximumAge: 30_000,
      timeout: 60_000,
    });
    return () => navigator.geolocation.clearWatch(id);
  }, [entryId, gpsIn, gpsIn?.lat, gpsIn?.lng, radiusM, clockInIso, graceMin, router]);

  return null;
}
