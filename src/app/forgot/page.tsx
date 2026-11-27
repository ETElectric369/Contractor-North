import Link from "next/link";
import { headers } from "next/headers";
import { NO_INDEX } from "@/lib/no-index";
import { requestPasswordReset } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { translator } from "@/lib/i18n";
import { langFromAcceptLanguage } from "@/lib/request-lang";

export const dynamic = "force-dynamic";

/** Nobody is signed in here, so the page speaks the phone's language: the same header read as the
 *  login page and as the action this form posts to (login/actions.ts), so page and answer agree. */
async function pageLang() {
  return langFromAcceptLanguage((await headers()).get("accept-language"));
}

export default async function ForgotPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { error, message } = await searchParams;
  const t = translator(await pageLang());
  // ONE PAGE FOR THE BROWSER AND THE PHONE APP (cn-v1200). Until cn-v1199 the emailed reset link
  // carried a PKCE code that only the browser which asked for it could exchange, so in the phone
  // app this page hid the form, pointed at the code door, said the link could not finish in the
  // phone's browser, and named a password door in Settings that a person does not have. The link
  // is now the app's own (lib/auth-mail: a token hash, verified on the person's own tap at
  // /auth/confirm), and it finishes in ANY browser: the phone hands it to its browser, the person
  // sets the password there and signs in to the app with it. So the form is the same everywhere,
  // and the code door stays below it as the second way in.

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand to-brand-dark px-4 pt-[var(--sat,0px)]">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center text-white">
          {/* The tile IS the app icon, the same asset as the login page (cn-v1200: it was a bolt). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon-192.png" alt={t("au_appName")} className="mx-auto mb-3 h-16 w-16 rounded-2xl shadow-lg ring-1 ring-white/15" />
          <h1 className="text-2xl font-bold tracking-tight">{t("au_resetHeading")}</h1>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-xl">
          <p className="mb-6 text-sm text-slate-500">{t("au_resetSub")}</p>

          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {message && (
            <div className="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
              {message}
            </div>
          )}

          <form action={requestPasswordReset} className="space-y-4">
            <div>
              <Label htmlFor="email">{t("au_email")}</Label>
              <Input autoComplete="email" id="email" name="email" type="email" placeholder={t("au_emailPlaceholder")} required />
            </div>
            <Button type="submit" size="lg" className="w-full">
              {t("au_sendResetLink")}
            </Button>
          </form>

          <p className="mt-4 text-center text-sm text-slate-500">
            {t("au_resetNoLink")}{" "}
            <Link href="/login?mode=code" className="font-medium text-brand hover:underline">
              {t("au_signInWithACode")}
            </Link>
          </p>

          <p className="mt-6 text-center text-sm text-slate-500">
            <Link href="/login" className="font-medium text-brand hover:underline">
              {t("au_backToSignIn")}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

// Never index auth/utility chrome — on a tenant's custom domain this page previously leaked a
// "Contractor North" title into crawlers with no noindex (the SEO vendor's "hosted on
// contractornorth" ammunition). Both layers per the no-index doctrine: this metadata + robots.txt.
export async function generateMetadata() {
  return { title: translator(await pageLang())("au_resetHeading"), robots: NO_INDEX };
}
