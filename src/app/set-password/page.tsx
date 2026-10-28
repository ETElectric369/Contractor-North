import { cache } from "react";
import { redirect } from "next/navigation";
import { NO_INDEX } from "@/lib/no-index";
import { createClient } from "@/lib/supabase/server";
import { callerLang } from "@/lib/lang-of";
import { translator } from "@/lib/i18n";
import { LangProvider } from "@/components/lang-provider";
import { SetPasswordForm } from "./set-password-form";

export const dynamic = "force-dynamic";

/** A session exists here (the one-time link, or the shell's must-reset bounce, made it), so the
 *  profile is the one source of truth: callerLang, read once per request for the page and its title. */
const pageLang = cache(async () => callerLang(await createClient()));

export default async function SetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const lang = await pageLang();
  const t = translator(lang);

  return (
    <LangProvider lang={lang}>
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">{t("au_chooseYourPassword")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("au_chooseSub")}</p>
          <div className="mt-5">
            <SetPasswordForm />
          </div>
        </div>
      </div>
    </LangProvider>
  );
}

// Never index auth/utility chrome — on a tenant's custom domain this page previously leaked a
// "Contractor North" title into crawlers with no noindex (the SEO vendor's "hosted on
// contractornorth" ammunition). Both layers per the no-index doctrine: this metadata + robots.txt.
// A function, not a constant (cn-v1138): the tab's title is in the person's language like the page.
export async function generateMetadata() {
  return { title: translator(await pageLang())("au_setYourPassword"), robots: NO_INDEX };
}
