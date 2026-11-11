import Link from "next/link";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { translator } from "@/lib/i18n";
import { currentLangFor, signedInProfile } from "@/lib/current-lang";
import { isStaffRole } from "@/lib/actions/perms";
import { visitHome } from "@/lib/appointments/visit-home";
import type { Lang } from "@/lib/locale";

/**
 * THERE IS NO VISIT TO SHOW, SAID INSIDE THE APP (cn-v1157; skeptic #60).
 *
 * The visit's page answers notFound() when its row is not there to read. With no boundary of its own
 * that went up to the app's ROOT 404: no dock, no top bar, one door to My Day. And it is reachable by
 * an ordinary Back. Deleting a visit from its own page replaces the open SHEET's history entry with
 * the list (appointment-button `remove`); the visit's own entry is still under it, so one Back from
 * the list asks for the deleted visit. A boundary in this folder keeps the (app) layout around the
 * answer: the shell stays, and the way out is the place a visit lives.
 *
 * WHO IS LOOKING DECIDES WHAT IS TRUE (lib/appointments/visit-home, the same rule the page's own way
 * out uses). The office reads every visit of the company, so for the office it is gone: deleted, or
 * never there. Its doors are the two places a visit lives, Inspections and the Schedule (the page
 * cannot say which this one was: the row that knew is gone). A tech reads only the visits assigned to
 * them (0227) and has neither of those doors: the visit may simply not be theirs, and their way out is
 * My Day. A role that cannot be read gets the office's page; its two doors send a tech to My Day anyway.
 *
 * A server component with no props (Next hands a not-found boundary none), so it asks who is looking
 * itself: one getUser, then the profile row the layout already read for this request (cached).
 */
async function viewer(): Promise<{ lang: Lang; staff: boolean }> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { lang: "en", staff: true };
    const [lang, profile] = await Promise.all([currentLangFor(user.id), signedInProfile(user.id)]);
    const role = (profile.data as { role?: string | null } | null)?.role;
    return { lang, staff: role ? isStaffRole(role) : true };
  } catch {
    return { lang: "en", staff: true };
  }
}

export default async function VisitNotFound() {
  const { lang, staff } = await viewer();
  const t = translator(lang);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center" data-testid="visit-not-found">
      <p className="text-sm text-slate-600">{t(staff ? "vp_visitGone" : "vp_visitGoneTech")}</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {staff ? (
          <>
            <Link href={visitHome("inspection").href}>
              <Button>{t("vp_btn_backToInspections")}</Button>
            </Link>
            <Link href={visitHome(null).href}>
              <Button variant="outline">{t("vp_btn_backToSchedule")}</Button>
            </Link>
          </>
        ) : (
          <Link href={visitHome(null, { staff: false }).href}>
            <Button variant="outline">{t("vp_btn_backToMyDay")}</Button>
          </Link>
        )}
      </div>
    </div>
  );
}
