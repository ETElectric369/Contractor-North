import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { TasksView } from "./tasks-view";
import { getTasksPageData } from "./query";
import { viewerSwitches } from "@/lib/viewer-switches";
import { featureOn } from "@/lib/features";

export const dynamic = "force-dynamic";

/**
 * REMINDERS (0358). /tasks is the one Reminders page: the tasks with no job that are yours (you made
 * them, or they were made for you), and nobody else's. A job's tasks live on the job (its Tasks chip)
 * and in My Day's Now block. The old ?mine / ?else doors mean nothing now (every Reminder here is
 * already yours) and are ignored; the /tasks/<category> pages are gone (By Category below).
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string; by?: string }>;
}) {
  const sp = await searchParams;
  const showAllDone = sp?.done === "all";
  const [{ todayStr, viewerId, tasks, doneTotal, people, categories }, sw] = await Promise.all([
    getTasksPageData(showAllDone),
    viewerSwitches(),
  ]);

  // The standard header action (every list page's idiom) — it deep-links to the one-line add box
  // via ?new=1 (focus), keeping the grouping.
  const addParams = new URLSearchParams();
  if (sp?.by === "category") addParams.set("by", "category");
  addParams.set("new", "1");

  return (
    <div>
      <PageHeader title="Reminders" description="Yours alone: the ones you made and the ones made for you. A job's tasks are on the job.">
        <Link href={`/tasks?${addParams.toString()}`}>
          <Button>
            <Plus className="h-4 w-4" /> Add Reminder
          </Button>
        </Link>
      </PageHeader>
      <TasksView
        tasks={tasks as any}
        people={people}
        categories={categories}
        todayStr={todayStr}
        viewerId={viewerId}
        doneTotal={doneTotal}
        showingAllDone={showAllDone}
        extras={featureOn(sw.features, "todo_extras")}
      />
    </div>
  );
}
