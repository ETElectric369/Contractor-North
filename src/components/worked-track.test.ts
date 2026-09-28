import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE WORKED TRACK (Wave 2, SV-actual; TEXT TO VISUAL): on a past day the day drill's job card draws
 * what happened as a small track under the block: the booked span as an outline, each person's bars in
 * their own color with their initials, and the sentence as its label. A ghost (nothing booked) has bars
 * only. No money.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { WorkedTrack } from "./worked-track";
import { JobScheduleCard } from "@/app/(app)/schedule/job-schedule-card";
import { mergePeople } from "@/lib/schedule/plan-vs-actual";
import { tzDateTimeUtc } from "@/lib/tz";

const people = mergePeople(
  [
    { profileId: "p-erik", name: "Erik Taylor", jobId: "j46", dayStr: "2026-09-22", startMin: 600, endMin: 1080 },
    { profileId: "p-jimmy", name: "Jimmy Ruiz", jobId: "j46", dayStr: "2026-09-22", startMin: 720, endMin: null },
  ],
  (s) => Math.max(1020, s + 15),
);
const sentence = "Booked 9–5 · Erik 10–6 · Jimmy in at 12, never clocked out · 1h late";

describe("the track", () => {
  it("the booked span is an outline; each person a bar in their color with initials; the sentence the label", () => {
    const html = renderToStaticMarkup(createElement(WorkedTrack, { booked: { startMin: 540, endMin: 1020 }, people, sentence }));
    // 9 to 5 on a 9-to-6 track: from 0% for 88.89%.
    expect(html).toMatch(/<span data-booked="true" class="absolute inset-y-0 rounded-sm border border-slate-400 bg-white" style="left:0\.00%;width:88\.89%"/);
    expect(html).toContain(`>${people[0].initials}</span>`);
    expect(html).toContain(people[0].dot);
    expect(html).toContain(people[1].dot);
    // Never clocked out: the bar fades.
    expect(html).toMatch(/mask-image:linear-gradient\(to right/);
    expect(html).toContain(`role="img" aria-label="${sentence}"`);
    expect(html).toContain(`<p class="text-[11px] leading-snug text-slate-600">${sentence}</p>`);
  });

  it("work nobody booked: the bars alone, no outline", () => {
    const html = renderToStaticMarkup(createElement(WorkedTrack, { booked: null, people, sentence: "Erik 10–6" }));
    expect(html).not.toContain("data-booked");
    expect(html).toContain(people[0].dot);
  });
});

describe("the day drill's card on a past day", () => {
  it("draws the track under its block; with no actual, none", () => {
    const LA = "America/Los_Angeles";
    const job = {
      id: "j46",
      name: "12 Elm St",
      job_number: "J-046",
      status: "in_progress",
      scheduled_start: tzDateTimeUtc("2026-09-21", "09:00", LA),
      scheduled_end: tzDateTimeUtc("2026-09-25", "17:00", LA),
      planned_minutes: null,
      assigned_to: ["p-erik"],
      customers: { name: "Rita Moss" },
    };
    const base = { job, members: [{ id: "p-erik", full_name: "Erik Taylor" }], tz: LA, workDay: { start: "09:00", end: "17:00" }, day: "2026-09-22" };
    const withTrack = renderToStaticMarkup(createElement(JobScheduleCard, { ...base, actual: { booked: { startMin: 540, endMin: 1020 }, people, sentence } }));
    expect(withTrack).toContain(`aria-label="${sentence}"`);
    const plain = renderToStaticMarkup(createElement(JobScheduleCard, base));
    expect(plain).not.toContain("role=\"img\"");
  });
});
