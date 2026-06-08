"use client";

import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { loadGoogleMaps } from "@/lib/google-maps";

export interface AddressParts {
  formatted: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
}

/**
 * Address field with Google Places autocomplete using the NEW
 * PlaceAutocompleteElement (works with "Places API (New)"). Falls back to a
 * plain text input when the Maps key isn't set or the element is unavailable.
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
  streetOnly?: boolean;
}) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const containerRef = useRef<HTMLDivElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const attached = useRef(false);

  function setHidden(val: string) {
    const el = hiddenRef.current;
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  useEffect(() => {
    if (!key || !containerRef.current || attached.current) return;
    let el: any;
    loadGoogleMaps(key)
      .then(async () => {
        const g = (window as any).google;
        const places = g?.maps?.places;
        if (!places?.PlaceAutocompleteElement || !containerRef.current) return;
        attached.current = true;

        el = new places.PlaceAutocompleteElement();
        el.style.width = "100%";
        if (defaultValue) try { el.value = defaultValue; } catch {}
        containerRef.current.appendChild(el);

        // Keep the hidden form value synced with raw typing too.
        containerRef.current.addEventListener("input", (e: any) => {
          const v = e?.target?.value;
          if (typeof v === "string") setHidden(v);
        });

        const onSelect = async (event: any) => {
          const pred = event.placePrediction ?? event.detail?.placePrediction;
          if (!pred) return;
          const place = pred.toPlace();
          await place.fetchFields({
            fields: ["formattedAddress", "addressComponents"],
          });
          const comps: any[] = place.addressComponents ?? [];
          const get = (type: string, short = false) => {
            const c = comps.find((x) => (x.types || []).includes(type));
            return (short ? c?.shortText ?? c?.short_name : c?.longText ?? c?.long_name) ?? "";
          };
          const line1 = `${get("street_number")} ${get("route")}`.trim();
          const parts: AddressParts = {
            formatted: place.formattedAddress ?? "",
            line1,
            city: get("locality") || get("postal_town") || get("sublocality"),
            state: get("administrative_area_level_1", true),
            zip: get("postal_code"),
          };
          setHidden(streetOnly ? parts.line1 || parts.formatted : parts.formatted);
          onResolved?.(parts);
        };
        el.addEventListener("gmp-select", onSelect);
        el.addEventListener("gmp-placeselect", onSelect);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // No key → plain input that submits normally.
  if (!key) {
    return (
      <Input id={id} name={name} defaultValue={defaultValue} placeholder={placeholder ?? "Address"} autoComplete="off" />
    );
  }

  return (
    <div>
      <div ref={containerRef} className="gmp-autocomplete" />
      <input ref={hiddenRef} type="hidden" name={name} defaultValue={defaultValue} />
    </div>
  );
}
