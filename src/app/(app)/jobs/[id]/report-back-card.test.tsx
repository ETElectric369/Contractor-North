import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE REPORT BACK CARD, RENDERED (cn-v1069): the standing, a Text door that is a phone hand-off with
 * the figures in it, a Told Them door that stamps once, and the after-state with its Undo. Every door
 * 44px and Title Case; counted on the real component (the dead-door lesson).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../actions", () => ({ markReportedBack: vi.fn() }));

import { ReportBackCard } from "./report-back-card";

const base = {
  jobId: "j1",
  jobName: "the kitchen hood outlet",
  customerFirst: "Dana",
  phone: "5305550100",
  sentence: "6h in · guess was 8h",
  hoursIn: 6,
  guessHours: 8,
  reportedAt: null,
  tz: "America/Los_Angeles",
};
const html = (o: Partial<Parameters<typeof ReportBackCard>[0]>) => renderToStaticMarkup(createElement(ReportBackCard, { ...base, ...o }));
const doors = (s: string) => [...(s.match(/<(?:button|a)[^>]*>/g) ?? [])];

describe("the Report Back card", () => {
  it("before Told Them: the standing, Text Dana as an sms hand-off carrying the figures, and Told Them — both 44px", () => {
    const s = html({});
    expect(s).toContain('id="report-back"');
    expect(s).toContain("6h in · guess was 8h");
    expect(s).toContain("Dana hasn&#x27;t been told where it stands yet.");
    expect(s).toContain("Text Dana");
    expect(s).toContain(">Told Them<");
    expect(s).toContain('href="sms:5305550100&amp;body=Hi%20Dana%2C%20quick%20update%20on%20the%20kitchen%20hood%20outlet%3A%20we%27re%20about%206%20hours%20in%20of%20the%208%20we%20figured.');
    const d = doors(s);
    expect(d).toHaveLength(2);
    for (const m of d) expect(m).toContain("min-h-[44px]");
  });

  it("after Told Them: the day it was said, an Undo, the Text door still there, no second stamp", () => {
    const s = html({ reportedAt: "2026-10-07T20:00:00.000Z" });
    expect(s).toContain("Told them Oct 7, 2026");
    expect(s).toContain(">Undo<");
    expect(s).toContain("Text Dana");
    expect(s).not.toContain(">Told Them<");
  });

  it("no phone on the card: no text door, and it says so instead of a dead button; no name: Text Them", () => {
    const s = html({ phone: null });
    expect(s).not.toContain("sms:");
    expect(s).toContain("No phone on the customer");
    expect(doors(s)).toHaveLength(1);
    expect(html({ customerFirst: null })).toContain("Text Them");
  });

  it("Told Them stamps once and a zero-row write is refused, never reported saved (silent-write law)", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/actions.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function markReportedBack"), src.indexOf("export async function updateJobDescription"));
    expect(fn).toContain('q = told ? q.is("report_back_at", null) : q.not("report_back_at", "is", null);');
    expect(fn).toContain('await q.select("id")');
    expect(fn).toContain("if (!data?.length) {");
    expect(fn).toContain('revalidatePath("/planner")');
  });

  it("the job page mounts it under the running total for the office on a T&M job with closed time", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    expect(page).toContain("reportBackStanding(");
    expect(page).toContain("<ReportBackCard");
    expect(page).toMatch(/viewerIsStaff && importsActuals && \(j as any\)\.billing_type === "tm" && \(reportBack\.hoursIn > 0 \|\| j\.report_back_at\)/);
  });
});
