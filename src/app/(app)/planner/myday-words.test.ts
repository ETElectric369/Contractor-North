import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dict, fillText } from "@/lib/i18n";
import { LangProvider } from "@/components/lang-provider";
import { LUNCH_LABEL } from "@/lib/lunch-rule";
import { carriedDay } from "@/lib/six-rank";
import { formatDate } from "@/lib/utils";

/**
 * MY DAY IN SPANISH (cn-v1138). A Spanish-speaking tech reads the Now card, the clocked-in job's
 * tasks and Tasks & Reminders in Spanish — every word through t() and lib/words/myday — and an
 * English-speaking one reads exactly what the screens said before the wave. The quote of the day
 * keeps its author's name on both lines. Rendered the way the app does: the (app) layout mounts
 * LangProvider with the profile's language; a render outside it is English.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/planner",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../tasks/actions", () => ({ createTask: vi.fn(), toggleTask: vi.fn(), deleteTask: vi.fn(), updateTask: vi.fn() }));
vi.mock("../timeclock/actions", () => ({ clockIn: vi.fn(), clockOut: vi.fn() }));
vi.mock("../timeclock/which-job-actions", () => ({ whichJobChoices: vi.fn(), putPunchOnJob: vi.fn() }));

import { NowCard } from "./now-card";
import { NowTasks } from "./now-tasks";
import { AddReminderLine, DoneMarks, YourList, laterRow, movedWords, type SixSlot } from "./your-list";

const es = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: el }));
const en = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const TODAY = "2026-09-26";
const row = (over: Partial<SixSlot> = {}): SixSlot => ({ id: "r1", title: "Call the PUD", category: "operations", priority: 0, due_date: null, job_id: null, focus_date: null, ...over });

describe("the quote of the day, in both languages", () => {
  it("all 34 quotes are in the catalog in English and in Spanish, the author's name unchanged on the Spanish line", () => {
    for (let i = 1; i <= 34; i++) {
      const key = `md_quote_${String(i).padStart(2, "0")}`;
      const e = dict("en")[key];
      const s = dict("es")[key];
      expect(e, key).toBeTruthy();
      expect(s, key).toBeTruthy();
      expect(s, key).not.toBe(e);
      const author = e.match(/—(.+)$/)?.[1];
      if (author) expect(s.endsWith(`—${author}`), `${key}: the author's name stays as written`).toBe(true);
      else expect(s).not.toMatch(/—/);
    }
    expect(dict("en")).not.toHaveProperty("md_quote_35");
    // A well-known quote uses its known Spanish rendering.
    expect(dict("en").md_quote_29).toBe("The obstacle is the way. —Marcus Aurelius");
    expect(dict("es").md_quote_29).toBe("El obstáculo es el camino. —Marcus Aurelius");
    expect(dict("es").md_quote_10).toBe("Un viaje de mil millas comienza con un solo paso. —Lao Tzu");
  });
});

describe("the Now card", () => {
  const job = { name: "J-055 Larkspur Panel", sub: "Snowbell · 41 Larkspur", href: "/jobs/j55" };
  const punch = (over: Record<string, unknown> = {}) => ({ id: "p1", clock_in: new Date(Date.now() - 3_600_000).toISOString(), notes: null, job_id: "j55", ...over });

  it("off the clock in Spanish: Sin Entrada Marcada, Marcar Entrada, Reloj; in English the same card as before", () => {
    const s = es(createElement(NowCard, { open: null, job: null, userId: "u1" }));
    expect(s).toContain("Sin Entrada Marcada");
    expect(s).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Marcar Entrada<\/button>/);
    expect(s).toMatch(/<a[^>]*href="\/timeclock"[^>]*>Reloj<\/a>/);
    expect(s).not.toContain("Clock In");
    const e = en(createElement(NowCard, { open: null, job: null, userId: "u1" }));
    expect(e).toContain("Not Clocked In");
    expect(e).toMatch(/Clock In<\/button>/);
    expect(e).toContain(">Timeclock<");
  });

  it("on the clock with a job in Spanish: Ahora, the lunch box, Marcar Salida; the job's name and sub are the job's own", () => {
    const s = es(createElement(NowCard, { open: punch(), job, userId: "u1" }));
    expect(s).toContain(">Ahora<");
    expect(s).toContain("Tomé un almuerzo de 30 minutos sin pago");
    expect(s).toContain("Marcar Salida");
    expect(s).toContain("J-055 Larkspur Panel");
    expect(s).toContain("Snowbell · 41 Larkspur");
    expect(s).not.toContain("Clock Out");
    const e = en(createElement(NowCard, { open: punch(), job, userId: "u1" }));
    expect(e).toContain(">Now<");
    expect(e).toContain(LUNCH_LABEL);
    expect(e).toContain("Clock Out");
  });

  it("the lunch box's English is the one rule's label (lib/lunch-rule), so the two can never drift", () => {
    expect(dict("en").md_tookLunch).toBe(LUNCH_LABEL);
  });

  it("on the clock with no job in Spanish: the question and ONE Elegir El Trabajo door", () => {
    const s = es(createElement(NowCard, { open: punch({ job_id: null }), job: null, userId: "u1" }));
    expect(s).toContain("¿En qué trabajo estás?");
    expect(s).toContain("Estás en el reloj, pero esta marcación aún no tiene trabajo.");
    expect(s.match(/Elegir El Trabajo/g)).toHaveLength(1);
    expect(s).not.toContain("Pick The Job");
  });

  it("the crew pulse in Spanish: En El Reloj, 3 de 4, sin trabajo aún, desde; a failed read is said in Spanish", () => {
    const crew = { on: 3, of: 4, rows: [{ id: "e1", name: "Crew B", job: null, since: "6:30 AM", href: "/timecards?week=0&entry=e1" }] };
    const s = es(createElement(NowCard, { open: null, job: null, userId: "u1", crew }));
    expect(s).toContain("En El Reloj");
    expect(s).toContain("3 de 4");
    expect(s).toContain("sin trabajo aún");
    expect(s).toContain("desde 6:30 AM");
    expect(es(createElement(NowCard, { open: null, job: null, userId: "u1", crew: null }))).toContain("No se pudo leer quién está en el reloj — recarga para intentar de nuevo.");
    expect(es(createElement(NowCard, { open: null, job: null, userId: "u1", crew: { on: 1, of: 3, rows: [] } }))).toContain("Solo tú.");
    const e = en(createElement(NowCard, { open: null, job: null, userId: "u1", crew }));
    expect(e).toContain("On The Clock");
    expect(e).toContain("3 of 4");
    expect(e).toContain("since 6:30 AM");
  });
});

describe("the clocked-in job's tasks", () => {
  const NEXT = [{ id: "a", title: "Pull the permit" }, { id: "b", title: "Set the meter base" }];
  it("Spanish: Tareas: faltan 4, Todas Las Tareas, and the row's aria words; English unchanged", () => {
    const s = es(createElement(NowTasks, { jobId: "j1", left: 4, next: NEXT }));
    expect(s).toContain("Tareas: faltan 4");
    expect(s).toContain("Todas Las Tareas");
    expect(s).toContain('aria-label="Marcar Pull the permit"');
    expect(s).toContain("Pull the permit");
    const e = en(createElement(NowTasks, { jobId: "j1", left: 4, next: NEXT }));
    expect(e).toContain("Tasks: 4 left");
    expect(e).toContain("All Tasks");
    expect(e).toContain('aria-label="Check off Pull the permit"');
  });
});

describe("Tasks & Reminders", () => {
  const JOBS = [{ id: "j1", label: "J-055 Larkspur Panel", number: "J-055" }];

  it("the Add line in Spanish: the placeholder, Agregar, the job chip's rows; English as before", () => {
    const s = es(createElement(AddReminderLine, { jobs: JOBS, todayStr: TODAY }));
    expect(s).toContain('placeholder="Agregar Un Recordatorio O Tarea…"');
    expect(s).toContain('aria-label="Trabajo (opcional)"');
    expect(s).toContain("Sin Trabajo: Un Recordatorio Para Mí");
    expect(s).toContain("En J-055 Larkspur Panel");
    expect(s).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Agregar<\/button>/);
    const e = en(createElement(AddReminderLine, { jobs: JOBS, todayStr: TODAY }));
    expect(e).toContain('placeholder="Add A Reminder Or Task…"');
    expect(e).toContain("No Job: A Reminder For Me");
    expect(e).toContain("On J-055 Larkspur Panel");
  });

  it("the card in Spanish: the heading, Todos Los Recordatorios, the empty line and Tomar Uno; the carried chip; the More For You line", () => {
    const empty = es(createElement(YourList, { rows: [], subtasks: [], todayStr: TODAY, doneToday: 0, restCount: 2 }));
    expect(empty).toContain("Tareas Y Recordatorios");
    expect(empty).toContain("Todos Los Recordatorios");
    expect(empty).toContain("Nada urgente hoy.");
    expect(empty).toContain("Tomar Uno →");
    expect(empty).not.toContain("Grab One");
    const carried = es(createElement(YourList, { rows: [row({ focus_date: "2026-09-25" })], subtasks: [], todayStr: TODAY, doneToday: 1, restCount: 4 }));
    expect(carried).toContain("Viene De Ayer");
    expect(carried).toContain('aria-label="Marcar Call the PUD como hecho"');
    expect(carried).toContain("Todos Los Recordatorios · 4 Más Para Ti");
    expect(carried).toContain('aria-label="1 de 2 hechos hoy"');
    expect(carried).not.toContain("Carried From");
  });

  it("English is byte-for-byte what it was", () => {
    const html = en(createElement(YourList, { rows: [row({ focus_date: "2026-09-25", due_date: TODAY })], subtasks: [], todayStr: TODAY, doneToday: 1, restCount: 4 }));
    expect(html).toContain("Tasks &amp; Reminders");
    expect(html).toContain("All Reminders · 4 More For You");
    expect(html).toContain("Carried From Yesterday");
    expect(html).toContain('aria-label="1 of 2 done today"');
    expect(html).toContain(">Today<");
    expect(html).not.toContain("Nothing urgent today.");
    expect(en(createElement(DoneMarks, { done: 2, total: 4 }))).toContain('aria-label="2 of 4 done today"');
    expect(es(createElement(DoneMarks, { done: 2, total: 4 }))).toContain('aria-label="2 de 4 hechos hoy"');
  });

  it("the pure words take a language: the later row, the moved sentence, the carried day", () => {
    expect(laterRow("in_a_week", TODAY)).toEqual({ label: "In A Week", due: "2026-10-03" });
    expect(laterRow("in_a_week", TODAY, "es")).toEqual({ label: "En Una Semana", due: "2026-10-03" });
    expect(laterRow("someday", TODAY, "es")).toEqual({ label: "Algún Día (Quitar Fecha)", due: null });
    const plain = { focus_date: null, priority: 0, category: "operations" };
    expect(movedWords(plain, "2026-09-27", TODAY)).toBe("Due tomorrow. It waits on your Reminders list till then.");
    expect(movedWords(plain, "2026-09-27", TODAY, "es")).toBe("Vence mañana. Espera en tu lista de Recordatorios hasta entonces.");
    expect(movedWords(plain, "2026-10-03", TODAY, "es")).toBe(fillText(dict("es").md_dueWhenWaits, { when: formatDate("2026-10-03", undefined, "es") }));
    expect(movedWords({ ...plain, category: "office" }, null, TODAY, "es")).toBe("Ya no tiene fecha. Espera en tu lista de Recordatorios bajo Algún Día.");
    // lib/six-rank carriedDay: Yesterday, the weekday, the date — in the person's language, English by default.
    expect(carriedDay("2026-09-25", TODAY)).toBe("Yesterday");
    expect(carriedDay("2026-09-25", TODAY, "es")).toBe("Ayer");
    expect(carriedDay("2026-09-21", TODAY)).toBe("Monday");
    expect(carriedDay("2026-09-21", TODAY, "es")).toBe("lunes");
    expect(carriedDay("2026-09-12", TODAY)).toBe("Sep 12, 2026");
    expect(carriedDay("2026-09-12", TODAY, "es")).toBe(formatDate("2026-09-12", undefined, "es"));
  });
});
