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

/** The person's own must_reset_password: true or false as stored, null when it could not be read. */
async function mustResetPassword(supabase: Awaited<ReturnType<typeof createClient>>, id: string): Promise<boolean | null> {
  try {
    const { data, error } = await supabase.from("profiles").select("must_reset_password").eq("id", id).maybeSingle();
    if (error || !data) return null;
    const v = (data as { must_reset_password?: unknown }).must_reset_password;
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}

export default async function SetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  // THIS PAGE SERVES FLAGGED PEOPLE ONLY (cn-v1203). It sets a password without the current one, which
  // only a must_reset_password person may do (the invited, and those who arrived by the reset email,
  // which auth/confirm marks). Anyone else changes theirs at the one door, Settings › You. A failed
  // read shows the form: the action reads the flag again, and it is the rule.
  if ((await mustResetPassword(supabase, user.id)) === false) redirect("/settings?tab=you");
  const lang = await pageLang();
  const t = translator(lang);

  return (
    <LangProvider lang={lang}>
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">{t("au_chooseYourPassword")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("au_chooseSub")}</p>
          <div className="mt-5">
            <SetPasswordForm email={user.email ?? ""} />
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
