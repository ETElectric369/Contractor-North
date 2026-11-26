import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "@/components/lang-provider";

/**
 * A HOLD'S DAY IS A REMINDER (cn-v1189). The owner, from My Day: "the on hold: Back Nov 29 is confusing
 * so if that means its a reminder then lets call it Reminder Set Nov 29 and file it with reminders and
 * the on hold stays put". On its day a held job is drawn FIRST in Tasks & Reminders: the job, On Hold and
 * its reason, Reminder Today; no checkbox (it is not a task); the row opens the job; its ⋯ holds Pick
 * Another Day (the hold's snooze), Take Off Hold and Open the Job, through doors that exist. Derived from
 * the Needs You build: nothing is written to tasks, and it is never in the progress marks.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/planner",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../tasks/actions", () => ({ createTask: vi.fn(), toggleTask: vi.fn(), deleteTask: vi.fn(), updateTask: vi.fn() }));
vi.mock("../schedule/actions", () => ({ setJobHold: vi.fn(), snoozeJobHold: vi.fn() }));

import { YourList, type SixSlot } from "./your-list";
import { holdReminderWords, pickedDay } from "./hold-reminder-row";
import type { HoldReminder } from "@/lib/action-items/types";

const TODAY = "2026-11-29";
const hold = (o: Partial<HoldReminder> = {}): HoldReminder => ({
  jobId: "j941",
  title: "Larkspur Deck · J-941",
  jobNumber: "J-941",
  name: "Larkspur Deck",
  reason: "Waiting on the permit",
  holdUntil: TODAY,
  href: "/jobs/j941",
  ...o,
});
const row = (o: Partial<SixSlot> = {}): SixSlot => ({ id: "r1", title: "Call the PUD", category: "operations", priority: 0, due_date: TODAY, job_id: null, focus_date: null, ...o });
const en = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const es = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: el }));
const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

describe("the row's words", () => {
  it("the job, On Hold and its reason, Reminder Today; in Spanish too; no reason saved said in words", () => {
    expect(holdReminderWords(hold(), TODAY)).toEqual({ title: "Larkspur Deck · J-941", sub: "On Hold · Waiting on the permit", chip: "Reminder Today" });
    expect(holdReminderWords(hold({ holdUntil: "2026-11-20" }), TODAY).chip).toBe("Reminder Today");
    expect(holdReminderWords(hold({ reason: null }), TODAY).sub).toBe("On Hold · no reason saved");
    expect(holdReminderWords(hold(), TODAY, "es")).toEqual({ title: "Larkspur Deck · J-941", sub: "En Pausa · Waiting on the permit", chip: "Recordatorio Hoy" });
  });

  it("the day a pick means, for the sentence after it lands", () => {
    expect(pickedDay({ date: "2026-12-06" }, TODAY)).toBe("2026-12-06");
    expect(pickedDay({ pick: "tomorrow" }, TODAY)).toBe("2026-11-30");
  });
});

describe("Tasks & Reminders draws the holds first", () => {
  it("above the ranked Reminders, a pause mark and no checkbox, opening the job, with its ⋯; never in the progress marks", () => {
    const html = en(createElement(YourList, { rows: [row()], holds: [hold()], subtasks: [], todayStr: TODAY, doneToday: 0, restCount: 0 }));
    const at = html.indexOf('data-hold-reminder="j941"');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf("Call the PUD"));
    const li = html.slice(at, html.indexOf("</li>", at));
    expect(li).toContain('href="/jobs/j941"');
    expect(li).toContain("Larkspur Deck · J-941");
    expect(li).toContain("On Hold · Waiting on the permit");
    expect(li).toContain(">Reminder Today<");
    expect(li).toContain("lucide-pause");
    expect(li).not.toContain("Mark ");
    expect(li).toContain("min-h-[44px]");
    expect(li).toContain('aria-label="More for Larkspur Deck · J-941"');
    // The marks count the one Reminder, never the hold.
    expect(html).toContain('aria-label="0 of 1 done today"');
  });

  it("a day with only a hold: the hold, and not the empty line", () => {
    const html = en(createElement(YourList, { rows: [], holds: [hold()], subtasks: [], todayStr: TODAY, doneToday: 0, restCount: 0 }));
    expect(html).toContain('data-hold-reminder="j941"');
    expect(html).not.toContain("Nothing urgent today.");
    const none = en(createElement(YourList, { rows: [], subtasks: [], todayStr: TODAY, doneToday: 0, restCount: 0 }));
    expect(none).toContain("Nothing urgent today.");
    expect(none).not.toContain("data-hold-reminder");
  });

  it("in Spanish", () => {
    const html = es(createElement(YourList, { rows: [], holds: [hold()], subtasks: [], todayStr: TODAY, doneToday: 0, restCount: 0 }));
    expect(html).toContain("En Pausa · Waiting on the permit");
    expect(html).toContain(">Recordatorio Hoy<");
  });
});

describe("the doors are the ones that exist; nothing is written to tasks", () => {
  it("Pick Another Day is the hold's snooze, Take Off Hold is setJobHold(id, null), Open the Job the job's page", () => {
    const row = src("src/app/(app)/planner/hold-reminder-row.tsx");
    expect(row).toContain('import { setJobHold, snoozeJobHold } from "../schedule/actions";');
    expect(row).toContain("await snoozeJobHold(hold.jobId, when, why || null)");
    expect(row).toContain("await setJobHold(hold.jobId, null)");
    expect(row).toContain('<SheetLink href={hold.href}>{t("ag_btn_openTheJob")}</SheetLink>');
    expect(row).toContain('t("ny_btn_takeOffHold")');
    expect(row).toContain('t("md_btn_pickAnotherDay")');
    // A snooze asks why only when no reason is saved, as the job pill's does.
    expect(row).toContain("askWhy={!hold.reason?.trim()}");
    // No second server door, and no task written.
    expect(row).not.toContain('"use server"');
    expect(row).not.toMatch(/createTask|updateTask|toggleTask|from\("tasks"\)/);
  });

  it("My Day hands the build's own list to the card", () => {
    const page = src("src/app/(app)/planner/page.tsx");
    expect(page).toContain("holds={needsYou.reminders}");
  });
});
