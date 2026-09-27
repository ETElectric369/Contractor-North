"use client";

import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Label } from "@/components/ui/input";

/**
 * THE PERIOD PICKER AND THE DOWNLOAD NAME THE SAME PERIOD.
 *
 * Picking a period opens it (no second button to forget), and while it opens the download waits:
 * the button never hands over last period's file while the picker already shows the new one. The
 * page mounts the picker under its period's key, so a Month / Quarter / Year tap that changes the
 * period also resets what the picker shows.
 */
type Scope = { opening: string | null; open: (key: string, label: string) => void };
const PeriodScope = createContext<Scope>({ opening: null, open: () => {} });

export function AccountantPeriodScope({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [label, setLabel] = useState<string | null>(null);
  const open = (key: string, l: string) => {
    setLabel(l);
    start(() => router.push(`/analytics/accountant?${new URLSearchParams({ period: key }).toString()}`));
  };
  return <PeriodScope.Provider value={{ opening: pending ? label : null, open }}>{children}</PeriodScope.Provider>;
}

/** The period being opened (its label) while the page catches up, else null. */
export function useOpeningPeriod(): string | null {
  return useContext(PeriodScope).opening;
}

export function AccountantPeriodPicker({ current, choices, kindLabel }: { current: string; choices: { key: string; label: string }[]; kindLabel: string }) {
  const { open } = useContext(PeriodScope);
  const [value, setValue] = useState(current);
  return (
    <div className="min-w-0 flex-1">
      <Label htmlFor="acct-period">Which {kindLabel}</Label>
      <select
        id="acct-period"
        value={value}
        onChange={(e) => {
          const key = e.target.value;
          setValue(key);
          open(key, choices.find((c) => c.key === key)?.label ?? key);
        }}
        className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
      >
        {choices.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
    </div>
  );
}
