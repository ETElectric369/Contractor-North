"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { appleMapsWorksHere, mapsProviderHere, MAPS_PROVIDER_KEY, type MapsProvider } from "@/lib/maps";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";

/**
 * Per-device preference for which maps app the "Navigate" links open. Saved in localStorage (read by
 * <NavLink>), so each person/device chooses their own.
 *
 * THE CARD SAYS WHAT THIS DEVICE DOES (cn-v1185). It used to draw Apple Maps as chosen on a device
 * that had chosen nothing, and to offer Apple Maps on an Android phone, where it cannot navigate (a
 * tech's report: "Apple maps does not work on my phone"). Now: nothing is drawn as chosen until
 * something is; and where there is no Apple Maps the card offers no choice and says the one thing
 * that is true there. Its sentences follow the person's language (the shell catalog); the two apps
 * keep their names.
 */
export function MapsProviderToggle() {
  const t = translator(useLang());
  const [provider, setProvider] = useState<MapsProvider | null>(null); // null = nothing chosen yet
  const [appleWorks, setAppleWorks] = useState(true);
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(MAPS_PROVIDER_KEY);
    } catch {}
    setAppleWorks(appleMapsWorksHere(navigator.userAgent));
    setProvider(mapsProviderHere(stored, navigator.userAgent));
  }, []);
  function choose(p: MapsProvider) {
    setProvider(p);
    try {
      localStorage.setItem(MAPS_PROVIDER_KEY, p);
    } catch {}
  }
  if (!appleWorks) return <p className="text-sm text-slate-500">{t("sh_mapsGoogleOnly")}</p>;
  const opts: { value: MapsProvider; label: string }[] = [
    { value: "apple", label: t("sh_btn_appleMaps") },
    { value: "google", label: t("sh_btn_googleMaps") },
  ];
  return (
    <div>
      <p className="mb-3 text-sm text-slate-500">{t("sh_mapsWhich")}</p>
      <div className="flex gap-2">
        {opts.map((o) => {
          const active = provider === o.value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => choose(o.value)}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${
                active ? "seaglass-active border-transparent" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {active && <Check className="relative z-10 h-4 w-4 shrink-0" />} <span className="relative z-10">{o.label}</span>
            </button>
          );
        })}
      </div>
      {provider === null && <p className="mt-2 text-xs text-slate-400">{t("sh_mapsNotChosen")}</p>}
    </div>
  );
}
