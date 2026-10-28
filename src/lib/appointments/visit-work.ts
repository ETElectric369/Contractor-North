import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_BIRTH, partsAsCaptureItems, tasksAnswered, tasksFromVisit, type Birth } from "@/lib/estimate/born-with-tasks";
import { kitsReadWords, readTaskKits, type KitsReadState } from "@/lib/estimate/task-kits";
import { parseInspectorCapture, type CaptureItem } from "@/lib/inspection/capture";
import { readViaView } from "@/lib/inspection/inspection-access";
import { playbookForForm } from "@/lib/playbook/parse";
import { reportError } from "@/lib/observe";

/**
 * WHAT A VISIT TYPED, READ ONCE FOR EVERY DOOR THAT HANDS IT TO A JOB (cn-v1134).
 *
 * A visit records two typed things: its TASKS (the sheet's answers → tasksAnswered → tasksFromVisit,
 * each with its own minutes and parts, through the kits a task picked) and its TAKE-OFF
 * (appointments.capture.items, the rows typed on site). Start The Job (createJobFromAppointment)
 * read both and carried them onto the job it made; Won · Pick The Job (linkAppointmentTo) linked an
 * EXISTING job and carried nothing, so a visit won onto a job somebody had already made left its
 * tasks and parts on the visit. One read here, two doors on it.
 *
 * NEVER THROWN PAST THE DOOR. A failed read is SAID in `notes`, in the words of the door that asked
 * (the job was made / the visit is linked), and the rest still comes back: a visit whose sheet could
 * not be read still hands over its typed take-off. A pre-0165 table (no answers column, 42703) and a
 * visit with no sheet are simply no tasks, not a note.
 */
export type VisitWorkDoor = "job" | "link";

export interface VisitWork {
  /** The tasks typed on the visit, each with its own minutes, and their parts, as a job births them. */
  birth: Birth;
  /** Everything for the job's one materials list: the typed take-off, then the tasks' parts (keyed). */
  typedItems: CaptureItem[];
  /** What could not be read, one sentence each, in the door's words. Empty when every read was whole. */
  notes: string[];
}

const WORDS: Record<VisitWorkDoor, { tasks: string; kits: (state: KitsReadState) => string; capture: string }> = {
  job: {
    tasks: "The job was made; the tasks typed on the visit could not be read. Add them on the job.",
    kits: (state) => `The job was made, sized from the hours typed. ${kitsReadWords(state)} Check the job's tasks.`,
    capture: "The job was made; the materials typed on the visit could not be read. Add them on the Materials tab.",
  },
  link: {
    tasks: "The visit is linked; its tasks could not be read. Add them on the job.",
    kits: (state) => `The visit is linked. ${kitsReadWords(state)} Check the job's tasks.`,
    capture: "The visit is linked; its materials could not be read. Add them on the Materials tab.",
  },
};

export async function visitWork(supabase: SupabaseClient, appointmentId: string, door: VisitWorkDoor = "job"): Promise<VisitWork> {
  const words = WORDS[door];
  const notes: string[] = [];
  let birth: Birth = EMPTY_BIRTH;
  try {
    // The estimate seed's read (tasksAnswered, through the 0366 views): the answers, then the sheet.
    const ans = await readViaView<{ inspection_answers: unknown; inspection_template_id: string | null }>(
      supabase,
      "answers",
      (from) => from.select("inspection_answers, inspection_template_id").eq("id", appointmentId).maybeSingle(),
    );
    // Pre-0165 (no answers column on the table) is simply no tasks; any other failed read is said.
    if (ans.error && !(ans.via === "table" && String((ans.error as { code?: string }).code ?? "") === "42703")) throw ans.error;
    // The sheet through form_playbooks (0366), as every tech-facing read does; a failed read is said.
    const sheetRead = ans.data?.inspection_template_id
      ? await readViaView<{ schema?: unknown; playbook?: unknown }>(
          supabase,
          "sheets",
          (from) => from.select("schema, playbook").eq("id", ans.data!.inspection_template_id!).maybeSingle(),
        )
      : null;
    if (sheetRead?.error) throw sheetRead.error;
    const sheet = sheetRead?.data ?? null;
    if (ans.data && sheet) {
      const answered = tasksAnswered(playbookForForm(sheet), (ans.data.inspection_answers ?? {}) as Record<string, unknown>);
      // THE TASK KITS (0386, W4): a task that picked one takes its hours and parts from it, as the
      // estimate seed does. A failed kits read is said, and the tasks carry what he typed.
      const kitsRead = answered.some((t) => t.kit_id) ? await readTaskKits((sel) => supabase.from("kits").select(sel).order("name")) : null;
      birth = tasksFromVisit(answered, new Map((kitsRead?.kits ?? []).map((k) => [k.id, k])));
      // The same words every page says for a read that was not whole; a thin read still names and
      // counts the parts, so only a failed or pre-0386 read is a note.
      if (kitsRead && (kitsRead.state === "failed" || kitsRead.state === "pre-0386")) {
        if (kitsRead.state === "failed") reportError("visit-work:kits", kitsRead.error, { appointmentId, door });
        notes.push(words.kits(kitsRead.state));
      }
    }
  } catch (e) {
    reportError("visit-work:tasks", e, { appointmentId, door });
    notes.push(words.tasks);
  }

  // THE TYPED TAKE-OFF (cn-v1069): the rows typed on the inspection sheet. PROJECTION LAW: read here,
  // by name, so no door's own select has to remember it.
  let items: CaptureItem[] = [];
  try {
    const { data, error } = await supabase.from("appointments").select("capture").eq("id", appointmentId).maybeSingle();
    if (error) throw error;
    items = parseInspectorCapture((data as { capture?: unknown } | null)?.capture).items ?? [];
  } catch (e) {
    reportError("visit-work:capture", e, { appointmentId, door });
    notes.push(words.capture);
  }

  // The tasks' parts join the typed rows on the same list, keyed to their task (partsAsCaptureItems).
  return { birth, typedItems: [...items, ...partsAsCaptureItems(birth.parts)], notes };
}
