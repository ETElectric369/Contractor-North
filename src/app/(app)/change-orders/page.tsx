import { GitPullRequestArrow } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export default function ChangeOrdersPage() {
  return (
    <ComingSoon
      title="Change Orders"
      description="Track and approve scope changes."
      icon={GitPullRequestArrow}
      planned={[
        "Create change orders against a job or work order",
        "Customer e-signature approval flow",
        "Automatic adjustment to job totals and billing",
        "Change-order history and audit trail",
      ]}
    />
  );
}
