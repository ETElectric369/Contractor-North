import { ShoppingCart } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export default function PurchasingPage() {
  return (
    <ComingSoon
      title="Purchasing"
      description="Purchase orders and CED ordering."
      icon={ShoppingCart}
      planned={[
        "Create purchase orders from job material lists",
        "Send POs to CED and track order status",
        "Match received items against POs",
        "Per-job and per-vendor spend reporting",
      ]}
    />
  );
}
