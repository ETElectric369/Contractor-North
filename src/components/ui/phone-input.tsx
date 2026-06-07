"use client";

import * as React from "react";
import { Input } from "./input";
import { formatPhone } from "@/lib/utils";

/** Phone field that formats to "(530) 933-6686" as you type. Submits via name. */
export function PhoneInput({
  defaultValue,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const [value, setValue] = React.useState(formatPhone(String(defaultValue ?? "")));
  return (
    <Input
      type="tel"
      inputMode="tel"
      value={value}
      onChange={(e) => setValue(formatPhone(e.target.value))}
      {...props}
    />
  );
}
