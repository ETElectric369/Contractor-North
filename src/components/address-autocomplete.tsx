"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { addressBias } from "@/lib/place-bias";

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
  onTextChange,
  onBlur,
  streetOnly = false,
}: {
  id?: string;
  name?: string;
  defaultValue?: string;
  placeholder?: string;
  onResolved?: (parts: AddressParts) => void;
  onTextChange?: (value: string) => void;
  /** The box lost focus: the moment a parent that writes the record should write it (the Inspector's
   *  Where saves here and on a pick, never per keystroke). Not fired by a pick — the dropdown keeps
   *  the focus on purpose, and the pick reports through onResolved. */
  onBlur?: () => void;
  streetOnly?: boolean;
}) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [value, setValue] = useState(defaultValue ?? "");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const justSelected = useRef(false);
  // The value the component MOUNTED with (customer-pick prefill remounts, draft restore)
  // must not fetch predictions: the dropdown would pop open under an UNFOCUSED field —
  // over unrelated form fields — and burn a Places call per prefill. Cleared on the
  // first real edit so typing behaves exactly as before.
  const seeded = useRef((defaultValue ?? "").trim());
  const boxRef = useRef<HTMLDivElement>(null);
  // Places session token: threads a whole type-then-pick sequence into ONE billed Places
  // session (keystrokes + the final details lookup), instead of Google billing each call
  // separately. Generated on the first keystroke of a search, reset after a selection.
  const sessionRef = useRef<string>("");
  // A PICK IS A TAP, NOT A TOUCH. Selection used to fire on pointerdown alone, so a thumb landing on
  // the list to scroll it — or the first contact of a scroll that started over it — chose a row and
  // replaced whatever was typed (Erik, 2026-10-13: "deleted what i typed"). Down remembers where
  // the finger landed; up within a few pixels on the same row is the pick; a scroll cancels it.
  const downRef = useRef<{ x: number; y: number; placeId: string } | null>(null);
  const ensureSession = () => {
    if (!sessionRef.current && typeof crypto !== "undefined" && crypto.randomUUID) sessionRef.current = crypto.randomUUID();
    return sessionRef.current;
  };

  // Surface the current text to the parent (typing + selection).
  useEffect(() => {
    onTextChange?.(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Debounced fetch of predictions.
  useEffect(() => {
    if (!key) return;
    if (justSelected.current) {
      justSelected.current = false;
      return;
    }
    if (seeded.current && value.trim() === seeded.current) return; // mount-seeded value, not typing
    const q = value.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/places", {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: q, sessionToken: ensureSession(), bias: addressBias() }),
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

  // A closed list forgets a touch that began on it (a mouse released over another row otherwise
  // leaves the memory armed for the next row's up).
  useEffect(() => {
    if (!open) downRef.current = null;
  }, [open]);

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
    const token = sessionRef.current;
    sessionRef.current = ""; // the pick ends the billed session; the next search starts a new one
    try {
      const res = await fetch(
        `/api/places?placeId=${encodeURIComponent(s.placeId)}${token ? `&sessionToken=${encodeURIComponent(token)}` : ""}`,
      );
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

  // No key → plain input (no suggestions), but still CONTROLLED and surfaced through
  // onTextChange exactly like the autocomplete path. The old uncontrolled fallback left
  // the parent blind to typing, so the New-Job customer-pick prefill (which trusts
  // form.address via addressPrefillOnCustomerPick's never-clobber contract) judged the
  // field "untouched" and its remount clobbered typed text. Same contract, both paths.
  if (!key) {
    return (
      <Input
        id={id}
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder ?? "Address"}
        autoComplete="off"
      />
    );
  }

  return (
    <div ref={boxRef} className="relative">
      <Input
        id={id}
        name={name}
        value={value}
        onChange={(e) => {
          seeded.current = ""; // a real edit — predictions may flow again
          setValue(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
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
                // preventDefault on pointerdown keeps the input's focus (and the keyboard) through
                // the tap, so a pick never races a blur; the pick itself is the matching pointerup.
                onPointerDown={(e) => {
                  e.preventDefault();
                  downRef.current = { x: e.clientX, y: e.clientY, placeId: s.placeId };
                }}
                onPointerUp={(e) => {
                  const d = downRef.current;
                  downRef.current = null;
                  if (d && d.placeId === s.placeId && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 10) choose(s);
                }}
                onPointerCancel={() => {
                  downRef.current = null;
                }}
                // A keyboard or screen-reader activation is a click with no pointer behind it
                // (detail 0); a mouse's click follows its own pointerup, which already chose.
                onClick={(e) => {
                  if (e.detail === 0) choose(s);
                }}
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
