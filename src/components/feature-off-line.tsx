"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { setFeature } from "@/app/(app)/settings/features-actions";
import { FEATURE_BY_KEY, featureOn, type FeatureKey, type FeatureMap } from "@/lib/features";

/**
 * THE OFF LINE (the switch board, 0352). A record in a switched-off feature still opens from a link
 * or a search, and this sits on top of it saying so. It renders nothing while the feature is on.
 *
 *   the owner:      "<Feature> · Off" with a Turn On button (turns on the switch, and its parent if
 *                   that is what's off, then refreshes the page).
 *   everyone else:  "<Feature> · Off · Ask The Owner", no button: only the owner can turn a switch
 *                   on (set_org_feature), and a button that can't work for this person is a dead door.
 *
 * Usage: <FeatureOffLine feature="panel_map" features={settings.features} isOwner={role === "owner"} />
 */
export function FeatureOffLine({
  feature,
  features,
  isOwner,
  className = "",
}: {
  feature: FeatureKey;
  /** The company's switches (getOrgSettings(...).features). */
  features: FeatureMap;
  isOwner: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (featureOn(features, feature)) return null;

  const def = FEATURE_BY_KEY[feature];
  // What has to move for this feature to read on: its parent when that is off, then itself.
  const toTurnOn = [def.parent, feature].filter((k): k is FeatureKey => !!k && features[k] !== true);

  function turnOn() {
    setError(null);
    start(async () => {
      for (const k of toTurnOn) {
        const res = await setFeature(k, true);
        if (!res.ok) {
          setError(res.error);
          return;
        }
      }
      router.refresh();
    });
  }

  return (
    <div
      role="status"
      className={`mb-3 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-600 ${className}`}
    >
      <span>
        <span className="font-medium text-slate-800">{def.label}</span> · Off
        {!isOwner && <> · Ask The Owner</>}
      </span>
      {isOwner && (
        <Button type="button" variant="outline" onClick={turnOn} disabled={pending} className="ml-auto">
          {pending ? "Turning On…" : "Turn On"}
        </Button>
      )}
      {error && <span className="w-full text-xs text-red-700">{error}</span>}
    </div>
  );
}
