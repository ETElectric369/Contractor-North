import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE FENCE ASKS FOR THE DAILY REPORT (cn-v1175). The owner, 2026-11-21: "ask which job the report
 * is being made for at the time of the report [...] on clock out". cn-v1174 opened the sheet on three
 * doors; the site fence's own clock-out prompt now opens it too, through ONE window event heard by
 * ONE host at the layout's root, and only on a close the person answered.
 */
vi.mock("./actions", () => ({
  fileDailyReport: vi.fn(),
  dailyReportJobChoices: vi.fn(async () => ({ ok: true, decided: null, dayJobs: [], otherJobs: [] })),
}));

import { FENCE_REPORT_EVENT } from "@/lib/fence-report-event";
import { FenceReportHost, listenForFenceReport } from "./fence-report-host";

const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

describe("the host opens on the fence's one event, and only for a person the rule asks", () => {
  it("the event opens it; another event does not; the cleanup stops listening", () => {
    const target = new EventTarget();
    const onAsk = vi.fn();
    const stop = listenForFenceReport(target, true, onAsk);
    target.dispatchEvent(new Event("cn:setup"));
    expect(onAsk).not.toHaveBeenCalled();
    target.dispatchEvent(new Event(FENCE_REPORT_EVENT));
    expect(onAsk).toHaveBeenCalledTimes(1);
    stop();
    target.dispatchEvent(new Event(FENCE_REPORT_EVENT));
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("a person the rule does not ask: nothing listens and nothing is drawn", () => {
    const target = new EventTarget();
    const onAsk = vi.fn();
    listenForFenceReport(target, false, onAsk)();
    target.dispatchEvent(new Event(FENCE_REPORT_EVENT));
    expect(onAsk).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(createElement(FenceReportHost, { asks: false }))).toBe("");
  });

  it("asked but not yet opened, it draws nothing in the flow", () => {
    expect(renderToStaticMarkup(createElement(FenceReportHost, { asks: true }))).toBe("");
  });

  it("is the same sheet as the other three doors, portalled, never keyed", () => {
    const host = src("src/app/(app)/timeclock/fence-report-host.tsx");
    expect(host).toContain('import { DailyReportDebrief } from "./daily-report-debrief";');
    expect(host).toContain("<DailyReportDebrief open={open} onClose={() => setOpen(false)} portal />");
    expect(host).not.toMatch(/\bkey=/);
    expect(host).toContain("useEffect(() => listenForFenceReport(window, asks, () => setOpen(true)), [asks]);");
  });
});

describe("the layout mounts it at the root, outside the open-shift branch, by the one rule and no new read", () => {
  const layout = src("src/app/(app)/layout.tsx");
  const mount = "<FenceReportHost asks={asksForDailyReport(profile.crew_lead, features)} />";

  it("once, beside Report a Problem, after the page's column has closed", () => {
    expect(layout.split(mount).length - 1).toBe(1);
    expect(layout).toContain('import { asksForDailyReport } from "@/lib/daily-report-rule";');
    const at = layout.indexOf(mount);
    expect(at).toBeGreaterThan(layout.indexOf("</main>"));
    expect(at).toBeGreaterThan(layout.indexOf("<BugReporter orgId={profile.org_id} platformAdmin={platformAdmin} />"));
    // Not inside the monitor's branch: that branch closes before <main> opens.
    expect(layout.indexOf("{openEntry && (")).toBeLessThan(layout.indexOf('<main className="turn-host'));
  });

  it("crew_lead is already in the profile read the layout makes (no new read)", () => {
    expect(src("src/lib/profile-columns.ts")).toMatch(/PROFILE_SAFE_COLS =\s*"[^"]*\bcrew_lead\b/);
  });
});

describe("the monitor fires the event only on a close the person answered", () => {
  const monitor = src("src/components/geofence-monitor.tsx");
  const line = "if (!auto && !res.undone) window.dispatchEvent(new Event(FENCE_REPORT_EVENT));";

  it("one line, once, after the close landed and before the refresh that unmounts the monitor", () => {
    expect(monitor.split("FENCE_REPORT_EVENT").length - 1).toBe(2); // the import and the one line
    expect(monitor.split(line).length - 1).toBe(1);
    const at = monitor.indexOf(line);
    expect(at).toBeGreaterThan(monitor.indexOf('setPhase("confirmed");'));
    expect(at).toBeLessThan(monitor.indexOf("setTimeout(() => router.refresh(), 2600);"));
    // `auto` is the unattended close in submit(); the person's two doors pass false.
    expect(monitor).toContain("submit(lastFixRef.current, new Date().toISOString(), false, false);");
    expect(monitor).toContain("submit(lastFixRef.current, iso, false, true);");
  });

  it("nothing else in the app fires it", async () => {
    const { execSync } = await import("node:child_process");
    const hits = execSync(`grep -rl --exclude=*.test.ts --exclude=*.test.tsx "dispatchEvent(new Event(FENCE_REPORT_EVENT" src || true`, { cwd: process.cwd() }).toString().trim().split("\n").filter(Boolean);
    expect(hits).toEqual(["src/components/geofence-monitor.tsx"]);
  });
});
