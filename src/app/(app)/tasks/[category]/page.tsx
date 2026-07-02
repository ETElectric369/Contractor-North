import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { TasksView } from "../tasks-view";
import { getTasksPageData } from "../query";
import type { TaskCategory } from "../actions";

export const dynamic = "force-dynamic";

const LABELS: Record<string, string> = {
  sales: "Sales",
  operations: "Operations",
  office: "Office",
};

export default async function CategoryTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ category: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const [{ category }, sp] = await Promise.all([params, searchParams]);
  if (!LABELS[category]) notFound();

  const showAllDone = sp?.done === "all";
  const { todayStr, tasks, doneTotal, jobs, people } = await getTasksPageData(category, showAllDone);

  return (
    <div>
      <PageHeader
        title={`${LABELS[category]} tasks`}
        description={`${LABELS[category]} to-dos, by when — overdue first.`}
      />
      <TasksView
        tasks={tasks as any}
        jobs={jobs}
        people={people}
        category={category as TaskCategory}
        todayStr={todayStr}
        doneTotal={doneTotal}
        showingAllDone={showAllDone}
      />
    </div>
  );
}
