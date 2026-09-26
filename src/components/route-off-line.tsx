"use client";

import { usePathname } from "next/navigation";
import { FeatureOffLine } from "@/components/feature-off-line";
import { featureForPath } from "@/lib/feature-doors";
import type { FeatureMap } from "@/lib/features";

/**
 * THE OFF LINE ON A PAGE OPENED BY LINK (rule a). Mounted once in the app shell, beside the
 * section strip: when the page belongs to a switched-off feature (lib/feature-doors
 * FEATURE_ROUTES), the shared Off line sits on top and the page renders underneath exactly as it
 * would. Its dock row is gone; the record isn't. Renders nothing on every other page, and on every
 * page while the feature is on.
 */
export function RouteOffLine({ features, isOwner }: { features: FeatureMap; isOwner: boolean }) {
  const feature = featureForPath(usePathname() ?? "");
  if (!feature) return null;
  return <FeatureOffLine feature={feature} features={features} isOwner={isOwner} />;
}
