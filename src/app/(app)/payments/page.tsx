import { redirect } from "next/navigation";

/**
 * PAYMENTS LIVE ON INVOICES NOW (W1-29): who owes you, and what came in, on one page. Its Payments
 * In fold holds the ledger (every payment, newest first) and Get Paid… for a check that arrives
 * without its bill. An old link or a bookmark lands there, open.
 */
export default function PaymentsRedirect() {
  redirect("/billing?open=payments");
}
