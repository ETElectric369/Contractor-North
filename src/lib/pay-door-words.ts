/**
 * The words a pay door uses when the bill it would collect on is still a draft - shared by the
 * server refusal and the sheet that asks, so the two never say different things.
 */

/** "Send INV-078 as the bill first?" */
export function sendFirstQuestion(invoiceNumber: string | null | undefined): string {
  return `Send ${invoiceNumber || "this invoice"} as the bill first?`;
}

/** What sending does, said before the yes. */
export function sendFirstDetail(invoiceNumber: string | null | undefined): string {
  const doc = invoiceNumber || "This invoice";
  return `${doc} is still a draft, so there's no bill to pay yet. Sending records it as sent today, then the card can be taken. Nothing is emailed or texted.`;
}
