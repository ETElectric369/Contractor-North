import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * MY DAY AND THE SWITCH BOARD (0352). The Open Leads card goes with Leads; the Daily Reports card
 * goes with Daily Reports once nothing is left to review (until then it stays, Off line on top);
 * the task box asks no priority with To-Do Extras off. Everything on = My Day as it was.
 *
 * The task box is rendered OPEN (its details reveal on focus, which a static render can't do), so
 * the useState(false) calls start true here. Nothing else about React is replaced.
 */
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (init: unknown) => actual.useState(init === false ? true : init) };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/planner",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../tasks/actions", () => ({ createTask: vi.fn(), toggleTask: vi.fn(), deleteTask: vi.fn(), updateTask: vi.fn() }));

import { NewTaskBox } from "../tasks/tasks-view";

const box = (extras?: boolean) =>
  renderToStaticMarkup(createElement(NewTaskBox, { jobs: [], people: [], todayStr: "2026-09-26", ...(extras === undefined ? {} : { extras }) }));

describe("NewTaskBox — To-Do Extras", () => {
  it("on (or not said): the priority picker, as before", () => {
    expect(box()).toContain('aria-label="Priority"');
    expect(box(true)).toContain('aria-label="Priority"');
  });

  it("off: no priority picker (a new task is Normal); the rest of the box is unchanged", () => {
    const html = box(false);
    expect(html).not.toContain('aria-label="Priority"');
    expect(html).toContain('aria-label="Due date"');
    expect(html).toContain('aria-label="Job"');
  });
});

describe("My Day's cards (structural: the page is a server component over the database)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/planner/page.tsx"), "utf8");

  it("the Open Leads card and its read go with Leads", () => {
    expect(page).toContain("{isStaff && leadsOn ? (");
    expect(page).toMatch(/leadsOn\s*\?\s*supabase\s*\.from\("inquiries"\)/);
  });

  it("the Daily Reports card stays while a report waits for review, with the Off line on top", () => {
    expect(page).toContain("(reportsOn || reportsToReview > 0)");
    expect(page).toContain('<FeatureOffLine feature="daily_reports"');
  });

  it("the task box hears To-Do Extras, and Needs You hears every switch", () => {
    expect(page).toContain('extras={featureOn(features, "todo_extras")}');
    expect(page).toContain("off: offFeatureKey(features)");
  });
});
