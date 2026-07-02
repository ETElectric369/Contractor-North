import { PageHeader } from "@/components/page-header";
import { TasksView } from "./tasks-view";
import { getTasksPageData } from "./query";

export const dynamic = "force-dynamic";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  const sp = await searchParams;
  const showAllDone = sp?.done === "all";
  const { todayStr, tasks, doneTotal, jobs, people } = await getTasksPageData(null, showAllDone);

  return (
    <div>
      <PageHeader title="Tasks" description="What's next, by when — overdue first." />
      <TasksView
        tasks={tasks as any}
        jobs={jobs}
        people={people}
        todayStr={todayStr}
        doneTotal={doneTotal}
        showingAllDone={showAllDone}
      />
    </div>
  );
}
