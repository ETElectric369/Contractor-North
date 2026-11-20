"use client";

import { useEffect, useState } from "react";
import { useLang } from "@/components/lang-provider";
import { translator, fillText } from "@/lib/i18n";
import { sayElapsed } from "@/lib/leads/lead-clock";

/**
 * THE RUNNING CLOCK SINCE A LEAD ARRIVED (cn-v1170; lib/leads/lead-clock). The first draw uses the
 * server's now (`nowMs`), so the server's HTML and the phone's first paint say the same thing; after
 * mount it reads the phone's clock and ticks once a minute. Plain slate: no threshold was set.
 */
export function LeadClock({ since, nowMs }: { since: string; nowMs: number }) {
  const t = translator(useLang());
  const [now, setNow] = useState(nowMs);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const said = sayElapsed(since, now, {
    minutes: t("ld_clockMinutes"),
    hoursMinutes: t("ld_clockHoursMinutes"),
    daysHours: t("ld_clockDaysHours"),
  });
  if (!said) return null;
  return (
    <span className="whitespace-nowrap font-mono text-xs tabular-nums text-slate-500" aria-label={fillText(t("ld_clockLabel"), { time: said })}>
      {said}
    </span>
  );
}
