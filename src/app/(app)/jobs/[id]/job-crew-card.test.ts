import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE CREW ON THE OVERVIEW (W1-22): the office's 44px chips (tap one to take that person off, + Add
 * to put someone on, both as ONE change through changeJobCrew, which writes via setJobCrew, the one
 * crew writer); the crew reads the same chips.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("../../schedule/actions", () => ({ changeJobCrew: vi.fn(async () => ({ ok: true })) }));

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
    expect(s).toContain("await changeJobCrew(jobId, change)");
    expect(s).toContain("setCrew(prev)");
    expect(s).toContain("Take {nameOf(asking)} Off This Job?");
  });
});

describe("a stale page never takes anyone off (someone else put Brian on meanwhile)", () => {
  const card = () => readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-crew-card.tsx"), "utf8");

  it("Add and Take Off send one change, never the whole list the page loaded", () => {
    const s = card();
    expect(s).toContain("write({ remove: asking },");
    expect(s).toContain("write({ add: m.id },");
    expect(s).not.toMatch(/setJobCrew\(/);
    expect(s).not.toMatch(/write\(\[\.\.\.crew/);
    expect(s).not.toMatch(/write\(crew\.filter/);
  });

  it("the server applies it to the crew as stored now, through the one crew writer", () => {
    const a = readFileSync(join(process.cwd(), "src/app/(app)/schedule/actions.ts"), "utf8");
    const fn = a.slice(a.indexOf("export async function changeJobCrew"), a.indexOf("/** Offer the customer up to 3"));
    expect(fn).toContain('.from("jobs").select("assigned_to").eq("id", id).maybeSingle()');
    expect(fn).toContain("applyCrewChange(");
    expect(fn).toContain("await setJobCrew(id, next)");
    expect(fn).not.toMatch(/\.update\(/);
  });

  it("when the page refreshes with a new crew and nothing is being written, the chips take it", () => {
    const s = card();
    expect(s).toContain('const serverKey = initialCrew.map((c) => c.id).join(",");');
    expect(s).toMatch(/if \(serverKey !== seenKey && !pending\) \{\s*setSeenKey\(serverKey\);\s*setCrew\(initialCrew\.map\(\(c\) => c\.id\)\);/);
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
