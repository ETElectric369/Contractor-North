"use client";

import { useCallback, useEffect, useState } from "react";
import { Cloud, MapPin, MapPinOff } from "lucide-react";
import { loadGoogleMaps } from "@/lib/google-maps";
import { geoPermission, getPosition, lastFix, type GeoCoords } from "@/lib/geo";

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

// A 2h-old fix — from ANY caller: a punch, the geofence, a past weather read (geo.ts caches them all) —
// is still close enough for city-level weather.
const FIX_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// Denied means the OS is blocking the INSTALLED app's location (independent of Safari's) — no prompt we
// fire can fix that, so never loop a doomed one; give the honest way out instead.
const DENIED_HINT =
  "iPhone has location blocked for the installed app — Settings → North → Location, or delete & re-add the app.";
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
 * Current-conditions weather. It ALWAYS shows something: in "device" mode it uses the user's location
 * (a recent cached fix, else — ONLY when the permission is already granted/memoized — a silent GPS
 * read). That's the steady state: after ONE real grant, every open is your location and the shop city
 * never appears. Pre-grant it falls back to the shop's configured city — labeled honestly ("{city} ·
 * Use my location"), never pretending the shop is you — and the ONLY way it ever requests permission is
 * the explicit in-widget tap (THE iOS RULE in geo.ts: an off-gesture request in the installed PWA is
 * silently denied and that denial can persist — that was the "stuck on Chilcoot forever" bug). If the
 * OS has location blocked, the tap affordance becomes a short honest explainer instead of a doomed
 * re-prompt. In "business" mode it just uses the shop's city; `weather_source` picks the mode.
 */
export function WeatherWidget({
  location,
  label,
  source = "device",
  compact = false,
}: {
  location: string | null;
  label?: string;
  source?: "device" | "business";
  /** One slim inline row (small icon · temp · condition) instead of the full card. */
  compact?: boolean;
}) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [data, setData] = useState<WeatherData | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [usingDevice, setUsingDevice] = useState(false); // true = showing the user's own GPS location
  const [denied, setDenied] = useState(false); // OS-level block — swap the locate tap for the explainer
  const [hint, setHint] = useState(false); // the denied explainer line/popover is open

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

  // Explicit "use my location" tap — THE legitimate first-grant moment. getPosition() fires
  // getCurrentPosition synchronously inside this click chain (nothing awaits before it), which is the
  // one shape of request an iOS home-screen PWA honors with a real permission popup. One Allow here and
  // geo.ts memoizes the grant → every later open reads silently. Denied → the explainer, never a loop.
  const locate = useCallback(async () => {
    const res = await getPosition(GEO_OPTS);
    if (res.status === "denied") {
      setDenied(true);
      setHint(true); // the tap did nothing visible otherwise — say why, right where they tapped
      return;
    }
    if (res.status !== "ok") return; // timeout/no-hardware — quietly stay on the shop's weather
    setDenied(false);
    setUsingDevice(true);
    await fetchWeatherFor(res.coords);
  }, [fetchWeatherFor]);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;

    (async () => {
      if (source === "device") {
        // 1. A recent fix from ANY caller → your location instantly, no permission machinery at all.
        const recent = lastFix(FIX_MAX_AGE_MS);
        if (recent) {
          setUsingDevice(true);
          if (await fetchWeatherFor(recent)) return;
        }
        // 2. Permission already granted (live, or memoized by a past successful fix) → a silent read is
        //    safe. This is the steady state: after ONE grant, every open lands here.
        const perm = await geoPermission();
        if (perm === "granted" && !cancelled) {
          const res = await getPosition(GEO_OPTS);
          if (!cancelled && res.status === "ok") {
            setUsingDevice(true);
            if (await fetchWeatherFor(res.coords)) return;
          }
          if (!cancelled && res.status === "denied") setDenied(true); // revoked in Settings since the memo
        } else if (perm === "denied" && !cancelled) {
          setDenied(true);
        }
        // 3. Not granted yet (prompt/unknown) or denied: NEVER fire an off-gesture request — iOS
        //    standalone PWAs silently deny those and can PERSIST the denial, poisoning later real
        //    prompts (the old global first-tap listener did exactly this). The in-widget "Use my
        //    location" tap (locate) is the one honest way to ask.
      }
      // The shop's weather so the card ALWAYS shows something — the labeled EXCEPTION state, reached
      // only pre-grant or post-deny.
      if (!(await showShop()) && !cancelled) setStatus("error");
    })();

    return () => {
      cancelled = true;
    };
  }, [key, source, fetchWeatherFor, showShop]);

  if (!key || status === "error") return null;

  if (compact) {
    return (
      <div className="relative flex min-w-0 shrink-0 items-center gap-1.5 text-xs text-slate-500">
        {data?.iconUri ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={data.iconUri} alt={data.description} className="h-5 w-5" />
        ) : (
          <Cloud className="h-4 w-4 text-sky-400" />
        )}
        {status === "loading" || !data ? (
          <span>—</span>
        ) : (
          <>
            <span className="whitespace-nowrap font-semibold text-slate-700">{data.tempF}°F</span>
            <span className="max-w-[9rem] truncate">{data.description}</span>
            {source === "device" &&
              !usingDevice &&
              (denied ? (
                <button
                  type="button"
                  onClick={() => setHint((v) => !v)}
                  title={DENIED_HINT}
                  aria-label="Location blocked — how to fix it"
                  className="text-amber-500 hover:text-amber-600"
                >
                  <MapPinOff className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button type="button" onClick={locate} title="Use my location" className="text-slate-300 hover:text-sky-600">
                  <MapPin className="h-3.5 w-3.5" />
                </button>
              ))}
          </>
        )}
        {denied && hint && (
          <span className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-[11px] leading-snug text-slate-600 shadow-lg">
            {DENIED_HINT}
          </span>
        )}
      </div>
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
              {usingDevice ? (
                <span className="text-emerald-600">Your location</span>
              ) : (
                <>
                  {label || "Shop area"}
                  {source === "device" && (
                    <>
                      {" · "}
                      {denied ? (
                        <button
                          type="button"
                          onClick={() => setHint((v) => !v)}
                          title={DENIED_HINT}
                          className="inline-flex items-center gap-0.5 font-medium text-amber-600 hover:text-amber-700"
                        >
                          <MapPinOff className="h-3 w-3" /> Location blocked
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={locate}
                          className="inline-flex items-center gap-0.5 font-medium text-sky-600 hover:text-sky-700"
                        >
                          <MapPin className="h-3 w-3" /> Use my location
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
            {denied && hint && <div className="mt-1 text-xs text-amber-700">{DENIED_HINT}</div>}
          </>
        )}
      </div>
    </div>
  );
}
