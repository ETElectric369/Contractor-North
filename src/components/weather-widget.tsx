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

// Weather only needs a CITY-level fix, so accept a recent cached fix (maximumAge) and DON'T wait for a
// high-accuracy GPS lock — a fresh lock in an iOS home-screen PWA is slow and often fails. This is the
// forgiving behavior that worked before.
const GEO_OPTS: PositionOptions = { enableHighAccuracy: false, timeout: 10000, maximumAge: 30 * 60 * 1000 };

function writeGps(c: GeoCoords) {
  try {
    localStorage.setItem("gps:last", JSON.stringify({ ...c, ts: Date.now() }));
  } catch {
    /* ignore */
  }
}
function readGps(): GeoCoords | null {
  try {
    const raw = localStorage.getItem("gps:last");
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.lat !== "number" || typeof v?.lng !== "number" || typeof v?.ts !== "number") return null;
    if (Date.now() - v.ts > 2 * 60 * 60 * 1000) return null; // a 2h-old fix is still close enough for weather
    return { lat: v.lat, lng: v.lng };
  } catch {
    return null;
  }
}
function readCity(loc: string): GeoCoords | null {
  try {
    const r = localStorage.getItem(`geocity:${loc}`);
    return r ? JSON.parse(r) : null;
  } catch {
    return null;
  }
}
function writeCity(loc: string, c: GeoCoords) {
  try {
    localStorage.setItem(`geocity:${loc}`, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

/**
 * Current-conditions weather. It ALWAYS shows something: in "device" mode it tries the user's location
 * (a recent cached fix, then a quick GPS read) and FALLS BACK to the shop's configured city if that's
 * unavailable — labeled honestly ("{city} · Use my location"), never pretending the shop is you. In
 * "business" mode it just uses the shop's city. The org's `weather_source` setting picks the mode.
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
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [usingDevice, setUsingDevice] = useState(false); // true = showing the user's own GPS location

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
        if (typeof temp !== "number") return false; // partial body — don't fabricate a 0°F
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

  // The shop's weather (geocode the org address, cached). The always-there fallback.
  const showShop = useCallback(async (): Promise<boolean> => {
    if (!location || !key) return false;
    let c = readCity(location);
    if (!c) {
      try {
        await loadGoogleMaps(key);
        const g = (window as any).google;
        const res = await new g.maps.Geocoder().geocode({ address: location });
        const loc = res.results?.[0]?.geometry?.location;
        if (loc) {
          c = { lat: loc.lat(), lng: loc.lng() };
          writeCity(location, c);
        }
      } catch {
        /* fall through */
      }
    }
    if (!c) return false;
    setUsingDevice(false);
    return fetchWeatherFor(c);
  }, [location, key, fetchWeatherFor]);

  // Explicit "use my location" tap — an in-gesture geolocation read (which iOS honors). If the device
  // can't provide a location, we simply stay on the shop's weather (no error, no blank).
  const locate = useCallback(async () => {
    const res = await getPosition(GEO_OPTS);
    if (res.status !== "ok") return;
    writeGps(res.coords);
    setUsingDevice(true);
    await fetchWeatherFor(res.coords);
  }, [fetchWeatherFor]);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let removeGesture: (() => void) | null = null;

    const tryDevice = async (): Promise<boolean> => {
      const res = await getPosition(GEO_OPTS);
      if (cancelled || res.status !== "ok") return false;
      writeGps(res.coords);
      setUsingDevice(true);
      return fetchWeatherFor(res.coords);
    };

    (async () => {
      if (source === "device") {
        const recent = readGps();
        if (recent) {
          setUsingDevice(true);
          if (await fetchWeatherFor(recent)) return;
        }
        // Already granted (or a browser that prompts on load) → your location, no tap needed.
        if (await tryDevice()) return;
      }
      // Default to the shop's weather so the card ALWAYS shows something right away.
      if (!(await showShop()) && !cancelled) setStatus("error");
      // Device mode + not granted yet: iOS only shows the location PERMISSION POPUP inside a tap. So
      // fire the request on the user's FIRST tap anywhere — Allow → upgrade to your location, Deny →
      // just stay on the shop's weather. No Settings, no button to hunt for.
      if (source === "device" && !cancelled) {
        const onGesture = () => {
          removeGesture?.();
          removeGesture = null;
          void tryDevice();
        };
        window.addEventListener("pointerdown", onGesture, { once: true });
        removeGesture = () => window.removeEventListener("pointerdown", onGesture);
      }
    })();

    return () => {
      cancelled = true;
      removeGesture?.();
    };
  }, [key, source, fetchWeatherFor, showShop]);

  if (!key || status === "error") return null;

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
              {usingDevice ? (
                <span className="text-emerald-600">Your location</span>
              ) : (
                <>
                  {label || "Shop area"}
                  {source === "device" && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        onClick={locate}
                        className="inline-flex items-center gap-0.5 font-medium text-sky-600 hover:text-sky-700"
                      >
                        <MapPin className="h-3 w-3" /> Use my location
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
