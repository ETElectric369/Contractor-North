import "server-only";

/** True when Twilio is configured. */
export function smsConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM_NUMBER,
  );
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
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    console.log(`[sms] (Twilio not configured) would text ${to}: ${body}`);
    return false;
  }

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
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
