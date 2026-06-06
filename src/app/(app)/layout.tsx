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

  return (
    <div className="flex h-screen overflow-hidden">
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
