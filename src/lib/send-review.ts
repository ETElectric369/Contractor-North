import { smsE164 } from "@/lib/sms-readiness";

/**
 * THE REVIEW SHEET'S RULES (cn-v1155, "review before anything goes out"). Every email and text the
 * app sends for a document opens first for the owner to read and, if he wants, change. What he may
 * change is the address, the subject and the message; the part that carries the link (the button,
 * "View and pay: <link>") is fixed and shown to him read-only. This file holds the pure half: the
 * shapes the sheet and the server share, the limits, and the check the server runs on whatever the
 * sheet sent back. No I/O and no words catalog (a lib never imports one): the sheet's sentences are
 * lib/words/send, and the server turns a refusal's `why` into a sentence.
 */

export type SendKind = "invoice" | "receipt" | "quote" | "contract" | "portal";
export type SendChannel = "email" | "sms";

/** What the sheet sends back. Every field is optional: an absent one keeps the server's default. */
export type SendMessage = { to?: string; subject?: string; body?: string; copyMe?: boolean };

/** What the server hands the sheet for one send: the prefilled English words, the fixed tail, and who
 *  the customer is. `body` and `smsBody` are the words the owner may edit; `tail` is shown read-only. */
export type SendPreview = {
  kind: SendKind;
  id: string;
  customerName: string | null;
  to: string | null;
  phone: string | null;
  subject: string;
  body: string;
  smsBody: string;
  tail: { email: string; sms: string };
  copyMe: boolean;
  copyTo: string | null;
  textReady: boolean;
  viewerLang: "en" | "es";
  /** The company's Send Without Review switch, read by the server: on, the sheet is the old one-tap
   *  Email It / Text It with nothing to edit. */
  reviewOff: boolean;
};

/** What the preview door answers: the words to review, or the sentence that says why there are none. */
export type PreviewResult = { ok: true; preview: SendPreview } | { ok: false; error: string };

export const SUBJECT_MAX = 200;
export const BODY_MAX = 4000;
/** The most a whole text may run to: the carriers' concatenated limit, and the texting service's. */
export const SMS_TOTAL_MAX = 1600;
export const SMS_SEGMENT = 160;

/** One address: no spaces (so no header break), no list separators, one @, a dot in the domain. The
 *  same shape the app's other email checks use. */
const ONE_EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export type SendCheck =
  | { ok: true; message: SendMessage }
  | { ok: false; why: "to" | "subject" | "body" | "length" };

/**
 * Trim and check what the sheet sent. An ABSENT field passes (the server keeps its own); a field
 * that is present must be good, and a box the owner emptied is a hole, not a request for the
 * default. For a text the address comes back as E.164, the form the texting service takes.
 * `tailLength` is the length of the fixed part, which goes out after the owner's words.
 */
export function checkSendMessage(m: SendMessage | undefined, channel: SendChannel, tailLength: number): SendCheck {
  const out: SendMessage = {};
  if (!m) return { ok: true, message: out };

  if (m.to !== undefined) {
    const to = String(m.to).trim();
    if (channel === "email") {
      if (!ONE_EMAIL.test(to)) return { ok: false, why: "to" };
      out.to = to;
    } else {
      if ((to.match(/\d/g) ?? []).length < 10) return { ok: false, why: "to" };
      const e164 = smsE164(to);
      if (!e164) return { ok: false, why: "to" };
      out.to = e164;
    }
  }

  if (m.subject !== undefined) {
    const subject = String(m.subject).trim();
    if (!subject || subject.length > SUBJECT_MAX || /[\r\n]/.test(subject)) return { ok: false, why: "subject" };
    out.subject = subject;
  }

  if (m.body !== undefined) {
    const body = String(m.body).trim();
    if (!body) return { ok: false, why: "body" };
    if (channel === "email") {
      if (body.length > BODY_MAX) return { ok: false, why: "body" };
    } else if (body.length + 1 + Math.max(0, tailLength) > SMS_TOTAL_MAX) {
      return { ok: false, why: "length" };
    }
    out.body = body;
  }

  if (m.copyMe !== undefined) out.copyMe = m.copyMe === true;
  return { ok: true, message: out };
}

/** How long the whole text is (the owner's words, a space, the fixed tail) and how many texts that
 *  makes on the customer's phone. At least one. */
export function smsCount(body: string, tailLength: number): { chars: number; texts: number } {
  const chars = body.length + 1 + Math.max(0, tailLength);
  return { chars, texts: Math.max(1, Math.ceil(chars / SMS_SEGMENT)) };
}

/** Where "Copy Me" goes: the sender's own address, else the company's, else nowhere. */
export function copyMeAddress(profileEmail: string | null | undefined, orgEmail: string | null | undefined): string | null {
  const own = (profileEmail ?? "").trim();
  if (own) return own;
  const org = (orgEmail ?? "").trim();
  return org || null;
}

/** Plain text to paragraphs: split on blank lines, trim each, drop the empty ones. */
export function plainToParagraphs(text: string): string[] {
  return String(text ?? "")
    .split(/\r?\n[ \t]*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
