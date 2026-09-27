import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * AN offStrip TAB STILL OPENS FROM ITS LINK. Its chip is not drawn, but a ?tab= link (a bell, a
 * Needs You card, a switched-off feature's tab) lands on it and its content renders. Before the
 * switch board this was broken: <Tabs> dropped offStrip tabs from the list entirely, so the link
 * opened the Overview instead. (A job's Tasks rode this rail until 0358 made it a pinned chip; the
 * example here is a switched-off Permits tab.)
 */
let search = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/jobs/j1",
  useSearchParams: () => new URLSearchParams(search),
}));

import { Tabs, type TabDef } from "./tabs";

const TABS: TabDef[] = [
  { id: "job", label: "Overview", pinned: true, content: "OVERVIEW-BODY" },
  { id: "permits", label: "Permits", offStrip: true, content: "PERMITS-BODY" },
  { id: "time", label: "Time", pinned: true, content: "TIME-BODY" },
];
const render = (tabs: TabDef[] = TABS, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(Tabs, { tabs, look: "tiles", ...extra }));

describe("an offStrip tab", () => {
  beforeEach(() => {
    search = "";
  });

  it("opens from ?tab= with its content, and still has no chip", () => {
    search = "tab=permits";
    const html = render();
    expect(html).toContain("PERMITS-BODY");
    expect(html).not.toContain("OVERVIEW-BODY");
    expect(html).not.toMatch(/>Permits</);
    expect(html).toMatch(/>Overview</);
  });

  it("with no link, the strip opens on the first tab that has a chip", () => {
    const html = render([TABS[1], TABS[0], TABS[2]]);
    expect(html).toContain("OVERVIEW-BODY");
    expect(html).not.toContain("PERMITS-BODY");
  });

  it("a staff-only offStrip tab stays closed to a tech even by link", () => {
    search = "tab=permits";
    const html = render([TABS[0], { ...TABS[1], staffOnly: true }], { viewerIsStaff: false });
    expect(html).toContain("OVERVIEW-BODY");
    expect(html).not.toContain("PERMITS-BODY");
  });

  it("controlled mode (the bills page): the active offStrip tab has no chip", () => {
    const html = render(TABS, { activeId: "permits", onChange: () => {} });
    expect(html).toContain("PERMITS-BODY");
    expect(html).not.toMatch(/>Permits</);
  });
});

describe("the job's Tasks chip (0358)", () => {
  const JOB: TabDef[] = [
    { id: "job", label: "Overview", pinned: true, content: "OVERVIEW-BODY" },
    { id: "tasks", label: "Tasks", pinned: true, count: 7, content: "TASKS-BODY" },
    { id: "time", label: "Time", pinned: true, content: "TIME-BODY" },
  ];
  beforeEach(() => {
    search = "";
  });

  it("is drawn right after Overview, wearing its open count", () => {
    const html = render(JOB);
    expect(html.indexOf(">Overview<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Overview<")).toBeLessThan(html.indexOf(">Tasks<"));
    expect(html.indexOf(">Tasks<")).toBeLessThan(html.indexOf(">Time<"));
    expect(html).toMatch(/>Tasks<\/span><span[^>]*>7<\/span>/);
  });

  it("?tab=tasks (a task's link, the Overview card's All Tasks) opens the list, chip lit", () => {
    search = "tab=tasks";
    const html = render(JOB);
    expect(html).toContain("TASKS-BODY");
    expect(html).toMatch(/aria-current="page"[^>]*>(?:(?!<\/button>)[\s\S])*>Tasks</);
  });
});
