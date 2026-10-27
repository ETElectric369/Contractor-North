/**
 * NEVER A SECRET IN AN ANSWER (cn-v1129, the keys-health door): a vendor's refusal may echo back
 * part of what it was sent (Stripe's "Invalid API Key provided: sk_…", Twilio's requested path
 * with the account SID in it). Every configured value whose NAME looks like a secret — KEY,
 * SECRET, TOKEN, PASSWORD, P8, SID — and is eight characters or longer is replaced wherever it
 * appears. Derived from the environment itself, so a key added later is covered without a list.
 */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|P8|SID/i;

export function scrubSecrets(s: string): string {
  let out = s;
  for (const [name, value] of Object.entries(process.env)) {
    if (SECRET_NAME.test(name) && value && value.length >= 8 && out.includes(value)) out = out.split(value).join("•••");
  }
  return out;
}
