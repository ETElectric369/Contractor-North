"use client";

import { Select } from "./input";

const STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
];

/** US state dropdown (2-letter codes). Accepts any pre-existing value. */
export function StateSelect({
  id,
  name,
  value,
  onChange,
}: {
  id?: string;
  name?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const extra = value && !STATES.includes(value.toUpperCase()) ? [value] : [];
  return (
    <Select id={id} name={name} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {extra.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
      {STATES.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </Select>
  );
}
