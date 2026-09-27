import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * EDIT REMINDER'S WHO IT'S FOR (0358). A Reminder is its maker's and its person's, and only the maker
 * can hand it to someone else (tasks_update's check refuses anyone else's change). So only the maker is
 * offered the picker; the person it's for reads who it's for and why they can't change it.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/tasks",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("./actions", () => ({ createTask: vi.fn(), toggleTask: vi.fn(), deleteTask: vi.fn(), updateTask: vi.fn() }));

import { TaskEditModal, type ViewTask } from "./tasks-view";

const REMINDER: ViewTask = {
  id: "t1",
  title: "Grab the ladder",
  category: null,
  status: "open",
  priority: 0,
  due_date: null,
  job_id: null,
  assigned_to: "user-brian",
  created_by: "user-erik",
  assignee: { full_name: "Brian Smith" },
};
const PEOPLE = [
  { id: "user-erik", full_name: "Erik Taylor" },
  { id: "user-brian", full_name: "Brian Smith" },
];
const modal = (viewerId: string) =>
  renderToStaticMarkup(
    createElement(TaskEditModal, { t: REMINDER, people: PEOPLE, category: null, open: true, onClose: () => {}, viewerId }),
  );

describe("Edit Reminder: Who It's For", () => {
  it("the maker gets the picker", () => {
    const html = modal("user-erik");
    expect(html).toContain('id="te-person"');
    expect(html).not.toContain("Only the person who made it");
  });

  it("the person it's for reads it, with the reason, and gets no picker to be refused on", () => {
    const html = modal("user-brian");
    expect(html).not.toContain('id="te-person"');
    expect(html).toContain("You");
    expect(html).toContain("Only the person who made it can hand it to someone else.");
  });
});
