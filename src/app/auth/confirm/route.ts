import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safe-next";
import { endSessionIfDeactivated } from "@/lib/deactivation-gate";
import { translator } from "@/lib/i18n";
import { langBeforeSession } from "@/lib/request-lang";

/**
 * THE TOKEN-HASH DOOR (cn-v1134): where a one-time link made on the server lands.
 *
 * /auth/callback exchanges a PKCE `code` — the shape of a link the person asked for from their own
 * browser (a reset email, a magic link), where the verifier cookie was written. A link MADE BY THE
 * SERVER (the crew import's auth.admin.generateLink) has no verifier: its action_link comes back as
 * the implicit flow, with the session in the URL fragment no server route can read. So it carries
 * the token HASH here instead, and the hash is verified server-side (verifyOtp), which writes the
 * session cookies the same way the callback does. Recovery links only: that is the one kind the app
 * makes this way, and the door stays as narrow as what walks through it.
 *
 * A hash is consumed when it is verified and expires on the project's email-OTP clock, so a used or
 * expired link lands on the login page with the way out said in words, never a dead end. A
 * deactivated account gets no session from here either (the one deactivation gate).
 *
 * TWO STEPS: GET shows a page with one button; the POST behind it verifies. Link previewers fetch
 * the GET and never press the button, so the token lives until the person's own tap.
 *
 * IN THE PERSON'S LANGUAGE (cn-v1138): no session exists yet, so the words are the link's `?lang=`
 * (the crew import stamps an es row's link) or, without one, the phone's Accept-Language
 * (lib/request-lang). The page carries its language into the POST as a hidden field, so the
 * refusals the tap can meet read the same as the page did. The used-or-expired sentence is
 * au_linkUsed; the deactivation sentence au_deactivated (lib/deactivation-gate's one sentence).
 */

/** A value into an HTML attribute, with the five characters that would end or change it escaped. */
const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * GET IS A PAGE, NOT THE VERIFY (cn-v1134 fixer, skeptic #40). An office texts these links, and iMessage,
 * Slack and mail scanners FETCH a link to preview it before the person taps — a GET that verified the
 * hash burned the one-time token on the preview, and the person's own tap then read "already used".
 * So GET only shows one button; the POST it makes is the verify. The page is never cached (no-store)
 * and never indexed. A link with no hash, or not a recovery link, goes straight to the login page.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const lang = langBeforeSession(searchParams.get("lang"), request.headers.get("accept-language"));
  const t = translator(lang);
  // Same-app relative paths only (safeNextPath): an absolute ?next= would be an open redirect.
  const next = safeNextPath(searchParams.get("next")) ?? "/set-password";
  if (!tokenHash || type !== "recovery") {
    return NextResponse.redirect(`${origin}/login?mode=code&error=${encodeURIComponent(t("au_linkUsed"))}`);
  }
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${t("au_setMyPassword")}</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; }
  main { width: 100%; max-width: 24rem; margin: 1rem; padding: 1.5rem; background: #fff; border: 1px solid #e2e8f0; border-radius: 1rem; box-shadow: 0 1px 2px rgb(0 0 0 / 0.05); }
  p { margin: 0 0 1rem; font-size: 0.95rem; color: #475569; }
  button { width: 100%; padding: 0.75rem 1rem; font: inherit; font-weight: 600; color: #fff; background: #0f172a; border: 0; border-radius: 0.75rem; }
</style>
</head>
<body>
<main>
  <p>${t("au_tapToSet")}</p>
  <form method="post" action="/auth/confirm">
    <input type="hidden" name="token_hash" value="${attr(tokenHash)}">
    <input type="hidden" name="type" value="recovery">
    <input type="hidden" name="next" value="${attr(next)}">
    <input type="hidden" name="lang" value="${lang}">
    <button type="submit">${t("au_setMyPassword")}</button>
  </form>
</main>
</body>
</html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/**
 * THE VERIFY, on the person's own tap: verifyOtp (recovery) on the SSR server client writes the session
 * cookies the way /auth/callback does; a deactivated account gets no session (the one gate); then
 * /set-password, or the same-app path the link asked for. A used or expired hash lands on the login
 * page with ONE way out said: sign in with a code (the office cannot re-issue a link today). 303, so the
 * browser GETs the next page instead of re-posting the form.
 */
export async function POST(request: Request) {
  const { origin } = new URL(request.url);
  const form = await request.formData().catch(() => null);
  const field = (k: string) => {
    const v = form?.get(k);
    return typeof v === "string" ? v : null;
  };
  const tokenHash = field("token_hash");
  const type = field("type");
  const next = safeNextPath(field("next")) ?? "/set-password";
  // The language the page showed (its hidden field), else the phone's: the refusals read as the page did.
  const t = translator(langBeforeSession(field("lang"), request.headers.get("accept-language")));

  if (tokenHash && type === "recovery") {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
    if (!error) {
      if (await endSessionIfDeactivated(supabase)) {
        return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(t("au_deactivated"))}`, 303);
      }
      return NextResponse.redirect(`${origin}${next}`, 303);
    }
  }
  return NextResponse.redirect(`${origin}/login?mode=code&error=${encodeURIComponent(t("au_linkUsed"))}`, 303);
}
