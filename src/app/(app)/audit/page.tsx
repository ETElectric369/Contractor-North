import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Risk tier (agent-security framework §3) → a small label/colour for the trail.
const TIER: Record<number, { label: string; cls: string }> = {
  0: { label: "Read", cls: "bg-slate-100 text-slate-600" },
  1: { label: "Write", cls: "bg-blue-50 text-blue-700" },
  2: { label: "Money", cls: "bg-amber-50 text-amber-700" },
  3: { label: "Human-only", cls: "bg-red-50 text-red-700" },
};

export default async function AuditPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  if (!me || !["owner", "admin", "office"].includes(me.role)) redirect("/planner");

  // RLS already scopes this to the org + staff-read; newest first.
  const { data: rows } = await supabase
    .from("agent_audit_log")
    .select("id, action, risk, ok, error, source, user_id, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  const ids = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))] as string[];
  const { data: people } = ids.length
    ? await supabase.from("profiles").select("id, full_name").in("id", ids)
    : { data: [] as { id: string; full_name: string | null }[] };
  const nameOf = new Map((people ?? []).map((p) => [p.id, p.full_name]));

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <PageHeader
        title="Activity audit"
        description="Every action that runs through the app's action registry, newest first."
      />
      <Card className="mt-4">
        <CardContent className="p-0">
          {(rows ?? []).length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No actions recorded yet.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {(rows ?? []).map((r) => {
                const t = TIER[r.risk] ?? TIER[1];
                return (
                  <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${t.cls}`}>{t.label}</span>
                    <span className="font-mono text-xs text-slate-700">{r.action}</span>
                    <span
                      className={r.ok ? "text-green-600" : "text-red-600"}
                      title={r.ok ? "Succeeded" : (r.error ?? "Failed")}
                    >
                      {r.ok ? "✓" : "✗"}
                    </span>
                    <span className="ml-auto text-xs text-slate-400">
                      {nameOf.get(r.user_id) ?? "—"} · {r.source} ·{" "}
                      {formatDateTime(r.created_at)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
