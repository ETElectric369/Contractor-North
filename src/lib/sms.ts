import "server-only";
import { reportError } from "@/lib/observe";
import { getOrgSettings } from "@/lib/org-settings";
import { pickSmsSender, smsE164, smsReadinessFrom, type SmsEnv, type SmsReadiness } from "@/lib/sms-readiness";

/**
 * Twilio's To/From must be E.164 (org-settings.ts documents sms_from_number that way), but the
 * automation settings form saved whatever was typed after a .trim() and customer phones are
 * stored human-formatted — "(530) 555-1234" reached Twilio verbatim and came back as a 21212/21211
 * rejection wearing the "add your Twilio account" message (audit v921). Normalized at the send
 * boundary by the one reader lib/sms-readiness owns (smsE164), so readiness and the sender agree.
 */
const e164 = smsE164;

/** Twilio auth: prefer a scoped, revocable API Key (TWILIO_API_KEY_SID +
 *  TWILIO_API_KEY_SECRET) over the full-access account Auth Token. The request URL
 *  always uses the Account SID regardless of which credential authenticates. */
function twilioAuth(): { sid: string; user: string; pass: string } | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!sid) return null;
  if (keySid && keySecret) return { sid, user: keySid, pass: keySecret };
  if (authToken) return { sid, user: sid, pass: authToken };
  return null;
}

/** What this server holds for texting, as presence only (never a value). */
export function smsEnv(): SmsEnv {
  return {
    account: !!twilioAuth(),
    messagingService: !!process.env.TWILIO_MESSAGING_SERVICE_SID,
    platformNumber: !!process.env.TWILIO_FROM_NUMBER,
  };
}

/**
 * CAN THIS ORG TEXT (lib/sms-readiness)? Every door that texts asks this first, with the org row
 * it already holds (name + settings), and says so where the person tapped when it can't.
 */
export function smsReadiness(org: { name?: string | null; settings?: unknown } | null | undefined): SmsReadiness {
  return smsReadinessFrom({
    env: smsEnv(),
    orgNumber: getOrgSettings(org?.settings).sms_from_number,
    orgName: org?.name ?? null,
  });
}

/**
 * Send an SMS via Twilio. Returns false (not sent) when Twilio isn't configured
 * or the number is missing, so callers stay safe before setup.
 *
 * Sender resolution, in order:
 *   1. `fromOverride` — a per-org number (each org texts under its OWN registered number).
 *   2. `TWILIO_MESSAGING_SERVICE_SID` — send through the A2P-registered Messaging Service (the
 *      US 10DLC-compliant path: sticky sender, opt-out handling, campaign association). PREFERRED.
 *   3. `TWILIO_FROM_NUMBER` — a bare long code (pre-A2P / non-US fallback).
 */
export async function sendSms(
  to: string | null | undefined,
  body: string,
  fromOverride?: string | null,
): Promise<boolean> {
  if (!to) return false;
  const auth = twilioAuth();
  const override = fromOverride && fromOverride.trim();
  const msgServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  // A business number that doesn't read as a phone number ("530-555", "n/a") is passed over for
  // the platform's sender (pickSmsSender), never sent as typed for the texting service to refuse
  // every time. It is flagged, because it is the setup mistake this class of failure comes from
  // and it must not sit invisible; the Texting card says the same thing to the owner.
  if (override && !e164(override)) {
    reportError("sms:from", new Error(`Text-from number "${override}" isn't in +1XXXXXXXXXX form (Settings, Customers, Texting)`), { from: override });
  }
  // The SAME rule smsReadiness answers with (lib/sms-readiness pickSmsSender): a usable per-org
  // number wins; otherwise the Messaging Service; a bare from-number only when there is no service.
  const sender = pickSmsSender(smsEnv(), override);
  if (!auth || !sender) {
    // Every door asks smsReadiness before it gets here, so this is the backstop, not the message.
    return false;
  }
  const from = sender === "org_number" ? override : sender === "platform_number" ? process.env.TWILIO_FROM_NUMBER : null;
  // The platform's bare number is read the same way; one we can't normalize is sent as set (the
  // texting service is the judge) and flagged.
  const fromE164 = from ? e164(from) : null;
  if (from && !fromE164) {
    reportError("sms:from", new Error(`The platform's text-from number isn't in +1XXXXXXXXXX form`), {});
  }
  const fromParam = fromE164 ?? from;

  // Same for To: normalized when it's a US shape we recognize, sent as typed otherwise.
  const params = new URLSearchParams({ To: e164(to) ?? to, Body: body });
  if (fromParam) params.set("From", fromParam);
  else params.set("MessagingServiceSid", msgServiceSid as string);

  let res: Response;
  try {
    res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${auth.sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      },
    );
  } catch (e) {
    // A dropped connection is a text that did not go, said the same way as a refusal: a throw
    // here used to end a whole cron run, so one bad minute skipped every org after this one.
    reportError("sms", e, { to, from: fromParam ?? null });
    return false;
  }
  if (!res.ok) {
    // A Twilio REJECTION (21211 bad To, 21212 bad From, 21610 opted out, 30007 filtered) went to
    // console only, so it never reached error_events and every caller rendered the "add your
    // Twilio account" copy on an account that IS set up (audit v921). Same false either way for
    // now — the callers' one-line result type is theirs to widen — but the real reason is logged.
    const detail = await res.text();
    reportError("sms", new Error(`Twilio ${res.status}: ${detail.slice(0, 300)}`), { to, from: fromParam ?? null });
    return false;
  }
  return true;
}
