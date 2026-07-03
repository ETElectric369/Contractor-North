import Link from "next/link";
import { Ban } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

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
  // Kill the session so a deactivated user can't linger on any cached (app) route.
  const supabase = await createClient();
  await supabase.auth.signOut();

  return (
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
        <Link
          href="/login"
          className="mt-5 inline-flex w-full items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-dark"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
