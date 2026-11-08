"use client";

import * as React from "react";
import { Input } from "./input";

/**
 * A number field that's pleasant to type in:
 *  - shows blank (not "0") when the value is 0, so there's nothing to delete first
 *  - lets you type decimals freely ("1.", "0.5") without the value fighting you
 *  - still reports a real number up to the parent via onValueChange
 *
 * A BLANK BOX IS NOT A ZERO where the caller needs the difference (skeptic #56b: the invoice's Price
 * box asks when it is blank, and a 0 typed on purpose is a no-charge line). A number can't carry it,
 * so `value` may be null — a blank from the outside, which clears a typed "0" where 0 would leave it —
 * and onValueChange says, beside the figure, whether the box is in fact blank. Every caller that
 * passes a number and reads one argument is untouched.
 */
export function NumberInput({
  value,
  onValueChange,
  className,
  ref,
  ...props
}: {
  /** The figure; 0 shows blank. null is a blank box, for a caller that tells a blank from a typed 0. */
  value: number | null;
  /** The figure typed (0 for a blank box), and whether the box is blank ("" or a lone "."). */
  onValueChange: (n: number, blank: boolean) => void;
  /** The <input> itself, for a caller that puts the cursor in it (the Price box, when it is asked for). */
  ref?: React.Ref<HTMLInputElement>;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const [text, setText] = React.useState(value === 0 || value === null ? "" : String(value));
  const [focused, setFocused] = React.useState(false);

  // Sync when the value changes from the outside (e.g. AI fills the field), but
  // NEVER while the field is focused — re-deriving `text` from `value` during
  // typing rewrites the input and yanks the caret to the start (the "type 1, see
  // 11 with the cursor on the left" bug). On blur we re-sync to normalise (e.g.
  // "1." → "1"). While focused, what the user types is the single source.
  React.useEffect(() => {
    if (focused) return;
    if (value === null) {
      // A blank from the outside: the box empties even when it reads "0", which a 0 would leave.
      if (text !== "") setText("");
      return;
    }
    const current = text === "" || text === "." ? 0 : Number(text);
    if (current !== value) setText(value === 0 ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

  return (
    <Input
      {...props}
      ref={ref}
      inputMode="decimal"
      className={className}
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "" || /^\d*\.?\d*$/.test(v)) {
          setText(v);
          const blank = v === "" || v === ".";
          onValueChange(blank ? 0 : Number(v), blank);
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
