import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { initials } from "@/lib/utils";
import { OrgSettingsForm } from "./org-settings-form";
import { InviteManager } from "./invite-manager";
import type { Organization, Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

const roleTone: Record<string, "purple" | "indigo" | "blue" | "slate"> = {
  owner: "purple",
  admin: "indigo",
  office: "blue",
  tech: "slate",
};

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: me } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user?.id ?? "")
    .single();
  const profile = me as Profile | null;
  const isAdmin = profile?.role === "owner" || profile?.role === "admin";

  const [{ data: org }, { data: team }, { data: invites }] = await Promise.all([
    profile?.org_id
      ? supabase.from("organizations").select("*").eq("id", profile.org_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("profiles").select("*").order("full_name"),
    isAdmin
      ? supabase
          .from("invitations")
          .select("*")
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);

  const members = (team ?? []) as Profile[];
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Settings" description="Company, profile, and team." />

      {/* Company settings (owner/admin) */}
      {isAdmin && org && (
        <Card>
          <CardContent className="py-5">
            <h3 className="mb-4 text-sm font-semibold text-slate-900">
              Company
            </h3>
            <OrgSettingsForm org={org as Organization} />
          </CardContent>
        </Card>
      )}

      {/* Your profile */}
      <Card>
        <CardContent className="py-5">
          <h3 className="mb-4 text-sm font-semibold text-slate-900">Your profile</h3>
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand text-lg font-semibold text-white">
              {initials(profile?.full_name)}
            </div>
            <div>
              <div className="text-base font-medium text-slate-900">
                {profile?.full_name ?? "—"}
              </div>
              <div className="text-sm text-slate-500">{profile?.email}</div>
              <Badge tone={roleTone[profile?.role ?? "tech"]} className="mt-1">
                {profile?.role}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Team invites (owner/admin) */}
      {isAdmin && (
        <Card>
          <CardContent className="py-5">
            <h3 className="mb-4 text-sm font-semibold text-slate-900">
              Invite team members
            </h3>
            <InviteManager invites={(invites as any) ?? []} siteUrl={siteUrl} />
          </CardContent>
        </Card>
      )}

      {/* Team directory */}
      <Card>
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-900">
            Team ({members.length})
          </h3>
        </div>
        <ul className="divide-y divide-slate-100">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-5 py-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">
                {initials(m.full_name)}
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-900">
                  {m.full_name ?? "—"}
                </div>
                <div className="text-xs text-slate-400">{m.email}</div>
              </div>
              {!m.active && <Badge tone="red">inactive</Badge>}
              <Badge tone={roleTone[m.role]}>{m.role}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
