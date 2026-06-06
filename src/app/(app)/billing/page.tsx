import { Receipt } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export default function BillingPage() {
  return (
    <ComingSoon
      title="Billing"
      description="Invoicing and payments."
      icon={Receipt}
      planned={[
        "Convert accepted quotes into invoices",
        "Progress billing and retainage for larger jobs",
        "Online payments (Stripe) and payment tracking",
        "QuickBooks / accounting integration",
      ]}
    />
  );
}
