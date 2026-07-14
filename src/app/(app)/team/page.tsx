import { redirect } from "next/navigation";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";
import { initials } from "@/lib/utils";
import { adminConfigured } from "@/lib/supabase/admin";
import { InviteManager } from "../settings/invite-manager";
import { AddEmployeeButton } from "../settings/add-employee-button";
import { CrewImportButton } from "../settings/crew-import-button";
import { MemberRate } from "../settings/member-rate";
import { TeamMemberMenu } from "./team-member-menu";
import type { Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

const roleTone: Record<string, "purple" | "indigo" | "blue" | "slate"> = {
  owner: "purple",
  admin: "indigo",
  office: "blue",
  tech: "slate",
};

/**
 * TEAM — the crew roster, lifted out of Settings into its own Office page (settings
 * doctrine: Settings keeps ZERO team UI). Each member carries a "⋯" seek menu with the
 * real lifecycle verbs (Edit & role · Reset login · Deactivate/Reactivate · Remove).
 * Office-only, like /schedule — techs get redirected to My Day; direct URLs are guarded
 * server-side too (RLS would otherwise hand a tech a half-empty roster).
 *
 * Invite / add-employee / crew-import (the JOIN doors) live at the top; the roster below.
 * Rates are inline (owner/admin only). All server actions are reused from settings/actions.ts.
 */
export default async function TeamPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("*").eq("id", user?.id ?? "").single();
  const profile = me as Profile | null;

  // Office-only surface. Techs land here from no nav link; guard direct URLs too.
  if (!profile || !isStaffRole(profile.role)) {
    redirect("/planner");
  }
  const isAdmin = profile.role === "owner" || profile.role === "admin";

  const [{ data: team }, { data: invites }] = await Promise.all([
    supabase.from("profiles").select("*").order("full_name"),
    isAdmin
      ? supabase.from("invitations").select("*").order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);

  const members = (team ?? []) as Profile[];
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Team" description="Your crew — invite people, set pay & charge rates, change roles, and deactivate anyone who's moved on." />

      <div className="space-y-6">
        {isAdmin && (
          <Card>
            <div className="border-b border-slate-100 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-900">Add to the team</h3>
            </div>
            <div className="space-y-4 px-5 py-4">
              <InviteManager invites={(invites as any) ?? []} siteUrl={siteUrl} />
              <div className="border-t border-slate-100 pt-4">
                <div className="mb-2 text-xs text-slate-500">
                  Or create their login yourself and hand them the password — no email needed:
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <AddEmployeeButton configured={adminConfigured()} />
                  {adminConfigured() && <CrewImportButton />}
                </div>
              </div>
            </div>
          </Card>
        )}

        {members.length === 0 ? (
          <EmptyState icon={Users} title="No team members yet" description="Invite your first crew member above." />
        ) : (
          <Card>
            <div className="border-b border-slate-100 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-900">Team ({members.length})</h3>
            </div>
            <ul className="divide-y divide-slate-100">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">
                    {initials(m.full_name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-900">{m.full_name ?? "—"}</div>
                    <div className="truncate text-xs text-slate-400">{m.email}</div>
                  </div>
                  {isAdmin && <MemberRate id={m.id} rate={m.hourly_rate} billRate={(m as any).bill_rate ?? null} />}
                  {!m.active && <Badge tone="red">inactive</Badge>}
                  {!!(m as any).crew_lead && <Badge tone="green">crew lead</Badge>}
                  <Badge tone={roleTone[m.role]}>{m.role}</Badge>
                  {isAdmin && (
                    <TeamMemberMenu
                      member={{ id: m.id, full_name: m.full_name, email: m.email, phone: (m as any).phone ?? null, role: m.role, active: m.active, home_address: m.home_address, commute_baseline_miles: (m as any).commute_baseline_miles ?? 0, crew_lead: !!(m as any).crew_lead }}
                      isSelf={m.id === profile.id}
                      isOwnerRow={m.role === "owner"}
                      authConfigured={adminConfigured()}
                    />
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
