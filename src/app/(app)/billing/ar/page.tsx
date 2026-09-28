import { redirect } from "next/navigation";

/**
 * ACCOUNTS RECEIVABLE LIVES ON INVOICES NOW (W1-29): what is owed and how late sits at the top of
 * /billing, each late row carries its "N Days Late", and the By Customer fold is the old page's
 * per-customer roll-up, built from the same open invoices. An old link lands there, the fold open.
 */
export default function AccountsReceivableRedirect() {
  redirect("/billing?open=customers");
}
