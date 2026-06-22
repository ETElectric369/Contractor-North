import "server-only";

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

/** True when Twilio is configured (a credential pair + a from-number). */
export function smsConfigured(): boolean {
  return Boolean(twilioAuth() && process.env.TWILIO_FROM_NUMBER);
}

/**
 * Send an SMS via Twilio. Returns false (not sent) when Twilio isn't configured
 * or the number is missing, so callers stay safe before setup.
 */
export async function sendSms(
  to: string | null | undefined,
  body: string,
): Promise<boolean> {
  if (!to) return false;
  const auth = twilioAuth();
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!auth || !from) {
    console.log(`[sms] (Twilio not configured) would text ${to}: ${body}`);
    return false;
  }

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${auth.sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    },
  );
  if (!res.ok) {
    console.error(`[sms] Twilio error ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}
