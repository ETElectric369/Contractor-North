import { redirect } from "next/navigation";

// Purchase orders live in Bills' one list (All Bills, W1-32), each a row with a PO chip; a PO's own
// page is still /purchasing/[id]. The old list URL lands there with the orders first (?tab=po).
export default function PurchasingIndexRedirect() {
  redirect("/bills?tab=po");
}
