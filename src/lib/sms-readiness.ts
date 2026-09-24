/**
 * CAN THIS ORG TEXT? ONE ANSWER, FOR EVERY DOOR (2026-09-24).
 *
 * Erik: "Wait in texting but be ready for it's setup". Production has no texting sender yet (no
 * messaging service, no platform number) and ET Electric has no number of its own, yet Settings
 * showed "Text timeclock reminders" ticked and the Text buttons asked "Text this invoice to Nora?"
 * before failing. That is the onboarding-truth problem: a ticked box that does nothing.
 *
 * So every door that texts asks THIS, before it promises anything:
 *   - Settings shows each text option as not active, with one line, until this says ready, and a
 *     Texting card lists what is missing in plain words (never a key or a variable name).
 *   - the Text buttons on invoices and estimates refuse up front, where the person tapped, and
 *     point at the doors that do work (email, text from your own phone).
 *   - the timeclock crons and the long-shift job skip their texts and count the skip.
 *
 * And the sender itself (lib/sms.ts sendSms) picks its From by the same rule, so "ready" here and
 * "a text would go out" there can never disagree. When the pieces exist, every door texts with no
 * code change.
 *
 * Pure: it is handed what the environment holds (as presence, never values) and the org's own
 * number, so it runs in tests and in a client component's props without a secret crossing over.
 *
 * The sender rule, in sendSms's order:
 *   1. the org's own number (Settings, Customers, Texting), when it reads as a phone number: each
 *      org texts under its own brand;
 *   2. the platform's messaging service (the registered US path);
 *   3. the platform's bare number (the pre-registration fallback).
 * Any one of them, plus the texting account itself, is ready.
 */

/** What the server's environment holds, as presence only. */
export type SmsEnv = {
  /** The texting account and a credential for it. */
  account: boolean;
  /** The platform's registered messaging service. */
  messagingService: boolean;
  /** The platform's bare sending number. */
  platformNumber: boolean;
};

export type SmsSender = "org_number" | "messaging_service" | "platform_number";

export type SmsReadiness =
  | { ready: true; sender: SmsSender }
  | {
      ready: false;
      /** What is missing, in words the owner reads: "A texting number for ET Electric". */
      missing: string[];
    };

/** The one line every text option shows while texting is not set up. */
export const TEXTS_NOT_READY_LINE = "Texts start once texting is set up.";

/** Where the owner goes to see what is missing. */
export const TEXTING_CARD_PLACE = "Settings, Customers, Texting";

/** The refusal a door gives when somebody taps Text before texting is set up. It says nothing was
 *  sent and names the doors that do work, so it is never a dead end. */
export const TEXT_NOT_READY_REFUSAL =
  `Texting isn't set up yet, so nothing was texted. Email it, or text the link from your own phone. ${TEXTING_CARD_PLACE} shows what's missing.`;

/** The refusal when texting IS set up and the texting service still did not take the message. */
export const TEXT_REFUSED =
  "The texting service didn't take this one, so nothing was texted. It has been logged. Email it, or text the link from your own phone.";

/**
 * A phone number in the form the texting service takes (E.164), or null when it isn't one we can
 * vouch for. Customer phones are stored human-formatted and the business's own number is typed by
 * hand, so the US shapes are normalized: "(530) 555-1234" reads as "+15305551234". Pure, so the
 * readiness answer, the sender and the Settings card all read a number the same way.
 */
export function smsE164(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

/** How the business's own number should be written, said to the owner. */
export const SMS_NUMBER_EXAMPLE = "+15305551234";

/**
 * Which sender a text would go out from, or null when there is none. The same rule sendSms uses.
 * The business's own number counts only when it reads as a phone number: something typed like
 * "530-555" or "n/a" would be refused by the texting service on every send, so it is passed over
 * for the platform's sender (and the Texting card says the number isn't usable).
 */
export function pickSmsSender(env: SmsEnv, orgNumber: string | null | undefined): SmsSender | null {
  if (!env.account) return null;
  if (smsE164(orgNumber)) return "org_number";
  if (env.messagingService) return "messaging_service";
  if (env.platformNumber) return "platform_number";
  return null;
}

/**
 * Ready, or the missing pieces in plain words. `orgName` names the number the org is missing
 * ("A texting number for ET Electric"); an org with no name reads "your business".
 */
export function smsReadinessFrom(input: { env: SmsEnv; orgNumber?: string | null; orgName?: string | null }): SmsReadiness {
  const sender = pickSmsSender(input.env, input.orgNumber);
  if (sender) return { ready: true, sender };
  const missing: string[] = [];
  if (!input.env.account) missing.push("A texting account for the app");
  const who = (input.orgName ?? "").trim() || "your business";
  const typed = !!(input.orgNumber ?? "").trim();
  const usable = !!smsE164(input.orgNumber);
  const hasSomeSender = usable || input.env.messagingService || input.env.platformNumber;
  if (!hasSomeSender) {
    missing.push(
      typed
        ? `A valid texting number for ${who}, written like ${SMS_NUMBER_EXAMPLE}`
        : `A texting number for ${who}`,
    );
  }
  return { ready: false, missing };
}
