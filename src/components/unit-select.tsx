"use client";

import { useState } from "react";
import { Input, Select } from "@/components/ui/input";
import { UNIT_SUGGESTIONS, normalizeUnit } from "@/lib/pricing/units";

/**
 * THE UNIT DROPDOWN (Erik: "each price list item has a dropdown menu for label (ea/ft/sq ft, etc.)").
 * A datalist only suggests once you type; a dropdown shows the vocabulary. The list is the shared
 * one in lib/pricing/units, plus the item's own unit when it's something else, plus "Other…" for
 * a unit the list doesn't have — typed once, normalized, kept verbatim.
 */
export function UnitSelect({
  id,
  value,
  onChange,
  className = "",
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (unit: string) => void;
  className?: string;
  "aria-label"?: string;
}) {
  const current = normalizeUnit(value);
  const known = (UNIT_SUGGESTIONS as readonly string[]).includes(current);
  const [other, setOther] = useState(!known && current !== "ea" ? current : "");
  const [typing, setTyping] = useState(false);
  const selectValue = typing ? "__other" : known ? current : "__custom";
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <Select
        id={id}
        aria-label={ariaLabel ?? "Unit"}
        className="h-10 w-auto min-w-[5.5rem]"
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__other") {
            setTyping(true);
            return;
          }
          setTyping(false);
          if (v === "__custom") return;
          onChange(v);
        }}
      >
        {UNIT_SUGGESTIONS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
        {!known && current !== "ea" && !typing && <option value="__custom">{current}</option>}
        <option value="__other">Other…</option>
      </Select>
      {typing && (
        <Input
          autoFocus
          aria-label="Custom unit"
          className="h-10 w-28"
          placeholder="e.g. pallet"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onBlur={() => {
            const u = normalizeUnit(other);
            setTyping(false);
            if (other.trim()) onChange(u);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      )}
    </div>
  );
}
