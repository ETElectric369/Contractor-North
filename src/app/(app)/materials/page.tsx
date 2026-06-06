import { ListChecks } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export default function MaterialsPage() {
  return (
    <ComingSoon
      title="Material Lists"
      description="Generate and manage material take-offs."
      icon={ListChecks}
      planned={[
        "AI-generated material lists from a scope or sketch",
        "Attach lists to jobs and work orders",
        "Roll a list straight into a purchase order",
        "CED part-number lookup and live pricing",
      ]}
    />
  );
}
