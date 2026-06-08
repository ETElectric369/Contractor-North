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

interface Suggestion {
  placeId: string;
  text: string;
}

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places";

/**
 * Address field with Google Places autocomplete via the Places API (New) REST
 * endpoint and a custom dropdown. Works with a browser-referrer-restricted key.
 * Falls back to a plain input when the Maps key isn't set.
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
  const [value, setValue] = useState(defaultValue ?? "");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const justSelected = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced fetch of predictions.
  useEffect(() => {
    if (!key) return;
    if (justSelected.current) {
      justSelected.current = false;
      return;
    }
    const q = value.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(AUTOCOMPLETE_URL, {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
          },
          body: JSON.stringify({ input: q, includedRegionCodes: ["us"] }),
        });
        if (!res.ok) return;
        const data = await res.json();
        const list: Suggestion[] = (data.suggestions ?? [])
          .map((s: any) => s.placePrediction)
          .filter(Boolean)
          .map((p: any) => ({ placeId: p.placeId, text: p.text?.text ?? "" }));
        setSuggestions(list);
        setOpen(list.length > 0);
        setActive(-1);
      } catch {
        /* aborted or network — ignore */
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [value, key]);

  // Close on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  async function choose(s: Suggestion) {
    justSelected.current = true;
    setOpen(false);
    setSuggestions([]);
    if (!key) return;
    try {
      const res = await fetch(`${DETAILS_URL}/${s.placeId}`, {
        headers: {
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "formattedAddress,addressComponents",
        },
      });
      const place = res.ok ? await res.json() : {};
      const comps: any[] = place.addressComponents ?? [];
      const get = (type: string, short = false) => {
        const c = comps.find((x) => (x.types || []).includes(type));
        return (short ? c?.shortText : c?.longText) ?? "";
      };
      const line1 = `${get("street_number")} ${get("route")}`.trim();
      const parts: AddressParts = {
        formatted: place.formattedAddress ?? s.text,
        line1: line1 || s.text,
        city: get("locality") || get("postal_town") || get("sublocality_level_1"),
        state: get("administrative_area_level_1", true),
        zip: get("postal_code"),
      };
      setValue(streetOnly ? parts.line1 : parts.formatted);
      onResolved?.(parts);
    } catch {
      setValue(s.text);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      choose(suggestions[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // No key → plain input.
  if (!key) {
    return (
      <Input id={id} name={name} defaultValue={defaultValue} placeholder={placeholder ?? "Address"} autoComplete="off" />
    );
  }

  return (
    <div ref={boxRef} className="relative">
      <Input
        id={id}
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        placeholder={placeholder ?? "Start typing an address…"}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {suggestions.map((s, i) => (
            <li key={s.placeId}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(s)}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                  i === active ? "bg-slate-50" : ""
                }`}
              >
                <span className="mt-0.5 text-slate-400">📍</span>
                <span className="text-slate-700">{s.text}</span>
              </button>
            </li>
          ))}
          <li className="px-3 pt-1 text-right text-[10px] text-slate-400">powered by Google</li>
        </ul>
      )}
    </div>
  );
}
