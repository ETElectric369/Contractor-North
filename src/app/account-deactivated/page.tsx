import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { PurgePageCache } from "@/components/purge-page-cache";
import { NO_INDEX } from "@/lib/no-index";
import { Ban } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * "Back to Sign In" is a SERVER ACTION, not a link, because this is the only place the session
 * cookie can actually be removed. The signOut() below ends the session at GoTrue, but its cookie
 * removal is swallowed on the way out — lib/supabase/server.ts wraps setAll in try/catch because
 * a Server Component cannot write cookies — so the device kept an sb-*-auth-token whose JWT was
 * still signature-valid until exp. A POST can delete them, and does (audit v921). Same deletion
 * the login/actions.ts signOut performs.
 */
async function leaveDeactivated() {
  "use server";
  const store = await cookies();
  for (const c of store.getAll()) {
    if (/^sb-.*-auth-token(\.\d+)?$/.test(c.name)) store.delete(c.name);
  }
  revalidatePath("/", "layout");
  redirect("/login");
}

/**
 * The DEACTIVATED screen. The app layout redirects here the moment a signed-in profile
 * has active===false — a deactivated member is now actually locked OUT (before, active
 * only hid them from assignee pickers; they could still sign in and use the app).
 *
 * We end the session here rather than in the layout: signing out mid-layout-render would
 * fight the layout's own redirect. Reversible — an owner/admin flipping them back to
 * active lets them sign in again immediately. Never reached by the owner (the lifecycle
 * actions refuse to deactivate the owner or yourself).
 */
export default async function AccountDeactivatedPage() {
  // Kill the session so a deactivated user can't linger on any cached (app) route. This revokes
  // it at GoTrue (global, on purpose — offboarding); the COOKIE goes on the button below, which
  // is the only place a write to the response is allowed (audit v921).
  const supabase = await createClient();
  await supabase.auth.signOut();

  return (
    <>
      {/* THE session ends on THIS screen (signOut above), and it is the one moment we KNOW the
          removed person is still online. Without this their cached pages — a whole org's customers,
          jobs and money — stay readable on their phone after they've been let go. */}
      <PurgePageCache />
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
          <Ban className="h-6 w-6" />
        </div>
        <h1 className="text-lg font-semibold text-slate-900">Account deactivated</h1>
        <p className="mt-1 text-sm text-slate-500">
          Your access to this account has been turned off. If you think this is a mistake, contact
          your company&apos;s office — they can reactivate you.
        </p>
        <form action={leaveDeactivated} className="mt-5">
          <button
            type="submit"
            className="inline-flex w-full items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-dark"
          >
            Back to Sign In
          </button>
        </form>
      </div>
    </div>
    </>
  );
}

// Never index auth/utility chrome — on a tenant's custom domain this page previously leaked a
// "Contractor North" title into crawlers with no noindex (the SEO vendor's "hosted on
// contractornorth" ammunition). Both layers per the no-index doctrine: this metadata + robots.txt.
export const metadata = { title: "Account deactivated", robots: NO_INDEX };
