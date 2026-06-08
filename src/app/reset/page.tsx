import { redirect } from "next/navigation";
import { Zap } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { updatePassword } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";

export const dynamic = "force-dynamic";

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Reach here via the email link (which created a recovery session). If there's
  // no session, the link is invalid/expired.
  if (!user) redirect("/forgot?error=Reset link expired. Request a new one.");

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand to-brand-dark px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
            <Zap className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Set a new password</h1>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-xl">
          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <form action={updatePassword} className="space-y-4">
            <div>
              <Label htmlFor="password">New password</Label>
              <PasswordInput id="password" name="password" placeholder="••••••••" required minLength={6} />
            </div>
            <Button type="submit" size="lg" className="w-full">
              Update password
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
