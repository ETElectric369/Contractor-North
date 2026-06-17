"use client";

import * as React from "react";
import { Input } from "./input";

/**
 * A number field that's pleasant to type in:
 *  - shows blank (not "0") when the value is 0, so there's nothing to delete first
 *  - lets you type decimals freely ("1.", "0.5") without the value fighting you
 *  - still reports a real number up to the parent via onValueChange
 */
export function NumberInput({
  value,
  onValueChange,
  className,
  ...props
}: {
  value: number;
  onValueChange: (n: number) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const [text, setText] = React.useState(value === 0 ? "" : String(value));
  const [focused, setFocused] = React.useState(false);

  // Sync when the value changes from the outside (e.g. AI fills the field), but
  // NEVER while the field is focused — re-deriving `text` from `value` during
  // typing rewrites the input and yanks the caret to the start (the "type 1, see
  // 11 with the cursor on the left" bug). On blur we re-sync to normalise (e.g.
  // "1." → "1"). While focused, what the user types is the single source.
  React.useEffect(() => {
    if (focused) return;
    const current = text === "" || text === "." ? 0 : Number(text);
    if (current !== value) setText(value === 0 ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

  return (
    <Input
      {...props}
      inputMode="decimal"
      className={className}
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "" || /^\d*\.?\d*$/.test(v)) {
          setText(v);
          onValueChange(v === "" || v === "." ? 0 : Number(v));
        }
      }}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
    />
  );
}
