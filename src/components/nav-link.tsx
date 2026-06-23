"use client";

import { useEffect, useRef, useState } from "react";
import { navUrl, MAPS_PROVIDER_KEY, type MapsProvider } from "@/lib/maps";

/**
 * A "navigate to this address" link that honors the user's preferred maps app.
 * The FIRST time it's tapped (no preference saved) it asks Apple vs Google and
 * remembers the choice — so Apple users who want Google find the option at the
 * point of use, not buried in Settings (where it can still be changed). After a
 * choice is made it's a plain link that opens directly. All directions links go
 * through here.
 */
export function NavLink({
  address,
  className,
  children,
}: {
  address: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [provider, setProvider] = useState<MapsProvider | null>(null); // null = not yet chosen
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    try {
      const p = localStorage.getItem(MAPS_PROVIDER_KEY);
      if (p === "google" || p === "apple") setProvider(p);
    } catch {}
  }, []);

  useEffect(() => {
    if (!picking) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [picking]);

  function choose(p: MapsProvider) {
    try {
      localStorage.setItem(MAPS_PROVIDER_KEY, p);
    } catch {}
    setProvider(p);
    setPicking(false);
    window.open(navUrl(address, p), "_blank", "noopener,noreferrer");
  }

  // Already chosen → a plain anchor that opens guided directions directly.
  if (provider) {
    return (
      <a href={navUrl(address, provider)} target="_blank" rel="noreferrer" className={className}>
        {children}
      </a>
    );
  }

  // First use → tapping asks which maps app, then remembers it.
  return (
    <span ref={ref} className="relative inline-flex">
      <button type="button" onClick={() => setPicking((v) => !v)} className={className}>
        {children}
      </button>
      {picking && (
        <span
          style={{ position: "absolute", left: 0, top: "calc(100% + 0.25rem)" }}
          className="glass glass-gloss glass-menu z-[90] w-44 overflow-hidden rounded-lg py-1 shadow-xl"
        >
          <span className="block px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Open in…</span>
          <button type="button" onClick={() => choose("google")} className="block w-full px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15">
            Google Maps
          </button>
          <button type="button" onClick={() => choose("apple")} className="block w-full px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15">
            Apple Maps
          </button>
        </span>
      )}
    </span>
  );
}
