import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { TasksView } from "./tasks-view";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const supabase = await createClient();
  const [{ data: tasks }, { data: jobs }, { data: people }] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, category, status, priority, due_date, job_id, assigned_to, parent_id, tags, jobs(job_number, name), assignee:assigned_to(full_name)")
      .order("status", { ascending: true })
      .order("priority", { ascending: false })
      .order("due_date", { ascending: true, nullsFirst: false }),
    supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(100),
    supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
  ]);

  return (
    <div>
      <PageHeader title="Tasks" description="Your to-dos across Sales, Operations, and Office." />
      <TasksView tasks={(tasks ?? []) as any} jobs={jobs ?? []} people={people ?? []} />
    </div>
  );
}
