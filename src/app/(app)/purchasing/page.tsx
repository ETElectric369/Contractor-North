import { redirect } from "next/navigation";

// Purchasing is consolidated under Bills & Purchasing. Individual PO pages
// still live at /purchasing/[id]; the old list URL now points there.
export default function PurchasingIndexRedirect() {
  redirect("/bills");
}
