import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import type { Profile } from "@/lib/types";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  // No organization yet → finish onboarding before entering the app.
  if (!profile?.org_id) redirect("/onboarding");

  // Apply the org's brand color across the app shell (white-label).
  const { data: org } = await supabase
    .from("organizations")
    .select("brand_color")
    .eq("id", profile.org_id)
    .maybeSingle();
  const brand = org?.brand_color || "#0b57c4";

  return (
    <div
      className="flex h-screen overflow-hidden"
      style={
        {
          "--color-brand": brand,
          "--color-brand-dark": brand,
        } as React.CSSProperties
      }
    >

      <div className="hidden lg:block">
        <Sidebar />
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar profile={(profile as Profile) ?? null} />
        <main className="flex-1 overflow-y-auto bg-slate-50 p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
