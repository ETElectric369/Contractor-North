"use client";

import { useEffect, useState } from "react";
import { useLang } from "@/components/lang-provider";
import { translator, fillText } from "@/lib/i18n";
import { sayElapsed } from "@/lib/leads/lead-clock";

/**
 * THE RUNNING CLOCK SINCE AN ESTIMATE WENT OUT (cn-v1172), the Leads list's clock (lib/leads/lead-clock)
 * in the Closing page's own words. The first draw uses the server's now (`nowMs`), so the server's
 * HTML and the phone's first paint say the same thing; after mount it reads the phone's clock and
 * ticks once a minute. Plain slate: waiting is not a deadline.
 */
export function ClosingClock({ since, nowMs }: { since: string; nowMs: number }) {
  const t = translator(useLang());
  const [now, setNow] = useState(nowMs);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const said = sayElapsed(since, now, {
    minutes: t("cl_clockMinutes"),
    hoursMinutes: t("cl_clockHoursMinutes"),
    daysHours: t("cl_clockDaysHours"),
  });
  if (!said) return null;
  return (
    <span data-clock="" className="whitespace-nowrap font-mono text-xs tabular-nums text-slate-500" aria-label={fillText(t("cl_clockLabel"), { time: said })}>
      {said}
    </span>
  );
}
