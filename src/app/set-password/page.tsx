import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SetPasswordForm } from "./set-password-form";

export const dynamic = "force-dynamic";

export default async function SetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Choose your password</h1>
        <p className="mt-1 text-sm text-slate-500">
          You signed in with a temporary password. Pick your own to keep your account secure — you&apos;ll use it from now on.
        </p>
        <div className="mt-5">
          <SetPasswordForm />
        </div>
      </div>
    </div>
  );
}
