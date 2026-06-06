import { redirect } from "next/navigation";
import { Zap } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createOrganization } from "./actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Already in an org? Skip onboarding.
  const { data: profile } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.org_id) redirect("/dashboard");

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand to-brand-dark px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
            <Zap className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Welcome to Contractor North</h1>
          <p className="mt-1 text-sm text-white/80">Let's set up your company.</p>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-xl">
          <h2 className="mb-1 text-lg font-semibold text-slate-900">
            Create your company
          </h2>
          <p className="mb-6 text-sm text-slate-500">
            This creates your workspace. You'll be the owner and can invite your
            crew next.
          </p>

          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <form action={createOrganization} className="space-y-4">
            <div>
              <Label htmlFor="name">Company name</Label>
              <Input
                id="name"
                name="name"
                required
                autoFocus
                placeholder="e.g. North Star Electric"
              />
            </div>
            <Button type="submit" size="lg" className="w-full">
              Create company & continue
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-white/60">
          Service · Integrity · Reliability
        </p>
      </div>
    </div>
  );
}
