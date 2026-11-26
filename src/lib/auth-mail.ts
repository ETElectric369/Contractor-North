import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { renderPlatformNoticeEmail, sendEmail } from "@/lib/email";
import { rateLimited } from "@/lib/rate-limit";
import { reportErrorAwaited } from "@/lib/observe";
import { asLang, type Lang } from "@/lib/locale";
import { crewSetupLink } from "@/app/(app)/settings/crew-setup-link";

/**
 * THE APP SENDS ITS OWN SIGN-IN EMAILS (cn-v1199). The login page's Email Me a Code and the
 * password reset used to ask the auth server to send the email, built from the auth host's
 * dashboard: it carried no code and its link landed on the hosting platform's login. Now the app
 * mints the one-time token itself and sends its own email through its own mailer (lib/email).
 *
 * THE MINT IS generateLink type "recovery", ALWAYS, for both emails: the call crew import already
 * makes (settings/actions.ts), which SENDS NOTHING and answers the code (email_otp) and its hash
 * (hashed_token). For an address with no account it answers 404 and writes nothing. "magiclink" and
 * "signup" would CREATE an account for an invited address, so they are never used here.
 *
 * ONE TOKEN, TWO WAYS IN, USED ONCE: the 6-digit code is typed on the login page (verifyLoginCode,
 * type "email", unchanged); the hash rides the button's link to /auth/confirm, verified as
 * "recovery" exactly like a crew setup link. Using either spends both, and a newer email replaces an
 * older one. The sign-in link carries next=/planner and for=signin; the reset link is a crew setup
 * link, next=/set-password.
 *
 * NOTHING HERE TELLS WHO HAS AN ACCOUNT: the doors (login/actions.ts) answer every address the same
 * and run this in after(), so the time taken does not tell either. A deactivated person is sent
 * nothing. The code, the hash, the link and the address never reach the error sink, the console, a
 * bcc or a subject: a failure is filed with its code or status only, and AWAITED, because this runs
 * past the answer and a write not waited for may never leave (lib/observe).
 *
 * The words come from the caller's translator (the au_ catalog): this file imports no catalog.
 */

export type AuthMailKind = "signin" | "reset";
type T = (key: string) => string;

/** Where the sign-in email's button lands once its hash is verified. */
export const SIGN_IN_NEXT = "/planner";

/** The two limits, the same for every address and checked before the mint (lib/rate-limit's rule:
 *  outbound email on a signed-out path fails CLOSED). Shared by both doors: they mint one token.
 *  Per caller 20 an hour: a crew on one shop network shares one address. The refusal (au_tooManyEmails)
 *  says "in an hour", true for both limits. */
export const AUTH_MAIL_LIMITS = {
  perCaller: { limit: 20, windowSeconds: 60 * 60 },
  perMailbox: { limit: 3, windowSeconds: 15 * 60 },
} as const;

/** The mailbox's limiter key: a hash of the lowercased address, so rate_limits never holds an address. */
export function mailboxKey(email: string): string {
  return `auth-mail-to:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
}

/** True when either limit refuses this request (then nothing is minted and nothing is sent). */
export async function authMailRefused(ip: string, email: string): Promise<boolean> {
  const { perCaller, perMailbox } = AUTH_MAIL_LIMITS;
  if (await rateLimited(`auth-mail-ip:${ip}`, perCaller.limit, perCaller.windowSeconds, { failClosed: true })) return true;
  return rateLimited(mailboxKey(email), perMailbox.limit, perMailbox.windowSeconds, { failClosed: true });
}

/** The button's link: a crew setup link (crew-setup-link.ts's rules) for a reset; for a sign-in the
 *  same link landing on My Day, with for=signin so /auth/confirm shows the sign-in words. The link
 *  names the email's language, English too (a crew link names only Spanish), so the confirm page
 *  speaks it on a phone set to the other one. */
export function oneTimeLink(base: string | undefined | null, hashedToken: string | undefined | null, kind: AuthMailKind, lang?: Lang | null): string | null {
  const link = crewSetupLink(base, hashedToken, lang)?.concat(lang === "en" ? "&lang=en" : "") ?? null;
  if (!link || kind === "reset") return link;
  const u = new URL(link);
  u.searchParams.set("next", SIGN_IN_NEXT);
  u.searchParams.set("for", "signin");
  return u.toString();
}

/** The email itself. The sign-in email shows the code large and one Sign In button; the reset email
 *  one Set My Password button and no code. Every value is escaped by renderPlatformNoticeEmail. */
export function renderAuthEmail(t: T, input: { kind: AuthMailKind; code?: string | null; link: string }): { subject: string; html: string } {
  if (input.kind === "signin") {
    const subject = t("au_mail_signInSubject");
    return {
      subject,
      html: renderPlatformNoticeEmail({
        heading: subject,
        code: String(input.code ?? ""),
        message: t("au_mail_signInHow"),
        cta: { label: t("au_signIn"), href: input.link },
        foot: t("au_mail_foot"),
      }),
    };
  }
  const subject = t("au_mail_resetSubject");
  return {
    subject,
    html: renderPlatformNoticeEmail({
      heading: subject,
      message: t("au_mail_resetHow"),
      cta: { label: t("au_setMyPassword"), href: input.link },
      foot: t("au_mail_foot"),
    }),
  };
}

/** An error as the sink may hear it: where, its code and its status; never its message (a message can carry an address). */
function bare(where: string, e: unknown): Error {
  const o = (e ?? {}) as { code?: unknown; status?: unknown };
  return new Error(`${where}${o.code ? ` code=${String(o.code)}` : ""}${o.status ? ` status=${String(o.status)}` : ""}`);
}

/** The mint's answers that mean "no such account" or "not an address": said to nobody. */
const SILENT = new Set(["user_not_found", "validation_failed", "email_address_invalid"]);

/**
 * Mint and send one email. Never throws (it runs in after(), past the answer). An address with no
 * account, or a deactivated person, gets nothing; any other failure, a send that did not go among
 * them, is filed bare and awaited.
 */
export async function mailOneTimeCode(input: {
  kind: AuthMailKind;
  email: string;
  requestLang: Lang;
  translatorFor: (lang: Lang) => T;
}): Promise<void> {
  const where = `auth-mail:${input.kind}`;
  try {
    // No mailer, no mint: an unconfigured sendEmail prints its recipient to the console.
    if (!process.env.RESEND_API_KEY) {
      await reportErrorAwaited(where, new Error(`${where} mail not configured`));
      return;
    }
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email: input.email });
    if (error) {
      const o = error as { code?: unknown; status?: unknown };
      if (o.status === 404 || SILENT.has(String(o.code ?? ""))) return;
      await reportErrorAwaited(where, bare(`${where} generateLink`, error));
      return;
    }
    const userId = data?.user?.id;
    const code = data?.properties?.email_otp;
    const hash = data?.properties?.hashed_token;
    // How LONG the code is belongs to the auth host (its setting: 6 to 10 digits), so nothing here
    // assumes six: the sign-in screen's box takes ten (login/page.tsx) and verifyLoginCode sends
    // what was typed, whole. A code that is not digits could not be typed there, so it is not sent.
    if (!userId || !hash || (input.kind === "signin" && !/^\d{6,10}$/.test(String(code ?? "")))) {
      await reportErrorAwaited(where, new Error(`${where} generateLink answered no usable token`));
      return;
    }
    const { data: me, error: meErr } = await admin.from("profiles").select("active, language").eq("id", userId).maybeSingle();
    if (meErr) {
      await reportErrorAwaited(where, bare(`${where} profile`, meErr));
      return;
    }
    const profile = me as { active?: boolean | null; language?: string | null } | null;
    if (profile?.active === false) return;
    // The person's own language when the profile names one; else the phone's.
    const lang: Lang = profile?.language ? asLang(profile.language) : input.requestLang;
    const link = oneTimeLink(process.env.NEXT_PUBLIC_SITE_URL, hash, input.kind, lang);
    if (!link) {
      await reportErrorAwaited(where, new Error(`${where} no site address to link to`));
      return;
    }
    const mail = renderAuthEmail(input.translatorFor(lang), { kind: input.kind, code, link });
    // No bcc, no fromName, no sent_messages row: a copied code is a second person who can sign in.
    const sent = await sendEmail({ to: input.email, subject: mail.subject, html: mail.html });
    // The send's own text is Resend's and may name the address: the sink hears only that it did not go.
    if (!sent.ok) await reportErrorAwaited(where, new Error(`${where} send failed`));
  } catch (e) {
    await reportErrorAwaited(where, bare(`${where} threw`, e));
  }
}
