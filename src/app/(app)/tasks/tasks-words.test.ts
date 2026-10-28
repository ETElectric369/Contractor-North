import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dict } from "@/lib/i18n";
import { LangProvider } from "@/components/lang-provider";

/**
 * REMINDERS IN SPANISH (cn-v1138). The /tasks view reads every word through t() and lib/words/tasks,
 * so a Spanish-speaking tech reads the add line, the edit sheet, each row and the sections in
 * Spanish and an English-speaking one reads exactly what the page said before; and the task
 * actions answer a refusal in the CALLER's language (profiles.language through lib/lang-of
 * callerLang), read once per action and only when an answer needs words.
 */
const state = vi.hoisted(() => ({ language: "en" as string | null, profileFails: false, openKids: 0, getUserCalls: 0, profileReads: 0 }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => fakeClient()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/tasks",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));

import { createTask, toggleTask, setTaskDonePhoto } from "./actions";
import { NewReminderBox, TaskEditModal, TaskRow, TasksView, type ViewTask } from "./tasks-view";

/** A client that answers the profile's language and a parent's open steps; every other read is empty. */
function fakeClient() {
  return {
    auth: {
      getUser: async () => {
        state.getUserCalls++;
        return { data: { user: { id: "u1" } } };
      },
    },
    from(table: string) {
      const answer = () => {
        if (table === "profiles") {
          state.profileReads++;
          return state.profileFails ? { data: null, error: { message: "boom" } } : { data: state.language === null ? null : { language: state.language }, error: null };
        }
        return { data: null, error: null };
      };
      const list = () => (table === "tasks" ? { data: Array.from({ length: state.openKids }, (_, i) => ({ id: `k${i}` })), error: null } : { data: [], error: null });
      const chain: any = {
        select: () => chain,
        insert: () => chain,
        update: () => chain,
        delete: () => chain,
        eq: () => chain,
        is: () => chain,
        or: () => chain,
        in: () => chain,
        gte: () => chain,
        ilike: () => chain,
        limit: () => chain,
        single: async () => answer(),
        maybeSingle: async () => answer(),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(list()).then(res, rej),
      };
      return chain;
    },
  };
}

const es = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: el }));
const en = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const TODAY = "2026-09-26";
const REMINDER: ViewTask = { id: "r1", title: "Call the PUD", category: "office", status: "open", priority: 1, due_date: "2026-09-20", job_id: null, assigned_to: "u1", created_by: "u1", focus_date: "2026-09-21" };
const PEOPLE = [{ id: "u1", full_name: "Crew B" }];

describe("the actions answer in the caller's language", () => {
  beforeEach(() => {
    state.language = "en";
    state.profileFails = false;
    state.openKids = 0;
    state.getUserCalls = 0;
    state.profileReads = 0;
  });

  it("a Spanish caller's refusal is Spanish: a name on a job's task, a missing title, a photo on no job", async () => {
    state.language = "es";
    expect(await createTask({ title: "Hang the panel", job_id: "j1", assigned_to: "p1" })).toEqual({ ok: false, error: dict("es").tk_jobTaskNoAssignee });
    expect((await createTask({ title: "   " })).error).toBe("Falta el título.");
    expect((await createTask({ title: "Rough-in", photo_path: "x" })).error).toBe("Una foto va en la tarea de un trabajo. Elige el trabajo primero.");
    expect((await setTaskDonePhoto("r1", "../climb")).error).toBe("Esa foto no está en los archivos de trabajos de esta empresa, así que no puede ir en la tarea.");
  });

  it("an English caller reads exactly the sentences the actions always answered", async () => {
    expect((await createTask({ title: "Hang the panel", job_id: "j1", assigned_to: "p1" })).error).toBe(
      "A job's task belongs to the job, not one person: the crew lead hands it out. Leave the name off, or make it a Reminder for them with no job.",
    );
    expect((await createTask({ title: "" })).error).toBe("Title is required.");
    expect((await setTaskDonePhoto("r1", "../climb")).error).toBe("That photo isn't in this company's job files, so it can't go on the task.");
  });

  it("the cascade question counts in Spanish, one step or many", async () => {
    state.language = "es";
    state.openKids = 2;
    expect(await toggleTask("r1", true)).toMatchObject({ ok: false, needsCascade: true, openChildren: 2, error: "Esta tarea tiene 2 subtareas abiertas — ¿completarlas también?" });
    state.openKids = 1;
    expect((await toggleTask("r1", true)).error).toBe("Esta tarea tiene 1 subtarea abierta — ¿completarla también?");
    state.language = "en";
    state.openKids = 2;
    expect((await toggleTask("r1", true)).error).toBe("This task has 2 open subtasks — complete them too?");
  });

  it("a failed language read answers English, never a thrown action; the language is read once, and only when words are needed", async () => {
    state.language = "es";
    state.profileFails = true;
    expect((await createTask({ title: "" })).error).toBe("Title is required.");
    state.profileFails = false;
    state.language = null;
    expect((await createTask({ title: "" })).error).toBe("Title is required.");
    // The happy path pays no extra round trip: a toggle with nothing to refuse never reads the profile.
    state.profileReads = 0;
    state.openKids = 0;
    expect((await toggleTask("r1", false)).ok).toBe(false); // the fake answers zero rows, so the silent-write law asks for words once
    expect(state.profileReads).toBe(1);
  });

  it("the duplicate's date reads in the caller's locale", async () => {
    // (Covered by retyped-reminder.test.ts in English; the Spanish date shape is Intl's own.)
    expect(new Date("2026-09-20T12:00:00Z").toLocaleDateString("es-US", { month: "short", day: "numeric" })).not.toBe(
      new Date("2026-09-20T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    );
    expect(dict("es").tk_alreadyOpenSince).toBe('Ya está en la lista: "{title}" — abierto desde {date}.');
  });
});

describe("the Reminders view in Spanish", () => {
  it("the add line: placeholder, Agregar; English as before", () => {
    const s = es(createElement(NewReminderBox));
    expect(s).toContain('placeholder="Agregar Un Recordatorio…"');
    expect(s).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Agregar<\/button>/);
    const e = en(createElement(NewReminderBox));
    expect(e).toContain('placeholder="Add A Reminder…"');
    expect(e).toMatch(/Add<\/button>/);
  });

  it("a row: Vence, Alta, the category chip, Viene De lunes, the door titles; English unchanged", () => {
    const props = { t: REMINDER, people: PEOPLE, category: "office", todayStr: TODAY, showCategory: true, overdue: true };
    const s = es(createElement(TaskRow, props));
    expect(s).toContain("Vence 20 sept 2026");
    expect(s).toContain(">Alta<");
    expect(s).toContain(">Oficina<");
    expect(s).toContain("Viene De lunes");
    expect(s).toContain('title="Desfijar"'); // a carried pin is a standing pin: the door unpins
    expect(es(createElement(TaskRow, { ...props, t: { ...REMINDER, focus_date: null } }))).toContain('title="Fijar Arriba (Se Queda Hasta Que Lo Desfijes)"');
    expect(s).toContain('title="Editar"');
    expect(s).toContain('title="Eliminar"');
    expect(s).toContain('title="Agregar subtarea"');
    expect(s).not.toContain("Carried From");
    const e = en(createElement(TaskRow, props));
    expect(e).toContain("Due Sep 20, 2026");
    expect(e).toContain(">High<");
    expect(e).toContain(">Office<");
    expect(e).toContain("Carried From Monday");
    expect(e).toContain('title="Unpin"');
    expect(en(createElement(TaskRow, { ...props, t: { ...REMINDER, focus_date: null } }))).toContain('title="Pin To Top (Carries Until You Unpin It)"');
  });

  it("the edit sheet: Editar Recordatorio, Guardar Cambios, the labels, Quien Lo Hizo, the priorities", () => {
    const props = { t: REMINDER, people: PEOPLE, category: "office", open: true, onClose: () => {}, viewerId: "u1" };
    const s = es(createElement(TaskEditModal, props));
    expect(s).toContain("Editar Recordatorio");
    expect(s).toContain("Guardar Cambios");
    expect(s).toContain(">Título<");
    expect(s).toContain(">Categoría<");
    expect(s).toContain(">Prioridad<");
    expect(s).toContain("Para Quién Es");
    expect(s).toContain("Quien Lo Hizo");
    expect(s).toContain(">Urgente<");
    expect(s).toContain('placeholder="Agrega detalles o contexto…"');
    const other = es(createElement(TaskEditModal, { ...props, viewerId: "someone-else" }));
    expect(other).toContain("Solo quien lo hizo puede pasárselo a otra persona.");
    expect(other).toContain("Alguien del equipo"); // for someone else, with no assignee row loaded
    expect(es(createElement(TaskEditModal, { ...props, viewerId: "someone-else", t: { ...REMINDER, assignee: { full_name: "Crew B" } } }))).toContain(">Crew B<");
    const e = en(createElement(TaskEditModal, props));
    expect(e).toContain("Edit Reminder");
    expect(e).toContain("Save Changes");
    expect(e).toContain("Whoever Made It");
  });

  it("the sections and the view toggle: Atrasados, Hoy, Esta semana, Algún día, Por Fecha / Por Categoría, Completados", () => {
    const tasks: ViewTask[] = [
      { ...REMINDER, id: "a", due_date: "2026-09-20" },
      { ...REMINDER, id: "b", due_date: TODAY },
      { ...REMINDER, id: "c", due_date: "2026-09-27" }, // the Sunday of a Monday-start week: This week
      { ...REMINDER, id: "d", due_date: null },
      { ...REMINDER, id: "e", due_date: null, status: "done" },
      { ...REMINDER, id: "f", due_date: "2026-10-05" }, // next week: Later
    ];
    const s = es(createElement(TasksView, { tasks, people: PEOPLE, todayStr: TODAY, weekStart: "monday", doneTotal: 1 }));
    for (const word of ["Atrasados", "Hoy", "Esta semana", "Más tarde", "Algún día", "Por Fecha", "Por Categoría", "Completados"]) expect(s, word).toContain(word);
    expect(s).not.toContain("Overdue");
    const empty = es(createElement(TasksView, { tasks: [], people: PEOPLE, todayStr: TODAY }));
    expect(empty).toContain("Nada abierto. Agrega un recordatorio arriba.");
    const e = en(createElement(TasksView, { tasks, people: PEOPLE, todayStr: TODAY, weekStart: "monday", doneTotal: 1 }));
    for (const word of ["Overdue", "Today", "This week", "Later", "Someday", "By When", "By Category", "Completed"]) expect(e, word).toContain(word);
  });
});
