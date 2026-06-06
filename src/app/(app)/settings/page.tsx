import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { initials } from "@/lib/utils";
import type { Profile } from "@/lib/types";

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

  const [{ data: me }, { data: team }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user?.id ?? "").single(),
    supabase.from("profiles").select("*").order("full_name"),
  ]);

  const profile = me as Profile | null;
  const members = (team ?? []) as Profile[];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Settings" description="Your profile and team." />

      <Card>
        <CardContent className="py-5">
          <h3 className="mb-4 text-sm font-semibold text-slate-900">
            Your profile
          </h3>
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

      <Card className="border-amber-200 bg-amber-50">
        <CardContent className="py-4 text-sm text-amber-800">
          <strong>Tip:</strong> The first account you create is just a{" "}
          <em>tech</em> by default. To make yourself the owner, open the Supabase
          SQL editor and run:
          <pre className="mt-2 overflow-x-auto rounded-lg bg-white/70 p-3 text-xs text-slate-700">
            {`update public.profiles set role = 'owner'
where email = 'you@example.com';`}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
