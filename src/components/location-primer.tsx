"use client";

import { useEffect, useState } from "react";
import { MapPin, X } from "lucide-react";
import { getPosition, geoPermission } from "@/lib/geo";

const DISMISS_KEY = "loc-primer-dismissed";

/**
 * ONE app-wide location request. Location isn't just for weather — it's GPS clock-in, job-site auto
 * clock-out (geofence), and mileage. So instead of each feature lazily prompting (and the weather card
 * silently falling back), this asks ONCE on My Day, with context, so everyone approves it up front and
 * the whole app then defaults to "your location". iOS only shows the permission prompt inside a tap, so
 * this is a banner with an Enable button (not an on-mount auto-request). Granting fires
 * `cn:location-granted` so the weather card refreshes to the device's location immediately.
 */
export function LocationPrimer() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (localStorage.getItem(DISMISS_KEY)) return; // they said no thanks — don't nag
      } catch {
        /* ignore */
      }
      const perm = await geoPermission();
      if (cancelled) return;
      if (perm === "granted") return; // already approved → everything already defaults to your location
      setShow(true); // "prompt" / "denied" / "unknown" → offer the one-tap enable
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setBusy(true);
    setErr(null);
    // In-gesture (this onClick) → iOS shows the permission prompt. Low accuracy = a fast cell/wifi fix.
    const res = await getPosition({ enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
    setBusy(false);
    if (res.status === "ok") {
      try {
        localStorage.setItem("gps:last", JSON.stringify({ ...res.coords, ts: Date.now() }));
      } catch {
        /* ignore */
      }
      window.dispatchEvent(new Event("cn:location-granted")); // weather card + anything listening refreshes
      setShow(false);
      return;
    }
    setErr(
      res.status === "denied"
        ? "Location is off for North. Turn it on in Settings → Privacy & Security → Location → North (allow “While Using”), then tap again."
        : res.status === "insecure"
          ? "Location needs a secure (https) connection."
          : "Couldn’t get a location fix — tap to try again.",
    );
  }

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event("cn:location-dismissed")); // weather card takes over its own prompt
    setShow(false);
  }

  if (!show) return null;

  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
      <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-sky-600" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-800">Turn on location</div>
        <div className="mt-0.5 text-xs text-slate-600">
          North uses your location for live weather, GPS clock‑in, and job‑site auto clock‑out. Approve it
          once and it works everywhere.
        </div>
        {err && <div className="mt-1 text-xs text-amber-700">{err}</div>}
        <button
          onClick={enable}
          disabled={busy}
          className="mt-2 inline-flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-60"
        >
          <MapPin className="h-3.5 w-3.5" /> {busy ? "Getting location…" : "Enable location"}
        </button>
      </div>
      <button onClick={dismiss} aria-label="Dismiss" className="rounded p-1 text-slate-400 hover:bg-sky-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
