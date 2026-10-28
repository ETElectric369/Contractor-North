import Link from "next/link";
import { headers } from "next/headers";
import { shellFromUserAgent } from "@/lib/native-shell";
import { NO_INDEX } from "@/lib/no-index";
import { fillText, translator } from "@/lib/i18n";
import { langFromAcceptLanguage } from "@/lib/request-lang";
import { login, signup, sendLoginCode, verifyLoginCode } from "./actions";
import { APP_VERSION } from "@/lib/version";
import { FormSubmit } from "@/components/form-submit";
import { Input, Label } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { PurgePageCache } from "@/components/purge-page-cache";

/** Nobody is signed in here, so the words are the phone's (cn-v1138): the Accept-Language header's first tag. */
async function pageLang() {
  return langFromAcceptLanguage((await headers()).get("accept-language"));
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; mode?: string; email?: string; sent?: string; next?: string }>;
}) {
  const { error, message, mode, email, sent, next } = await searchParams;
  const h = await headers();
  // Inside the native shell there is no signup door: accounts come from an org's invite (0125), and
  // the app must not offer account creation to Apple's reviewer (4.2 / 3.1.1). Web keeps it.
  const inShell = shellFromUserAgent(h.get("user-agent")).native;
  // The same header the actions read (login/actions.ts), so the page's words and the errors it shows agree.
  const t = translator(langFromAcceptLanguage(h.get("accept-language")));
  const isSignup = mode === "signup" && !inShell;
  const isCode = mode === "code";
  const codeSent = isCode && sent === "1";
  // Collaborator invite links arrive as /login?mode=signup&email=…&next=/content — keep `next`
  // alive across the mode toggles and pass it into the form (the action validates it).
  const withNext = (href: string) =>
    next ? `${href}${href.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}` : href;

  const heading = isSignup ? t("au_createYourAccount") : isCode ? t("au_signInWithCodeHeading") : t("au_signInHeading");
  const sub = isSignup
    ? t("au_setUpSub")
    : isCode
      ? codeSent
        ? t("au_enterCodeSub")
        : t("au_noPasswordSub")
      : t("au_welcomeBack");

  return (
    <>
      {/* Nobody is signed in on this screen, so the offline page cache — which holds rendered
          org data — gets cleared here. A handed-down crew phone can't be paged back into. */}
      <PurgePageCache />
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand to-brand-dark px-4 pt-[var(--sat,0px)]">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center text-white">
          {/* The tile IS the app icon — Erik's white-rose-on-black export, one asset shared with
              the home screen and the dock (the iOS tinted-mode lesson: the mark must be the
              bright thing on a dark ground). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon-192.png" alt={t("au_appName")} className="mx-auto mb-3 h-16 w-16 rounded-2xl shadow-lg ring-1 ring-white/15" />
          <h1 className="text-2xl font-bold tracking-tight">{t("au_appName")}</h1>
          <p className="mt-1 text-sm text-white/80">{t("au_tagline")}</p>
          <p className="mt-2 text-[11px] font-medium tracking-wider text-white/40">{APP_VERSION}</p>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-xl">
          <h2 className="mb-1 text-lg font-semibold text-slate-900">{heading}</h2>
          <p className="mb-6 text-sm text-slate-500">{sub}</p>

          {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
          {message && <div className="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">{message}</div>}

          {isCode ? (
            codeSent ? (
              // ── Enter the 6-digit code ──
              <form className="space-y-4">
                <input type="hidden" name="email" value={email ?? ""} />
                <div>
                  <Label htmlFor="code">{t("au_codeLabel")}</Label>
                  <Input
                    id="code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="123456"
                    required
                    autoFocus
                    className="text-center text-2xl tracking-[0.4em]"
                  />
                  <p className="mt-1 text-xs text-slate-400">{fillText(t("au_sentTo"), { email: email ?? "" })}</p>
                </div>
                <FormSubmit className="w-full" size="lg" formAction={verifyLoginCode}>
                  {t("au_verifySignIn")}
                </FormSubmit>
                <div className="flex items-center justify-between text-xs">
                  <button formAction={sendLoginCode} formNoValidate className="font-medium text-brand hover:underline">
                    {t("au_resendCode")}
                  </button>
                  <Link href="/login" className="text-slate-500 hover:underline">{t("au_usePassword")}</Link>
                </div>
              </form>
            ) : (
              // ── Request a code ──
              <form className="space-y-4">
                <div>
                  <Label htmlFor="email">{t("au_email")}</Label>
                  <Input id="email" name="email" type="email" autoComplete="username" placeholder={t("au_emailPlaceholder")} defaultValue={email ?? ""} required autoFocus />
                </div>
                <FormSubmit className="w-full" size="lg" formAction={sendLoginCode}>
                  {t("au_emailMeCode")}
                </FormSubmit>
                <p className="text-center text-xs">
                  <Link href="/login" className="text-slate-500 hover:underline">{t("au_usePassword")}</Link>
                </p>
              </form>
            )
          ) : (
            // ── Password login / signup ──
            <form className="space-y-4">
              {next && <input type="hidden" name="next" value={next} />}
              {isSignup && (
                <div>
                  <Label htmlFor="full_name">{t("au_fullName")}</Label>
                  <Input id="full_name" name="full_name" placeholder={t("au_fullNamePlaceholder")} required />
                </div>
              )}
              <div>
                <Label htmlFor="email">{t("au_email")}</Label>
                <Input id="email" name="email" type="email" autoComplete="username" placeholder={t("au_emailPlaceholder")} defaultValue={email ?? ""} required />
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <Label htmlFor="password" className="mb-0">{t("au_password")}</Label>
                  {!isSignup && <Link href="/forgot" className="text-xs font-medium text-brand hover:underline">{t("au_forgotPassword")}</Link>}
                </div>
                <PasswordInput id="password" name="password" autoComplete={isSignup ? "new-password" : "current-password"} placeholder="••••••••" required minLength={6} />
              </div>

              <FormSubmit className="w-full" size="lg" formAction={isSignup ? signup : login}>
                {isSignup ? t("au_createAccount") : t("au_signIn")}
              </FormSubmit>

              {!isSignup && (
                <p className="text-center text-xs">
                  <Link href="/login?mode=code" className="font-medium text-brand hover:underline">
                    {t("au_signInWithCode")}
                  </Link>
                </p>
              )}
            </form>
          )}

          <p className="mt-6 text-center text-sm text-slate-500">
            {inShell && mode === "signup" ? (
              // An invite link opened INSIDE the shell: say why there's no create-account form here
              // instead of silently showing Sign in (NOTHING SILENT / NO DEAD ENDS).
              <>{t("au_shellSignupNote")}</>
            ) : inShell ? (
              <>{t("au_shellInviteNote")}</>
            ) : isSignup ? (
              <>{t("au_alreadyHave")} <Link href={withNext("/login")} className="font-medium text-brand hover:underline">{t("au_signIn")}</Link></>
            ) : (
              <>{t("au_needAccount")} <Link href={withNext("/login?mode=signup")} className="font-medium text-brand hover:underline">{t("au_signUp")}</Link></>
            )}
          </p>
        </div>

      </div>
    </div>
    </>
  );
}

// Never index auth/utility chrome — on a tenant's custom domain this page previously leaked a
// "Contractor North" title into crawlers with no noindex (the SEO vendor's "hosted on
// contractornorth" ammunition). Both layers per the no-index doctrine: this metadata + robots.txt.
// A function, not a constant (cn-v1138): the tab's title is in the phone's language like the page.
export async function generateMetadata() {
  return { title: translator(await pageLang())("au_teamLogin"), robots: NO_INDEX };
}
