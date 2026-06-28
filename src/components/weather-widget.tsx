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

// A recent device fix (this fresh, weather a few miles/minutes off doesn't matter) is reused so we
// don't re-prompt GPS on every page load — but it's still YOUR location, never the shop's.
const DEVICE_CACHE_MIN = 30;

// Org-address geocode cache — only ever used in "business" mode, so it can never masquerade as the
// user's location. Just saves a geocoder round-trip.
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
function writeDeviceFix(c: GeoCoords) {
  try {
    localStorage.setItem("gps:last", JSON.stringify({ ...c, ts: Date.now() }));
  } catch {
    /* ignore */
  }
}
function readDeviceFix(): GeoCoords | null {
  try {
    const raw = localStorage.getItem("gps:last");
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.lat !== "number" || typeof v?.lng !== "number" || typeof v?.ts !== "number") return null;
    if (Date.now() - v.ts > DEVICE_CACHE_MIN * 60_000) return null;
    return { lat: v.lat, lng: v.lng };
  } catch {
    return null;
  }
}

/**
 * Current-conditions weather. The location is an EXPLICIT choice (org setting `weather_source`), never a
 * silent guess:
 *   - "device"  → where THIS user is (GPS). If location is off it shows a "turn on location" prompt — it
 *                 NEVER falls back to the shop's city pretending to be you (that mask was the root bug).
 *   - "business" → the org's configured address, always (no GPS prompt).
 * Renders nothing when there's no key, or (device mode) a compact "enable location" card when GPS is off.
 */
export function WeatherWidget({
  location,
  label,
  source = "device",
}: {
  location: string | null;
  label?: string;
  source?: "device" | "business";
}) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [data, setData] = useState<WeatherData | null>(null);
  // "needloc" = device mode, no usable fix → show the enable-location prompt (NOT the shop's weather).
  const [status, setStatus] = useState<"loading" | "ok" | "error" | "needloc">("loading");
  const [locating, setLocating] = useState(false); // a tap is in flight
  const [locErr, setLocErr] = useState<string | null>(null); // why the last location attempt failed

  // Fetch current conditions. Returns false on failure incl. a 200 with no temperature (don't fabricate 0°F).
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
        if (typeof temp !== "number") return false;
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

  // Geocode the org's configured address (cached). Used only in "business" mode.
  const businessCoords = useCallback(async (): Promise<GeoCoords | null> => {
    if (!location || !key) return null;
    const cached = readCityCache(location);
    if (cached) return cached;
    try {
      await loadGoogleMaps(key);
      const g = (window as any).google;
      const res = await new g.maps.Geocoder().geocode({ address: location });
      const loc = res.results?.[0]?.geometry?.location;
      if (!loc) return null;
      const c = { lat: loc.lat(), lng: loc.lng() };
      writeCityCache(location, c);
      return c;
    } catch {
      return null;
    }
  }, [location, key]);

  // Explicit "use my location" tap (device mode). An in-gesture geolocation call — which iOS home-screen
  // PWAs honor even when the on-mount call was ignored. LOW accuracy (city-level is plenty for weather and
  // a cell/wifi fix returns in ~1s, vs. a high-accuracy GPS lock that's slow/flaky on iOS), and it REPORTS
  // why it failed instead of silently doing nothing.
  const locate = useCallback(async () => {
    setLocating(true);
    setLocErr(null);
    const res = await getPosition({ enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
    setLocating(false);
    if (res.status === "ok") {
      writeDeviceFix(res.coords);
      setStatus("loading");
      await fetchWeatherFor(res.coords);
      return;
    }
    setLocErr(
      res.status === "denied"
        ? "Location is off for North. Turn it on in Settings → Privacy & Security → Location → North (allow “While Using”), then tap again."
        : res.status === "unavailable"
          ? "Location isn’t available on this device right now."
          : res.status === "insecure"
            ? "Location needs a secure (https) connection."
            : "Couldn’t get a location fix — tap to try again.", // timeout
    );
  }, [fetchWeatherFor]);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    (async () => {
      if (source === "business") {
        const c = await businessCoords();
        if (cancelled) return;
        if (!c || !(await fetchWeatherFor(c))) {
          if (!cancelled) setStatus("error");
        }
        return;
      }
      // device mode — YOUR location only, no business fallback.
      const recent = readDeviceFix();
      if (recent) {
        if (!(await fetchWeatherFor(recent)) && !cancelled) setStatus("error");
        return;
      }
      const res = await getPosition({ enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
      if (cancelled) return;
      if (res.status === "ok") {
        writeDeviceFix(res.coords);
        if (!(await fetchWeatherFor(res.coords)) && !cancelled) setStatus("error");
      } else {
        setStatus("needloc"); // GPS off/denied → prompt, never the shop's city
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, source, businessCoords, fetchWeatherFor]);

  if (!key || status === "error") return null;

  // Device mode, location off → a compact prompt instead of fake weather.
  if (status === "needloc") {
    return (
      <button
        type="button"
        onClick={locate}
        className="mb-4 flex w-full items-center gap-3 rounded-xl border border-sky-100 bg-gradient-to-br from-sky-50 to-white px-5 py-3 text-left hover:border-sky-300"
      >
        <Cloud className="h-8 w-8 shrink-0 text-sky-400" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-700">Weather for your location</div>
          <div className="inline-flex items-center gap-0.5 text-xs font-medium text-sky-600">
            <MapPin className="h-3 w-3" />
            {locating ? "Getting location…" : locErr ? "Try again" : "Turn on location"}
          </div>
          {locErr && <div className="mt-0.5 text-xs text-slate-500">{locErr}</div>}
        </div>
      </button>
    );
  }

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
              {source === "business" ? (
                <span>{label ?? "Business address"}</span>
              ) : (
                <span className="text-emerald-600">Your location</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
