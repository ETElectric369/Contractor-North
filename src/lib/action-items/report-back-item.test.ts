import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { reportBackActionItem } from "./report-back-item";
import { AFFORDANCES, KIND_META, KIND_STREAM } from "./types";
import { WAITABLE_KINDS } from "./needs-you-waits";
import { pileOf } from "./piles";
import { rowButtons } from "./row-buttons";
import { resolveRowVerb } from "./dispatch-map";

const standing = { hoursIn: 6, guessHours: 8, lastWorked: "2026-10-07T14:30:00.000Z", sentence: "6h in · guess was 8h" };

/** The report-back row (cn-v1069): its words, its door, its snooze, and that the build feeds it. */
describe("the Report Back row", () => {
  it("names the person and the job by name, opens the job's card, and is an endless row with a Snooze once waits are on", () => {
    const it = reportBackActionItem({ id: "j1", job_number: "J-047", name: "The kitchen place", customer: { name: "Dana Reyes" } }, standing, true);
    expect(it).toMatchObject({
      id: "reportback-j1",
      kind: "job_report_back",
      title: "Tell Dana Where It Stands",
      subtitle: "The kitchen place · J-047 · 6h in · guess was 8h",
      href: "/jobs/j1#report-back",
      when: "2026-10-07T14:30:00.000Z",
      affordances: ["snooze", "open"],
      waitKey: "job_report_back:j1",
    });
    const noWaits = reportBackActionItem({ id: "j1", job_number: "J-047", name: null, customer: null }, standing, false);
    expect(noWaits.title).toBe("Tell The Customer Where It Stands");
    expect(noWaits.affordances).toEqual(["open"]);
    expect(noWaits.waitKey).toBeUndefined();
  });

  it("is in the grammar: today's stream, a plain chip, open-only in the table, snoozable, never piled", () => {
    expect(KIND_STREAM.job_report_back).toBe("today");
    expect(KIND_META.job_report_back).toEqual({ label: "Report Back", tone: "blue" });
    expect(AFFORDANCES.job_report_back).toEqual(["open"]);
    expect(WAITABLE_KINDS).toContain("job_report_back");
    expect(pileOf({ kind: "job_report_back", id: "reportback-j1" })).toBeNull();
  });

  it("its button is Tell Them, its ⋯ the Snooze, and the Snooze writes the JOB (prefix stripped)", () => {
    const it = reportBackActionItem({ id: "j1", job_number: "J-047", name: "The kitchen place", customer: { name: "Dana" } }, standing, true);
    const b = rowButtons(it as never, { leadsOn: true, isStaff: true });
    expect(b.primary).toEqual({ label: "Tell Them", act: { type: "open", href: "/jobs/j1#report-back" } });
    expect(b.more.map((d) => d.label)).toEqual(["Snooze"]);
    expect(resolveRowVerb("job_report_back", "snooze", "reportback-j1", { date: "2026-10-10", reason: "Waiting on the panel" })).toEqual({
      name: "job.snoozeNeedsYou",
      input: { id: "j1", kind: "job_report_back", date: "2026-10-10", reason: "Waiting on the panel" },
    });
    expect(resolveRowVerb("job_report_back", "snooze", "j1", { date: "2026-10-10" })).toBeNull();
  });

  it("the build feeds it from the bounded time read, through the rule, bounded by the window (the badge law)", () => {
    const src = readFileSync(new URL("./query.ts", import.meta.url), "utf8");
    expect(src).toContain("reportBackDue(");
    expect(src).toContain("windowDays: NEEDS_RETURN_DAYS");
    expect(src).toContain("reportBackActionItem(");
    expect(src).toContain('.is("report_back_at", null)');
    expect(src).toContain('.eq("billing_type", "tm")');
    expect(src).toContain('.eq("status", "in_progress")');
  });
});
