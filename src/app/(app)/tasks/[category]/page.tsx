import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { TasksView } from "../tasks-view";
import type { TaskCategory } from "../actions";

export const dynamic = "force-dynamic";

const LABELS: Record<string, string> = {
  sales: "Sales",
  operations: "Operations",
  office: "Office",
};

export default async function CategoryTasksPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  if (!LABELS[category]) notFound();

  const supabase = await createClient();
  const [{ data: tasks }, { data: jobs }] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, category, status, priority, due_date, job_id, jobs(job_number, name)")
      .eq("category", category)
      .order("status", { ascending: true })
      .order("priority", { ascending: false })
      .order("due_date", { ascending: true, nullsFirst: false }),
    supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(100),
  ]);

  return (
    <div>
      <PageHeader
        title={`${LABELS[category]} tasks`}
        description={`To-dos in your ${LABELS[category]} bucket.`}
      />
      <TasksView tasks={(tasks ?? []) as any} jobs={jobs ?? []} category={category as TaskCategory} />
    </div>
  );
}
