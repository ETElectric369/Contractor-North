"use client";

import { useCallback, useEffect, useState } from "react";
import { Cloud, MapPin } from "lucide-react";
import { loadGoogleMaps } from "@/lib/google-maps";
import { getPosition, type GeoCoords } from "@/lib/geo";

interface WeatherData {
  tempF: number;
  feelsF: number;
  description: string;
  iconUri: string;
  humidity?: number;
  windMph?: number;
}

// Where the displayed weather is FOR — drives the label honestly:
//  fresh  = a real device GPS fix this session ("Your location")
//  approx = a recent cached device fix, possibly stale ("Approx · 12m ago")
//  org    = the shop's configured city; GPS off/denied/unavailable ("Location off")
type LocSource = { kind: "fresh" } | { kind: "approx"; ageMin: number } | { kind: "org" };

// Org-city geocode cache — SEPARATE key from the device-GPS cache, and it can NEVER count as
// "the user's location" (that mislabeling was the bug). Just saves a geocoder round-trip.
function readCityCache(loc: string): GeoCoords | null {
  try {
    const raw = localStorage.getItem(`geocity:${loc}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeCityCache(loc: string, c: GeoCoords) {
  try {
    localStorage.setItem(`geocity:${loc}`, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

// Last good DEVICE-GPS fix, with its age. We still cache it (a single flaky miss shouldn't blank the
// card), but it's labeled "approx" with its age — never passed off as a current "Your location" fix.
function writeGps(c: GeoCoords) {
  try {
    localStorage.setItem("gps:last", JSON.stringify({ ...c, ts: Date.now() }));
  } catch {
    /* ignore */
  }
}
function readGps(): { coords: GeoCoords; ageMin: number } | null {
  try {
    const raw = localStorage.getItem("gps:last");
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.lat !== "number" || typeof v?.lng !== "number" || typeof v?.ts !== "number") return null;
    return { coords: { lat: v.lat, lng: v.lng }, ageMin: Math.round((Date.now() - v.ts) / 60_000) };
  } catch {
    return null;
  }
}

// A cached fix older than this is too stale to even show as "approx" — fall to the org city.
const MAX_APPROX_MIN = 90;

/**
 * Current-conditions weather for WHERE THE USER IS (device GPS), labeled honestly: a fresh fix says
 * "Your location"; a recent cached fix says "approx, Nm ago"; GPS off/denied says "Location off" and
 * shows the shop's city. The "Use my location" tap (an in-gesture geolocation call, which iOS PWAs
 * honor) is ALWAYS available until we have a fresh fix. Renders nothing when no key / no location.
 */
export function WeatherWidget({ location, label }: { location: string | null; label?: string }) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [data, setData] = useState<WeatherData | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [src, setSrc] = useState<LocSource | null>(null);

  // Fetch current conditions for a known lat/lng. Returns false on failure (incl. a 200 with no
  // temperature in the body — we must NOT fabricate a real-looking "0°F" from a partial response).
  const fetchWeatherFor = useCallback(
    async (coords: GeoCoords): Promise<boolean> => {
      if (!key) return false;
      try {
        const url =
          `https://weather.googleapis.com/v1/currentConditions:lookup?key=${key}` +
          `&location.latitude=${coords.lat}&location.longitude=${coords.lng}&unitsSystem=IMPERIAL`;
        const r = await fetch(url);
        if (!r.ok) return false;
        const w = await r.json();
        const temp = w.temperature?.degrees;
        if (typeof temp !== "number") return false; // partial/empty body — don't show a fake 0°F
        setData({
          tempF: Math.round(temp),
          feelsF: Math.round(w.feelsLikeTemperature?.degrees ?? temp),
          description: w.weatherCondition?.description?.text ?? "—",
          iconUri: w.weatherCondition?.iconBaseUri ? `${w.weatherCondition.iconBaseUri}.png` : "",
          humidity: w.relativeHumidity,
          windMph: w.wind?.speed?.value != null ? Math.round(w.wind.speed.value) : undefined,
        });
        setStatus("ok");
        return true;
      } catch {
        return false;
      }
    },
    [key],
  );

  // Explicit "use my location" tap. iOS home-screen PWAs frequently ignore the on-mount geolocation
  // call (no gesture, separate permission scope) but honor one made directly from a tap — so this is
  // the reliable recovery out of "showing the shop's city".
  const locate = useCallback(async () => {
    const res = await getPosition();
    if (res.status !== "ok") return; // denied/timeout/unavailable → leave the org city + the button up
    writeGps(res.coords);
    setSrc({ kind: "fresh" });
    setStatus("loading");
    await fetchWeatherFor(res.coords);
  }, [fetchWeatherFor]);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    (async () => {
      // 1) Try a real device fix first — the crew isn't always at the shop.
      const res = await getPosition();
      if (cancelled) return;
      if (res.status === "ok") {
        writeGps(res.coords);
        setSrc({ kind: "fresh" });
        if (!(await fetchWeatherFor(res.coords)) && !cancelled) setStatus("error");
        return;
      }
      // 2) A RECENT cached device fix beats the shop's city — but it's labeled "approx", never "Your
      //    location", and the recovery button stays up so a stale fix can always be refreshed.
      const last = readGps();
      if (last && last.ageMin <= MAX_APPROX_MIN) {
        setSrc({ kind: "approx", ageMin: last.ageMin });
        if (!(await fetchWeatherFor(last.coords)) && !cancelled) setStatus("error");
        return;
      }
      // 3) No usable device location → the org's configured city, labeled "Location off".
      if (location) {
        let coords = readCityCache(location);
        if (!coords) {
          try {
            await loadGoogleMaps(key);
            const g = (window as any).google;
            const geocoder = new g.maps.Geocoder();
            const r = await geocoder.geocode({ address: location });
            const loc = r.results?.[0]?.geometry?.location;
            if (loc) {
              coords = { lat: loc.lat(), lng: loc.lng() };
              writeCityCache(location, coords);
            }
          } catch {
            /* fall through to error */
          }
        }
        if (coords) {
          setSrc({ kind: "org" });
          if (!(await fetchWeatherFor(coords)) && !cancelled) setStatus("error");
          return;
        }
      }
      if (!cancelled) setStatus("error");
    })();
    return () => {
      cancelled = true;
    };
  }, [key, location, fetchWeatherFor]);

  // Not configured / nothing to show → render nothing (keeps the dashboard clean).
  if (!key || status === "error") return null;

  const fresh = src?.kind === "fresh";

  return (
    <div className="mb-4 flex items-center gap-4 rounded-xl border border-sky-100 bg-gradient-to-br from-sky-50 to-white px-5 py-4">
      {data?.iconUri ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={data.iconUri} alt={data.description} className="h-12 w-12" />
      ) : (
        <Cloud className="h-10 w-10 text-sky-400" />
      )}
      <div className="flex-1">
        {status === "loading" || !data ? (
          <div className="text-sm text-slate-400">Loading weather…</div>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-900">{data.tempF}°F</span>
              <span className="text-sm text-slate-600">{data.description}</span>
            </div>
            <div className="text-xs text-slate-500">
              Feels like {data.feelsF}°
              {data.windMph != null ? ` · Wind ${data.windMph} mph` : ""}
              {data.humidity != null ? ` · Humidity ${data.humidity}%` : ""}
              {" · "}
              {fresh ? (
                <span className="text-emerald-600">Your location</span>
              ) : (
                <>
                  {/* Honest about WHY it's not your live location, and always offer the one-tap fix
                      (an in-gesture geolocation call, which iOS PWAs honor when the on-mount call was
                      ignored). */}
                  {src?.kind === "approx"
                    ? `Approx · ${src.ageMin}m ago · `
                    : `${label ? `${label} · ` : ""}Location off · `}
                  <button
                    type="button"
                    onClick={locate}
                    className="inline-flex items-center gap-0.5 font-medium text-sky-600 hover:text-sky-700"
                  >
                    <MapPin className="h-3 w-3" /> Use my location
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
