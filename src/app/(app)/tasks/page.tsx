import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { TasksView } from "./tasks-view";
import { getTasksPageData } from "./query";

export const dynamic = "force-dynamic";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string; mine?: string; else?: string; by?: string }>;
}) {
  const sp = await searchParams;
  const showAllDone = sp?.done === "all";
  // ?mine=1 — the tech door from My Day: only what's assigned to the caller.
  // ?else=1 — the staff "Everything else" door: exclude office so the page
  // matches the door's non-office count. Both keep the door number honest.
  const mine = sp?.mine === "1";
  const noOffice = sp?.else === "1";
  const { todayStr, tasks, doneTotal, jobs, people, categories } = await getTasksPageData(null, showAllDone, { mine, noOffice });

  // The standard header action (every list page's idiom) — it deep-links to the
  // existing quick-add box via ?new=1 (focus + expand), preserving live filters.
  const addParams = new URLSearchParams();
  if (mine) addParams.set("mine", "1");
  if (noOffice) addParams.set("else", "1");
  if (sp?.by === "category") addParams.set("by", "category");
  addParams.set("new", "1");

  return (
    <div>
      <PageHeader
        title={mine ? "Your tasks" : "Tasks"}
        description={mine ? "Everything assigned to you, by when — overdue first." : "What's next, by when — overdue first."}
      >
        <Link href={`/tasks?${addParams.toString()}`}>
          <Button>
            <Plus className="h-4 w-4" /> Add task
          </Button>
        </Link>
      </PageHeader>
      <TasksView
        tasks={tasks as any}
        jobs={jobs}
        people={people}
        categories={categories}
        todayStr={todayStr}
        doneTotal={doneTotal}
        showingAllDone={showAllDone}
      />
    </div>
  );
}
