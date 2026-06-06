import { Boxes } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export default function InventoryPage() {
  return (
    <ComingSoon
      title="Inventory"
      description="Truck stock and warehouse inventory."
      icon={Boxes}
      planned={[
        "Track stock by location (warehouse, each truck)",
        "Deduct materials as they're used on work orders",
        "Low-stock alerts and reorder points",
        "Barcode / part-number lookup",
      ]}
    />
  );
}
