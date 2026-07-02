import { PageHeader } from "@/components/page-header";
import { TasksView } from "./tasks-view";
import { getTasksPageData } from "./query";

export const dynamic = "force-dynamic";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string; mine?: string; else?: string }>;
}) {
  const sp = await searchParams;
  const showAllDone = sp?.done === "all";
  // ?mine=1 — the tech door from My Day: only what's assigned to the caller.
  // ?else=1 — the staff "Everything else" door: exclude office so the page
  // matches the door's non-office count. Both keep the door number honest.
  const mine = sp?.mine === "1";
  const noOffice = sp?.else === "1";
  const { todayStr, tasks, doneTotal, jobs, people } = await getTasksPageData(null, showAllDone, { mine, noOffice });

  return (
    <div>
      <PageHeader
        title={mine ? "Your tasks" : "Tasks"}
        description={mine ? "Everything assigned to you, by when — overdue first." : "What's next, by when — overdue first."}
      />
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
