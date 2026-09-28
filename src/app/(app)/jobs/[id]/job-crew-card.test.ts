import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE CREW ON THE OVERVIEW (W1-22): the office's 44px chips (tap one to take that person off, + Add
 * to put someone on, both through setJobCrew, the one crew writer); the crew reads the same chips.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("../../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import { JobCrewCard } from "./job-crew-card";

const crew = [
  { id: "p1", full_name: "Brian Cole" },
  { id: "p2", full_name: "Erik Taylor" },
];
const r = (p: Partial<Parameters<typeof JobCrewCard>[0]>) =>
  renderToStaticMarkup(createElement(JobCrewCard, { jobId: "j1", crew, viewerIsStaff: true, team: [...crew, { id: "p3", full_name: "Sam Ortiz" }], ...p }));

describe("the office", () => {
  it("each person is a 44px chip, and + Add sits after them", () => {
    const html = r({});
    expect(html.match(/<button[^>]*min-h-11[^>]*>(?:(?!<\/button>)[\s\S])*Brian Cole<\/button>/)).toBeTruthy();
    expect(html.match(/<button[^>]*min-h-11[^>]*>(?:(?!<\/button>)[\s\S])*Erik Taylor<\/button>/)).toBeTruthy();
    expect(html).toMatch(/<button[^>]*min-h-11[^>]*>(?:<svg[\s\S]*?<\/svg>)?\s*Add<\/button>/);
    // Nobody is asked about until a chip is tapped; the team list is closed.
    expect(html).not.toContain("Off This Job?");
    expect(html).not.toContain("Sam Ortiz");
  });

  it("no one on it yet says so", () => {
    expect(r({ crew: [] })).toContain("No one is on this job yet.");
  });

  it("the one crew writer, and a refusal backs the chips out with words (source)", () => {
    const s = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-crew-card.tsx"), "utf8");
    expect(s).toContain("await setJobCrew(jobId, next)");
    expect(s).toContain("setCrew(prev)");
    expect(s).toContain("Take {nameOf(asking)} Off This Job?");
  });
});

describe("the crew", () => {
  it("reads the same names, with nothing to tap", () => {
    const html = r({ viewerIsStaff: false, team: [] });
    expect(html).toContain("Brian Cole");
    expect(html).toContain("Erik Taylor");
    expect(html).not.toContain("<button");
  });
});
