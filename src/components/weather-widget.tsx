"use client";

import { useEffect, useState } from "react";
import { Cloud } from "lucide-react";
import { loadGoogleMaps } from "@/lib/google-maps";

interface WeatherData {
  tempF: number;
  feelsF: number;
  description: string;
  iconUri: string;
  humidity?: number;
  windMph?: number;
}

function readCache(loc: string): { lat: number; lng: number } | null {
  try {
    const raw = localStorage.getItem(`geo:${loc}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeCache(loc: string, c: { lat: number; lng: number }) {
  try {
    localStorage.setItem(`geo:${loc}`, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

/**
 * Current-conditions weather card for the org's location. Geocodes the address
 * client-side (Maps JS, cached) then calls the Google Weather API. Renders
 * nothing when no key / no location is configured.
 */
export function WeatherWidget({ location, label }: { location: string | null; label?: string }) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [data, setData] = useState<WeatherData | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    if (!key || !location) return;
    let cancelled = false;
    (async () => {
      try {
        let coords = readCache(location);
        if (!coords) {
          await loadGoogleMaps(key);
          const g = (window as any).google;
          const geocoder = new g.maps.Geocoder();
          const res = await geocoder.geocode({ address: location });
          const loc = res.results?.[0]?.geometry?.location;
          if (!loc) throw new Error("geocode");
          coords = { lat: loc.lat(), lng: loc.lng() };
          writeCache(location, coords);
        }
        const url =
          `https://weather.googleapis.com/v1/currentConditions:lookup?key=${key}` +
          `&location.latitude=${coords.lat}&location.longitude=${coords.lng}&unitsSystem=IMPERIAL`;
        const r = await fetch(url);
        if (!r.ok) throw new Error("weather");
        const w = await r.json();
        if (cancelled) return;
        setData({
          tempF: Math.round(w.temperature?.degrees ?? 0),
          feelsF: Math.round(w.feelsLikeTemperature?.degrees ?? 0),
          description: w.weatherCondition?.description?.text ?? "—",
          iconUri: w.weatherCondition?.iconBaseUri ? `${w.weatherCondition.iconBaseUri}.png` : "",
          humidity: w.relativeHumidity,
          windMph: w.wind?.speed?.value != null ? Math.round(w.wind.speed.value) : undefined,
        });
        setStatus("ok");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, location]);

  // Not configured → render nothing (keeps dashboard clean).
  if (!key || !location || status === "error") return null;

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
              {label ? ` · ${label}` : ""}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
