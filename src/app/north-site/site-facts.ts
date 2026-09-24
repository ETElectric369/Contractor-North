/**
 * The facts Contractor North's own pages state about who runs it and how to reach them, in ONE
 * place, so the home page, /support and /privacy can never disagree.
 *
 * PLACEHOLDERS UNTIL POSTING (Erik, 2026-09-24):
 * - SUPPORT_EMAIL: contractornorth.com can SEND mail (Resend) but nothing RECEIVES it yet (no apex
 *   MX). The address goes live when Erik adds the domain to his Google Workspace and creates the
 *   mailbox. Do not turn on PLATFORM_SITE_POSTED (lib/platform-site) or attach the apex before
 *   that, or every "write to us" on these pages bounces.
 * - OPERATOR: Erik is enrolled with Apple as an individual (sole proprietor). When the fictitious
 *   business name or the LLC exists, this line and the App Store seller name change together.
 * - PRIVACY_EFFECTIVE_DATE: null renders a visible placeholder. Set it to the day the page is posted.
 */

export const SUPPORT_EMAIL = "support@contractornorth.com";

export const OPERATOR_NAME = "Erik Taylor";
export const OPERATOR_LINE = "Contractor North is operated by Erik Taylor (sole proprietor), Chilcoot, California.";

/** e.g. "October 1, 2026". null until the day the page is posted. */
export const PRIVACY_EFFECTIVE_DATE: string | null = null;

export const SITE_ORIGIN = "https://contractornorth.com";

export function mailto(subject: string): string {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}
