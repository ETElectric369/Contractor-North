/**
 * The words a pay door uses when the bill it would collect on is still a draft - shared by the
 * server refusal and the sheet that asks, so the two never say different things.
 */

/** "Send INV-078 as the bill first?" */
export function sendFirstQuestion(invoiceNumber: string | null | undefined): string {
  return `Send ${invoiceNumber || "this invoice"} as the bill first?`;
}

/** What sending does, said before the yes. `what`: a card being taken, or a payment that pays the
 *  whole draft (a draft never reads as paid, so it goes out as the bill first). */
export function sendFirstDetail(invoiceNumber: string | null | undefined, what: "card" | "payment" = "card"): string {
  const doc = invoiceNumber || "This invoice";
  return what === "card"
    ? `${doc} is still a draft, so there's no bill to pay yet. Sending records it as sent today, then the card can be taken. Nothing is emailed or texted.`
    : `${doc} is still a draft, and this pays all of it. A draft never reads as paid, so sending records it as sent today, then the payment goes on it. Nothing is emailed or texted.`;
}
