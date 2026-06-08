"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Route } from "lucide-react";
import { loadGoogleMaps } from "@/lib/google-maps";

interface MapJob {
  id: string;
  name: string;
  address: string | null;
  customer: string | null;
}

export function JobsMap({ jobs }: { jobs: MapJob[] }) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const rendererRef = useRef<any>(null);
  const ptsRef = useRef<{ loc: any; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [routing, setRouting] = useState(false);
  const [located, setLocated] = useState(0);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    loadGoogleMaps(key)
      .then(async () => {
        if (cancelled || !ref.current) return;
        const g = (window as any).google;
        const map = new g.maps.Map(ref.current, {
          center: { lat: 39.5, lng: -98.35 },
          zoom: 4,
          mapTypeControl: false,
          streetViewControl: false,
        });
        mapRef.current = map;
        const geocoder = new g.maps.Geocoder();
        const bounds = new g.maps.LatLngBounds();
        const info = new g.maps.InfoWindow();

        for (const j of jobs) {
          if (!j.address) continue;
          try {
            const res = await geocoder.geocode({ address: j.address });
            const loc = res.results?.[0]?.geometry?.location;
            if (!loc) continue;
            const marker = new g.maps.Marker({ map, position: loc, title: j.name });
            marker.addListener("click", () => {
              info.setContent(
                `<div style="font-size:13px"><strong>${j.name}</strong><br/>${j.customer ?? ""}<br/><a href="/jobs/${j.id}">Open job →</a></div>`,
              );
              info.open(map, marker);
            });
            bounds.extend(loc);
            ptsRef.current.push({ loc, name: j.name });
          } catch {}
        }
        if (ptsRef.current.length) map.fitBounds(bounds);
        if (!cancelled) {
          setLocated(ptsRef.current.length);
          setLoading(false);
        }
      })
      .catch(() => {
        setError("Couldn't load Google Maps. Check the API key and that the Maps JavaScript API is enabled.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function planRoute() {
    const g = (window as any).google;
    const pts = ptsRef.current;
    if (!g) return;
    if (pts.length < 2) {
      setError("Add at least 2 jobs with addresses to suggest a route.");
      return;
    }
    setError(null);
    setRouting(true);
    const svc = new g.maps.DirectionsService();
    if (!rendererRef.current) {
      rendererRef.current = new g.maps.DirectionsRenderer({ map: mapRef.current, suppressMarkers: false });
    }
    svc.route(
      {
        origin: pts[0].loc,
        destination: pts[pts.length - 1].loc,
        waypoints: pts.slice(1, -1).map((p) => ({ location: p.loc, stopover: true })),
        optimizeWaypoints: true,
        travelMode: g.maps.TravelMode.DRIVING,
      },
      (result: any, status: string) => {
        setRouting(false);
        if (status === "OK") rendererRef.current.setDirections(result);
        else setError("Couldn't build a route. Enable the Directions API for your key.");
      },
    );
  }

  if (!key) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">
        Add <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> in Vercel to enable the map.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500">{jobs.length} job{jobs.length === 1 ? "" : "s"} with an address</div>
        <button
          onClick={planRoute}
          disabled={routing || located < 2}
          title={located < 2 ? "Needs at least 2 jobs with addresses" : "Optimize a driving route between stops"}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {routing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Route className="h-4 w-4" />}
          Suggest route
        </button>
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="relative">
        <div ref={ref} className="h-[60vh] w-full rounded-xl border border-slate-200" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/60">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          </div>
        )}
      </div>
    </div>
  );
}
