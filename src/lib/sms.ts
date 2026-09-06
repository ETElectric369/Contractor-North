import "server-only";
import { reportError } from "@/lib/observe";

/**
 * Twilio's To/From must be E.164 (org-settings.ts documents sms_from_number that way), but the
 * automation settings form saves whatever was typed after a .trim() and customer phones are
 * stored human-formatted — "(530) 555-1234" reached Twilio verbatim and came back as a 21212/21211
 * rejection wearing the "add your Twilio account" message (audit v921). Normalize the US shapes
 * here, at the send boundary. Returns null when it isn't a number we can vouch for.
 */
function e164(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

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
  // A per-org number wins; otherwise the Messaging Service is the default sender (fall back to a
  // bare from-number only when no Messaging Service is set).
  const from = override || (msgServiceSid ? null : process.env.TWILIO_FROM_NUMBER);
  if (!auth || (!from && !msgServiceSid)) {
    console.log(`[sms] (Twilio not configured) would text ${to}: ${body}`);
    return false;
  }
  // The org's own number goes out in E.164; anything we can't read that way (a short code, an
  // alphanumeric sender id, an international number) is still sent as typed — Twilio is the judge
  // — but it's flagged, because a "(530) 555-1234" in Settings → Automation is the setup mistake
  // this whole class of failure comes from and it must not sit invisible.
  const fromE164 = from ? e164(from) : null;
  if (from && !fromE164) {
    reportError("sms:from", new Error(`Text-from number "${from}" isn't in +1XXXXXXXXXX form — Settings → Automation`), { from });
  }
  const fromParam = fromE164 ?? from;

  // Same for To: normalized when it's a US shape we recognize, sent as typed otherwise.
  const params = new URLSearchParams({ To: e164(to) ?? to, Body: body });
  if (fromParam) params.set("From", fromParam);
  else params.set("MessagingServiceSid", msgServiceSid!);

  const res = await fetch(
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
