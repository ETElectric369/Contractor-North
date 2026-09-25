import "server-only";
import { renderPortalCodeEmail, sendEmail } from "@/lib/email";
import { accentHex } from "@/lib/org-settings";
import { CODE_TTL_MINUTES, type CodeChannel } from "./code-words";

/**
 * Send a portal sign-in code (0331). `to` is what portal_code_issue read off the customer's row;
 * nothing typed on the page ever reaches here.
 *
 * From the platform sender (EMAIL_FROM) with the business's name on it, replies to the business.
 * NEVER a bcc to the owner ("copy me on emails"): a copied code is a second person who can sign in
 * as the customer.
 *
 * THE SMS SEAM. When texting is live, the 'sms' branch sends the same words through the texting
 * provider, and 0331's portal_code_issue reads the customer's phone for it. Until then it refuses
 * out loud.
 */
export async function deliverPortalCode(input: {
  channel: CodeChannel;
  to: string;
  code: string;
  org: { name: string; phone?: string | null; email?: string | null; glass_tint?: string | null };
}): Promise<{ ok: boolean; error?: string }> {
  if (input.channel === "sms") return { ok: false, error: "Texting codes isn't set up yet." };
  const name = input.org.name || "Your contractor";
  const html = renderPortalCodeEmail({
    company: { name, brand: accentHex(input.org.glass_tint ?? undefined), phone: input.org.phone, email: input.org.email },
    code: input.code,
    minutes: CODE_TTL_MINUTES,
  });
  return sendEmail({
    to: input.to,
    subject: `Your ${name} code`,
    fromName: name,
    html,
    replyTo: input.org.email ?? undefined,
  });
}
