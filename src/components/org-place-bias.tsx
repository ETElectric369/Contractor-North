"use client";

import { useEffect } from "react";
import { setOrgBias } from "@/lib/place-bias";

/** The company's ground, handed to every address box on the page (lib/place-bias). Renders nothing. */
export function OrgPlaceBias({ lat, lng }: { lat: number | null; lng: number | null }) {
  useEffect(() => {
    setOrgBias(lat !== null && lng !== null ? { lat, lng } : null);
    return () => setOrgBias(null);
  }, [lat, lng]);
  return null;
}
