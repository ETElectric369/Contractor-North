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

import { JobCrewCard, JobCrewChips } from "./job-crew-card";
import { pillColorForPerson } from "@/lib/employee-color";

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

/**
 * ONE PERSON IS ONE COLOR (Wave 2, SV-chips): the schedule tile's crew chips (JobCrewChips) draw each
 * person's circle in their own color, the /timecards person color their chip on the tile and their bar
 * on a worked day wear too. The job page's crew card keeps its look; the crew logic is untouched.
 */
describe("the tile's crew chips, each in their person's color", () => {
  const chips = (canEdit: boolean, people = crew) =>
    renderToStaticMarkup(createElement(JobCrewChips, { jobId: "j1", crew: people, team: crew, canEdit }));

  it("each circle wears its person's color, 44px, for the office", () => {
    const html = chips(true);
    for (const p of crew) {
      const tag = (html.match(new RegExp(`<button[^>]*aria-label="${p.full_name}"[^>]*>`)) ?? [""])[0];
      expect(tag, p.full_name).toContain(pillColorForPerson(p.id).dot);
      expect(tag).toMatch(/\bh-11 w-11\b/);
      expect(tag).not.toContain("bg-brand");
    }
  });

  it("the crew reads the same colors with nothing to tap; an empty crew is a dashed Nobody", () => {
    const html = chips(false);
    expect(html).not.toContain("<button");
    expect(html).toContain(pillColorForPerson("p1").dot);
    expect(chips(true, [])).toMatch(/<span[^>]*border-dashed[^>]*>Nobody<\/span>/);
  });

  it("the job page's card keeps its look: brand avatars, no person colors", () => {
    const html = r({});
    expect(html).toContain("bg-brand text-[10px]");
    for (const p of crew) expect(html).not.toContain(pillColorForPerson(p.id).dot);
  });
});
