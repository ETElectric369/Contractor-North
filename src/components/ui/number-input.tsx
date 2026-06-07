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

  // Sync when the value changes from the outside (e.g. AI fills the field),
  // but don't clobber what the user is mid-typing.
  React.useEffect(() => {
    const current = text === "" || text === "." ? 0 : Number(text);
    if (current !== value) setText(value === 0 ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <Input
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
      {...props}
    />
  );
}
