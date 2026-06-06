import { ScanLine } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export default function PlansPage() {
  return (
    <ComingSoon
      title="Plans & LiDAR"
      description="Scan plans, capture sites, generate sketches."
      icon={ScanLine}
      planned={[
        "Upload and mark up electrical plans (PDF / images)",
        "LiDAR room scans from a phone/tablet",
        "AI sketch generation with parameters → work order",
        "Auto material take-off from a marked-up plan",
      ]}
    />
  );
}
