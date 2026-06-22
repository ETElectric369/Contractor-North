"use client";

import { useEffect, useState } from "react";
import { navUrl, MAPS_PROVIDER_KEY, type MapsProvider } from "@/lib/maps";

/** A "navigate to this address" link that honors the user's preferred maps app
 *  (Apple or Google), saved in localStorage and set in Settings. Defaults to Apple
 *  until a choice is made. Keep all directions links going through here. */
export function NavLink({
  address,
  className,
  children,
}: {
  address: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [provider, setProvider] = useState<MapsProvider>("apple");
  useEffect(() => {
    try {
      const p = localStorage.getItem(MAPS_PROVIDER_KEY);
      if (p === "google" || p === "apple") setProvider(p);
    } catch {}
  }, []);
  return (
    <a href={navUrl(address, provider)} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  );
}
