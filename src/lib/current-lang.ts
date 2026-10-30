import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { PROFILE_SAFE_COLS } from "@/lib/profile-columns";
import { asLang, type Lang } from "@/lib/locale";

/**
 * THE SIGNED-IN PERSON'S LANGUAGE, ONCE PER REQUEST (cn-v1139). profiles.language is the one
 * source of truth (lib/i18n); this is the server component's door to it. Both readers are wrapped
 * in React cache(), so however many components of one request ask — the (app) layout for the
 * shell, an office page for its title — the profile is read ONCE:
 *
 *   signedInProfile(userId)   the one profiles read (PROFILE_SAFE_COLS, .single()). The (app)
 *                             layout reads its profile through it, so a page that asks for the
 *                             language in the same request costs no second profile query.
 *   currentLangFor(userId)    that row's language, for a caller that already has the person's id.
 *   currentLang()             the same for a caller that does not: getUser, then the cached row.
 *
 * A failed read is ENGLISH, never a throw: a missing session, a refused or errored profile read,
 * an exception — the page renders in English rather than not at all (the same rule as lib/lang-of
 * callerLang). Server-only: it opens the request's Supabase client and reads cookies.
 *
 * HOW AN OFFICE PAGE USES IT (the map in Spanish; the page's contents stay English for now). Nearly
 * every office page has already resolved the session for its own role check, so it hands the id
 * over and the language costs NO second auth call — the normal door:
 *
 *   import { translator } from "@/lib/i18n";
 *   import { currentLangFor } from "@/lib/current-lang";
 *   …
 *   const { data: { user } } = await supabase.auth.getUser();   // the page's own, for its role
 *   const t = translator(await currentLangFor(user?.id));
 *   <PageHeader title={t("nv_page_leads")} description={t("nv_desc_leads")} />
 *
 * A page with no id in scope (it never asks who is signed in: /tools, /leads, /crm, /price-list,
 * /tax-report, /petty-cash, /recurring, /organize, /quotes/new; /billing resolves its user only
 * inside a later Promise.all) uses the no-id door, which is one getUser then the same cached row:
 *
 *   const t = translator(await currentLang());
 *
 * The keys live in lib/words/nav.ts (nv_page_<slug> / nv_desc_<slug>); PageHeader itself is
 * unchanged and knows no language.
 */

/** The signed-in person's profile row, read once per request however many callers ask. */
export const signedInProfile = cache(async (userId: string) => {
  const supabase = await createClient();
  return supabase.from("profiles").select(PROFILE_SAFE_COLS).eq("id", userId).single();
});

/** The language on that row, for a caller that already resolved the session; "en" on any failure,
 *  and "en" with no read at all when the caller has nobody (a nullable `user?.id`). */
export const currentLangFor = cache(async (userId: string | null | undefined): Promise<Lang> => {
  if (!userId) return "en";
  try {
    const { data, error } = await signedInProfile(userId);
    if (error || !data) return "en";
    return asLang((data as { language?: unknown }).language);
  } catch {
    return "en";
  }
});

/** The signed-in person's language; "en" when there is nobody or the read fails. */
export const currentLang = cache(async (): Promise<Lang> => {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return "en";
    return currentLangFor(user.id);
  } catch {
    return "en";
  }
});
