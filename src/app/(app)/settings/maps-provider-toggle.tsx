"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { MAPS_PROVIDER_KEY, type MapsProvider } from "@/lib/maps";

/** Per-device preference for which maps app the "Navigate" links open. Saved in
 *  localStorage (read by <NavLink>), so each person/device chooses their own. */
export function MapsProviderToggle() {
  const [provider, setProvider] = useState<MapsProvider>("apple");
  useEffect(() => {
    try {
      const p = localStorage.getItem(MAPS_PROVIDER_KEY);
      if (p === "google" || p === "apple") setProvider(p);
    } catch {}
  }, []);
  function choose(p: MapsProvider) {
    setProvider(p);
    try {
      localStorage.setItem(MAPS_PROVIDER_KEY, p);
    } catch {}
  }
  const opts: { value: MapsProvider; label: string }[] = [
    { value: "apple", label: "Apple Maps" },
    { value: "google", label: "Google Maps" },
  ];
  return (
    <div>
      <p className="mb-3 text-sm text-slate-500">Which app the “Navigate” buttons open for driving directions.</p>
      <div className="flex gap-2">
        {opts.map((o) => {
          const active = provider === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => choose(o.value)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${
                active ? "seaglass-active border-transparent" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {active && <Check className="relative z-10 h-4 w-4 shrink-0" />} <span className="relative z-10">{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
