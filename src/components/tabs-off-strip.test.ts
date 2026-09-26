import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * AN offStrip TAB STILL OPENS FROM ITS LINK. Its chip is not drawn, but a ?tab= link (the action
 * dock's Tasks slot, a bell, a Needs You card, a switched-off feature's tab) lands on it and its
 * content renders. Before the switch board this was broken: <Tabs> dropped offStrip tabs from the
 * list entirely, so ?tab=tasks opened the Overview instead.
 */
let search = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/jobs/j1",
  useSearchParams: () => new URLSearchParams(search),
}));

import { Tabs, type TabDef } from "./tabs";

const TABS: TabDef[] = [
  { id: "job", label: "Overview", pinned: true, content: "OVERVIEW-BODY" },
  { id: "tasks", label: "Tasks", pinned: true, offStrip: true, content: "TASKS-BODY" },
  { id: "time", label: "Time", pinned: true, content: "TIME-BODY" },
];
const render = (tabs: TabDef[] = TABS, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(Tabs, { tabs, look: "tiles", ...extra }));

describe("an offStrip tab", () => {
  beforeEach(() => {
    search = "";
  });

  it("opens from ?tab= with its content, and still has no chip", () => {
    search = "tab=tasks";
    const html = render();
    expect(html).toContain("TASKS-BODY");
    expect(html).not.toContain("OVERVIEW-BODY");
    expect(html).not.toMatch(/>Tasks</);
    expect(html).toMatch(/>Overview</);
  });

  it("with no link, the strip opens on the first tab that has a chip", () => {
    const html = render([TABS[1], TABS[0], TABS[2]]);
    expect(html).toContain("OVERVIEW-BODY");
    expect(html).not.toContain("TASKS-BODY");
  });

  it("a staff-only offStrip tab stays closed to a tech even by link", () => {
    search = "tab=tasks";
    const html = render([TABS[0], { ...TABS[1], staffOnly: true }], { viewerIsStaff: false });
    expect(html).toContain("OVERVIEW-BODY");
    expect(html).not.toContain("TASKS-BODY");
  });

  it("controlled mode (the bills page): the active offStrip tab has no chip", () => {
    const html = render(TABS, { activeId: "tasks", onChange: () => {} });
    expect(html).toContain("TASKS-BODY");
    expect(html).not.toMatch(/>Tasks</);
  });
});
