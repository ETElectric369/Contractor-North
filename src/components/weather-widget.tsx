"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, MapPin, MapPinOff } from "lucide-react";
import * as geo from "@/lib/geo";
import type { GeoCoords } from "@/lib/geo";
import { isNativeShell } from "@/lib/native-shell";
import { reportClientError } from "@/app/report-client-error";

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

// THE WEATHER FOLLOWS THE PHONE (2026-11-04, "stuck on home"). The shared last fix (geo.ts, ≤ 10 min,
// never across a resume) is the first answer; a reading is fetched again when the phone moved more
// than MOVED_KM or the reading is older than READING_MAX_MS; every resume asks again.
export const MOVED_KM = 5;
export const READING_MAX_MS = 30 * 60 * 1000;
/** A Turn On Location tap that worked is kept: the next open follows without another tap. */
export const FOLLOW_KEY = "weather:follow";

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

function readFollow(): boolean {
  try {
    return localStorage.getItem(FOLLOW_KEY) === "true";
  } catch {
    return false;
  }
}
function writeFollow(on: boolean) {
  try {
    if (on) localStorage.setItem(FOLLOW_KEY, "true");
    else localStorage.removeItem(FOLLOW_KEY);
  } catch {
    /* ignore */
  }
}

/** Straight-line km between two points (haversine). */
export function kmBetween(a: GeoCoords, b: GeoCoords): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The reading on screen: the rounded place it was fetched for, when, and whether it is the phone's. */
export type WeatherReading = { lat: number; lng: number; at: number; device: boolean };
const round = (c: GeoCoords): GeoCoords => ({ lat: Math.round(c.lat * 100) / 100, lng: Math.round(c.lng * 100) / 100 });

/** Fetch again? None yet, the other kind of place, moved more than MOVED_KM, or older than READING_MAX_MS. */
export function shouldRefetch(prev: WeatherReading | null, at: GeoCoords, device: boolean, now: number): boolean {
  if (!prev || prev.device !== device) return true;
  if (now - prev.at > READING_MAX_MS) return true;
  return kmBetween(prev, round(at)) > MOVED_KM;
}

/** The geo doors the follower uses (a fake in the tests). */
export type WeatherGeo = Pick<typeof geo, "mayReadLocation" | "geoPermission" | "getPosition" | "lastFix" | "onResume">;

/**
 * THE FOLLOWER — the widget's whole decision, outside React so it can be driven in a test.
 * 1. The shared last fix (≤ 10 min, not across a resume) → the phone's place, no machinery.
 * 2. THE GATE (geo.mayReadLocation: the phone's own answer in the shell, a live grant in Safari) →
 *    a silent read. Off the shell, and outside an installed home-screen app, a Turn On Location tap
 *    that once worked (FOLLOW_KEY) also reads while the browser's grant STANDS ("granted"; an
 *    "Allow Once" is back at "prompt" and never asks unasked) — the cn-v327 law; a denial clears it.
 * 3. Otherwise the shop's town, and the row SAYS so (never silent) with the tap beside it.
 * start() runs it and runs it again on every resume; locate() is the tap.
 */
export function weatherFollower(d: {
  geo: WeatherGeo;
  source: "device" | "business";
  fetchFor: (c: GeoCoords) => Promise<boolean>;
  shopCoords: () => Promise<GeoCoords | null>;
  onPlace: (p: { device: boolean; coords: GeoCoords }) => void;
  onDenied: (denied: boolean) => void;
  onFail: () => void;
  inShell?: () => boolean;
  standalone?: () => boolean;
  now?: () => number;
}) {
  const now = d.now ?? Date.now;
  let reading: WeatherReading | null = null;
  let stopped = false;
  let running = false;
  let again = false;

  async function show(coords: GeoCoords, device: boolean): Promise<boolean> {
    if (shouldRefetch(reading, coords, device, now())) {
      if (!(await d.fetchFor(coords))) return false;
      reading = { ...round(coords), at: now(), device };
    }
    if (!stopped) d.onPlace({ device, coords });
    return true;
  }

  async function once() {
    if (d.source === "device") {
      const recent = d.geo.lastFix();
      if (recent && (await show(recent, true))) return;
      if (stopped) return;
      const may = await d.geo.mayReadLocation();
      const perm = may ? "granted" : await d.geo.geoPermission();
      // A kept tap reads with no new tap only on a STANDING grant: "Allow Once" leaves Safari at
      // "prompt", and reading then would put Safari's question up on every open, unasked. Then the row
      // shows the shop and the Turn On Location tap instead.
      const follow = !may && perm === "granted" && readFollow() && !(d.inShell?.() ?? false) && !(d.standalone?.() ?? false);
      if ((may || follow) && !stopped) {
        const res = await d.geo.getPosition(GEO_OPTS);
        if (stopped) return;
        if (res.status === "ok") {
          d.onDenied(false);
          if (await show(res.coords, true)) return;
        } else if (res.status === "denied") {
          d.onDenied(true);
          writeFollow(false);
        }
      } else if (perm === "denied") {
        d.onDenied(true);
        writeFollow(false);
      }
    }
    if (stopped) return;
    const shop = await d.shopCoords();
    if (stopped) return;
    if (!shop || !(await show(shop, false))) d.onFail();
  }

  async function run(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await once();
      } while (again && !stopped);
    } finally {
      running = false;
    }
  }

  /** The Turn On Location tap — THE legitimate first-ask moment (getPosition fires inside the tap). */
  async function locate(): Promise<"ok" | "denied" | "failed"> {
    const res = await d.geo.getPosition(GEO_OPTS);
    if (res.status === "denied") {
      d.onDenied(true);
      writeFollow(false);
      return "denied";
    }
    if (res.status !== "ok") return "failed";
    writeFollow(true);
    d.onDenied(false);
    return (await show(res.coords, true)) ? "ok" : "failed";
  }

  function start(): () => void {
    void run();
    const off = d.geo.onResume(() => void run());
    return () => {
      stopped = true;
      off();
    };
  }

  return { start, run, locate };
}

function standaloneApp(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (navigator as unknown as { standalone?: boolean }).standalone === true || !!window.matchMedia?.("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

/** The town a phone position resolves to — cached per ~1 km cell, null when it cannot be said. */
async function townFor(c: GeoCoords): Promise<string | null> {
  const r = round(c);
  const k = `geotown:${r.lat},${r.lng}`;
  try {
    const hit = localStorage.getItem(k);
    if (hit) return hit;
  } catch {
    /* ignore */
  }
  try {
    const res = await fetch(`/api/geocode?latlng=${r.lat},${r.lng}`);
    if (!res.ok) return null;
    const g = await res.json();
    const town = typeof g?.city === "string" && g.city.trim() ? g.city.trim() : null;
    if (town) {
      try {
        localStorage.setItem(k, town);
      } catch {
        /* ignore */
      }
    }
    return town;
  } catch {
    return null;
  }
}

/**
 * THE COMPACT ROW (My Day's header). It always says which place it shows: following the phone, the
 * town (or the pin when the town cannot be said); on the shop's weather, one line — "Weather for
 * <town> — Turn On Location to follow you." — the tap in it. Pure, so a test renders it.
 */
export function WeatherRow({
  data,
  status,
  source,
  usingDevice,
  denied,
  hint,
  town,
  label,
  onLocate,
  onToggleHint,
}: {
  data: WeatherData | null;
  status: "loading" | "ok" | "error";
  source: "device" | "business";
  usingDevice: boolean;
  denied: boolean;
  hint: boolean;
  town: string | null;
  label?: string;
  onLocate: () => void;
  onToggleHint: () => void;
}) {
  const shopLine = source === "device" && !usingDevice && status === "ok" && !!data;
  return (
    <div className="relative flex min-w-0 shrink flex-col items-end text-xs text-slate-500">
      <div className="flex min-w-0 items-center gap-2">
        {data?.iconUri ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={data.iconUri} alt={data.description} className="h-9 w-9" />
        ) : (
          <Cloud className="h-7 w-7 text-sky-400" />
        )}
        {status === "loading" || !data ? (
          <span title={status === "error" ? "Weather unavailable" : undefined}>—</span>
        ) : (
          <>
            <span className="whitespace-nowrap text-lg font-semibold leading-none text-slate-700">{data.tempF}°F</span>
            <span className="max-w-[9rem] truncate">{data.description}</span>
            {usingDevice &&
              (town ? (
                <span className="inline-flex max-w-[8rem] items-center gap-0.5 truncate text-emerald-600" title="Following your location">
                  <MapPin className="h-3 w-3 shrink-0" />
                  {town}
                </span>
              ) : (
                <MapPin className="h-3.5 w-3.5 text-emerald-500" aria-label="Your location" />
              ))}
          </>
        )}
      </div>
      {shopLine && (
        <div className="max-w-[18rem] truncate text-[11px] leading-snug text-slate-500">
          Weather for {label || "the shop"} —{" "}
          <button
            type="button"
            onClick={denied ? onToggleHint : onLocate}
            title={denied ? DENIED_HINT : undefined}
            className={denied ? "inline-flex items-center gap-0.5 font-medium text-amber-600 hover:text-amber-700" : "inline-flex items-center gap-0.5 font-medium text-sky-600 hover:text-sky-700"}
          >
            {denied ? <MapPinOff className="h-3 w-3" /> : <MapPin className="h-3 w-3" />}
            Turn On Location
          </button>{" "}
          to follow you.
        </div>
      )}
      {denied && hint && (
        <span className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-[11px] leading-snug text-slate-600 shadow-lg">
          {DENIED_HINT}
        </span>
      )}
    </div>
  );
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
 * Since 2026-11-04 the decision is weatherFollower's (above): the shared gate, re-run on resume, a
 * fresh reading when the phone moved > 5 km or the reading is 30 minutes old, a kept tap.
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
  const [deviceAt, setDeviceAt] = useState<GeoCoords | null>(null); // the phone's place on screen
  const [town, setTown] = useState<string | null>(null); // the town it resolves to, when it can be said
  const failCodeRef = useRef<number | null>(null); // last non-ok HTTP status (403 = referrer block)
  const reportedRef = useRef(false); // log the outage to the error sink once per mount, not per retry

  const fetchWeatherFor = useCallback(
    async (coords: GeoCoords): Promise<boolean> => {
      if (!key) return false;
      try {
        // Same-origin proxy (server key) — works on any domain, no client key, cached server-side.
        const r = await fetch(`/api/weather?lat=${coords.lat}&lng=${coords.lng}`);
        if (!r.ok) {
          failCodeRef.current = r.status; // captured so the outage below is diagnosable (403 = referrer block)
          return false;
        }
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

  // The shop's place (geocode the org address, cached). The always-there fallback.
  const shopCoords = useCallback(async (): Promise<GeoCoords | null> => {
    if (!location || !key) return null;
    let c = readCity(location);
    if (!c) {
      try {
        // Same-origin geocode proxy (server key) instead of loading the Maps JS bundle — works
        // on any domain and doesn't drag in the whole client library just to resolve a city.
        const res = await fetch(`/api/geocode?address=${encodeURIComponent(location)}`);
        if (res.ok) {
          const g = await res.json();
          if (typeof g.lat === "number") {
            c = { lat: g.lat, lng: g.lng };
            writeCity(location, c);
          }
        }
      } catch {
        /* fall through */
      }
    }
    return c;
  }, [location, key]);

  const followerRef = useRef<ReturnType<typeof weatherFollower> | null>(null);

  // THE FOLLOWER (above): runs on mount and again on every resume (geo.onResume), through the shared
  // gate — never the WebView's own answer in the shell.
  useEffect(() => {
    if (!key) return;
    const f = weatherFollower({
      geo,
      source,
      fetchFor: fetchWeatherFor,
      shopCoords,
      onPlace: ({ device, coords }) => {
        setUsingDevice(device);
        setDeviceAt(device ? coords : null);
      },
      onDenied: setDenied,
      onFail: () => {
        setStatus("error");
        // Surface the outage in the error log instead of silently vanishing. A 403 here almost
        // always means the Google Maps/Weather API key's HTTP-referrer allowlist is missing this
        // domain (the same block breaks the map, autocomplete, and mileage on the same key).
        if (!reportedRef.current) {
          reportedRef.current = true;
          const code = failCodeRef.current;
          void reportClientError(
            "weather-widget",
            `weather fetch failed${code ? ` (HTTP ${code})` : ""}`,
            { source, httpStatus: code, hint: code === 403 ? "Google Maps API key HTTP-referrer allowlist likely missing this domain" : undefined },
          );
        }
      },
      inShell: isNativeShell,
      standalone: standaloneApp,
    });
    followerRef.current = f;
    const stop = f.start();
    return () => {
      stop();
      if (followerRef.current === f) followerRef.current = null;
    };
  }, [key, source, fetchWeatherFor, shopCoords]);

  // The Turn On Location tap — THE legitimate first-ask moment: getPosition() fires inside this click
  // chain. One that works is kept (FOLLOW_KEY); a denial opens the explainer, never a loop.
  const locate = useCallback(async () => {
    const r = await followerRef.current?.locate();
    if (r === "denied") setHint(true); // the tap did nothing visible otherwise — say why, right where they tapped
  }, []);

  // Following the phone: the town it resolves to (cached per ~1 km), else the pin alone.
  useEffect(() => {
    if (!usingDevice || !deviceAt) {
      setTown(null);
      return;
    }
    let live = true;
    void townFor(deviceAt).then((t) => {
      if (live) setTown(t);
    });
    return () => {
      live = false;
    };
  }, [usingDevice, deviceAt]);

  // Only vanish when there's genuinely no key to try. On a fetch failure we DEGRADE to a
  // muted "unavailable" slot instead of disappearing (the silent-vanish is exactly what made
  // the app.contractornorth.com referrer-block invisible) — and the failure is logged below.
  if (!key) return null;

  if (compact) {
    return (
      <WeatherRow
        data={data}
        status={status}
        source={source}
        usingDevice={usingDevice}
        denied={denied}
        hint={hint}
        town={town}
        label={label}
        onLocate={locate}
        onToggleHint={() => setHint((v) => !v)}
      />
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
          <div className="text-sm text-slate-400">{status === "error" ? "Weather unavailable" : "Loading weather…"}</div>
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
                <span className="text-emerald-600">{town ?? "Your location"}</span>
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
                          <MapPinOff className="h-3 w-3" /> Location Blocked
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={locate}
                          className="inline-flex items-center gap-0.5 font-medium text-sky-600 hover:text-sky-700"
                        >
                          <MapPin className="h-3 w-3" /> Turn On Location
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
