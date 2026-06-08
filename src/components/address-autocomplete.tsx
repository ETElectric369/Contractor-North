"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

export interface AddressParts {
  formatted: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
}

let mapsPromise: Promise<void> | null = null;
function loadMaps(key: string): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if ((window as any).google?.maps?.places) return Promise.resolve();
  if (!mapsPromise) {
    mapsPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&loading=async`;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("maps failed to load"));
      document.head.appendChild(s);
    });
  }
  return mapsPromise;
}

/**
 * Address field with Google Places autocomplete. Falls back to a plain text
 * input until NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is set. On selection it sets the
 * input to the full formatted address and calls onResolved with parsed parts.
 */
export function AddressAutocomplete({
  id,
  name,
  defaultValue,
  placeholder,
  onResolved,
  streetOnly = false,
}: {
  id?: string;
  name?: string;
  defaultValue?: string;
  placeholder?: string;
  onResolved?: (parts: AddressParts) => void;
  /** When true, the input keeps just the street line (city/state/zip go to onResolved). */
  streetOnly?: boolean;
}) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue ?? "");

  useEffect(() => {
    if (!key || !ref.current) return;
    let ac: any;
    loadMaps(key)
      .then(() => {
        const g = (window as any).google;
        if (!g?.maps?.places || !ref.current) return;
        ac = new g.maps.places.Autocomplete(ref.current, {
          types: ["address"],
          fields: ["formatted_address", "address_components"],
          componentRestrictions: { country: ["us"] },
        });
        ac.addListener("place_changed", () => {
          const place = ac.getPlace();
          const get = (type: string, short = false) => {
            const c = place.address_components?.find((x: any) => x.types.includes(type));
            return (short ? c?.short_name : c?.long_name) ?? "";
          };
          const line1 = `${get("street_number")} ${get("route")}`.trim();
          const parts: AddressParts = {
            formatted: place.formatted_address ?? "",
            line1,
            city: get("locality") || get("sublocality") || get("postal_town"),
            state: get("administrative_area_level_1", true),
            zip: get("postal_code"),
          };
          setValue(streetOnly ? parts.line1 || parts.formatted : parts.formatted);
          onResolved?.(parts);
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <Input
      ref={ref}
      id={id}
      name={name}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder={placeholder ?? "Start typing an address…"}
      autoComplete="off"
    />
  );
}
