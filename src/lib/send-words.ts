import { money } from "@/lib/email";
import type { SendChannel } from "@/lib/send-review";

/**
 * THE DEFAULT WORDS OF A DOCUMENT'S SEND (cn-v1155). The review sheet opens with the words the app
 * WOULD send, and the send itself falls back to the very same words when the owner changed nothing,
 * so both read them from here and can never drift: an estimate's subject and paragraph, its text,
 * a contract's message, the portal link's message. Plain text, English (the customer reads English
 * whatever the owner's language). No I/O and no catalog.
 */

/** "Estimate 1042 from Larkspur Electric": the email subject for a quote or an estimate. */
export function quoteSubject(label: string, number: string, orgName?: string | null): string {
  return `${label} ${number} from ${orgName ?? "us"}`;
}

/** The paragraph the estimate's email carries by default, as the plain text the owner may edit. */
export function quoteEmailBody(p: { docType: string; number: string; title?: string | null; total: number }): string {
  return `Your ${p.docType.toLowerCase()} ${p.number}${p.title ? ` — ${p.title}` : ""} is ready. Total: ${money(p.total)}.`;
}

/** The fixed part of the estimate's email, shown read-only: the button and where it goes. */
export function quoteEmailTail(docType: string, link: string): string {
  return `View & accept ${docType.toLowerCase()}: ${link}`;
}

/** The words of the estimate's text before the link. The text is these, a space, then the tail. */
export function quoteSmsBody(p: { orgName?: string | null; docType: string; number: string; total: number }): string {
  return `${p.orgName ?? "Your contractor"}: ${p.docType} ${p.number} ($${Number(p.total).toFixed(2)}).`;
}

/** The estimate's text tail: the link part, exactly as it is appended after the owner's words. */
export function quoteSmsTail(link: string): string {
  return `View: ${link}`;
}

/** The contract email's subject. */
export function contractSubject(number: string | null | undefined, orgName?: string | null): string {
  return `Contract ${number ?? ""} from ${orgName ?? "us"}`;
}

/** The contract email's default message (the heading and the button around it are fixed). */
export function contractEmailBody(number: string | null | undefined): string {
  return `Please review contract ${number ?? ""} and sign it online. If anything looks off, just reply to this email.`;
}

/** The contract email's fixed part: the button and where it goes. */
export function contractEmailTail(link: string): string {
  return `Review & sign: ${link}`;
}

/** The portal email's subject. */
export function portalSubject(orgName?: string | null): string {
  return `Your ${orgName ?? "customer"} portal`.trim();
}

/** The portal email's default message: the 6-digit-code sentences are the default body. */
export const PORTAL_EMAIL_BODY =
  "Here's your private link to your jobs: the work and payments day by day, your picks and photos, and your invoices, contracts and quotes. It's up to date every time you open it. The first time you open it on a phone or computer, we'll email you a 6-digit code to sign in; no password to remember. Bookmark it for easy access.";

/** The portal email's fixed part: the button and where it goes. */
export function portalEmailTail(link: string): string {
  return `Open my portal: ${link}`;
}

/** The catalog key (sn_) that says why checkSendMessage refused what the sheet sent. */
export function sendWhyKey(why: "to" | "subject" | "body" | "length", channel: SendChannel): string {
  if (why === "to") return channel === "email" ? "sn_badEmail" : "sn_badPhone";
  if (why === "subject") return "sn_badSubject";
  if (why === "length") return "sn_tooLong";
  return "sn_badBody";
}
