import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

/**
 * TIMECARDS, CUT DOWN (Wave 2, W2-02). No approver nobody asks, no approval settings nothing reads,
 * no pencil and no copy icon on a row the whole of which already opens the shift, no "manual" badge
 * on every hand-typed row. Nothing silent and no dead end: the editor says where a shift's time came
 * from, and Copy To Someone Else… lives in it.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../settings/actions", () => ({ updateOrgSettings: vi.fn(async () => ({ ok: true })) }));
vi.mock("../settings/features-actions", () => ({ setFeature: vi.fn(async () => ({ ok: true })) }));

import { SchedulingSettings } from "../settings/scheduling-settings";
import { getOrgSettings } from "@/lib/org-settings";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("no approver, and no approval settings", () => {
  it("Settings › Scheduler & timesheets asks neither the tracking method nor a supervisor", () => {
    for (const isOwner of [true, false]) {
      const html = renderToStaticMarkup(createElement(SchedulingSettings, { settings: getOrgSettings({}), isOwner }));
      expect(html).not.toContain("Time tracking method");
      expect(html).not.toContain("Timecard supervisor");
      expect(html).not.toContain("approves timecards");
      // The grid keeps the working day and the week.
      expect(html).toContain("Working day starts");
      expect(html).toContain("Working day ends");
      expect(html).toContain("Week starts on");
    }
  });

  it("a stored supervisor or method is left alone and never read: Save sends neither key", () => {
    const form = src("../settings/scheduling-settings.tsx");
    expect(form).not.toMatch(/time_tracking_method|timecard_supervisor_id/);
    expect(form).not.toMatch(/employees|ownerName/);
    expect(src("../../../lib/org-settings.ts")).not.toMatch(/time_tracking_method:|timecard_supervisor_id:/);
    // The call site passes neither prop any more.
    const settingsPage = src("../settings/page.tsx");
    expect(settingsPage).not.toMatch(/<SchedulingSettings[^>]*employees=/);
    expect(settingsPage).not.toMatch(/ownerName=/);
  });

  it("the Timecards header says what the page is for, and names no approver", () => {
    const page = src("./page.tsx");
    expect(page).toContain('<PageHeader title="Timecards" description="Review your crew\'s hours by week.">');
    expect(page).not.toMatch(/Approver|timecard_supervisor_id|supId/);
  });
});
