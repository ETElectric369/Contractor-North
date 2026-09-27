import { Suspense } from "react";
import { FeatureOffLine } from "@/components/feature-off-line";
import { viewerSwitches } from "@/lib/viewer-switches";
import type { FeatureKey } from "@/lib/features";

/**
 * THE OFF LINE ON A RECORD PAGE THAT READS NO SWITCHES ITSELF (a PO, a work order, the insurance
 * list). The page opens from its link exactly as it did; this streams in on top (Suspense), so the
 * page never waits on the read, and it renders nothing at all while the feature is on.
 * A page that already has the switches in hand renders <FeatureOffLine> with them instead.
 */
export function FeatureOffLineFor({ feature, className }: { feature: FeatureKey; className?: string }) {
  return (
    <Suspense fallback={null}>
      <OffLineRead feature={feature} className={className} />
    </Suspense>
  );
}

async function OffLineRead({ feature, className }: { feature: FeatureKey; className?: string }) {
  const { features, isOwner } = await viewerSwitches();
  return <FeatureOffLine feature={feature} features={features} isOwner={isOwner} className={className} />;
}
