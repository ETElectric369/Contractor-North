import { say, type Words } from "@/lib/lang-words";

/**
 * The words a pay door uses when the bill it would collect on is still a draft - shared by the
 * server refusal and the sheet that asks, so the two never say different things.
 *
 * The English is inline and the default (the server refusal, lib/pay-door-send, says it as it always
 * has); handed the reader's `lang` and translator (lib/i18n translator(lang)) it says the Settle Up
 * catalog's words (lib/words/settle-up su_sendFirstQuestion / su_sendFirstCard / su_sendFirstPayment),
 * the way the agenda's libraries do (lib/lang-words say) — this file imports no catalog.
 */

/** "Send INV-078 as the bill first?" */
export function sendFirstQuestion(invoiceNumber: string | null | undefined, lang?: string | null, words?: Words): string {
  const doc = invoiceNumber || say(lang, words, "su_thisInvoice", "this invoice");
  return say(lang, words, "su_sendFirstQuestion", `Send ${doc} as the bill first?`, { doc });
}

/** What sending does, said before the yes. `what`: a card being taken, or a payment that pays the
 *  whole draft (a draft never reads as paid, so it goes out as the bill first). */
export function sendFirstDetail(invoiceNumber: string | null | undefined, what: "card" | "payment" = "card", lang?: string | null, words?: Words): string {
  const doc = invoiceNumber || say(lang, words, "su_thisInvoiceCap", "This invoice");
  return what === "card"
    ? say(
        lang,
        words,
        "su_sendFirstCard",
        `${doc} is still a draft, so there's no bill to pay yet. Sending records it as sent today, then the card can be taken. Nothing is emailed or texted.`,
        { doc },
      )
    : say(
        lang,
        words,
        "su_sendFirstPayment",
        `${doc} is still a draft, and this pays all of it. A draft never reads as paid, so sending records it as sent today, then the payment goes on it. Nothing is emailed or texted.`,
        { doc },
      );
}
