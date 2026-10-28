/**
 * THE CREW PULSE LIVES WITH THE CLOCK (Erik, 2026-10-13: "the who's on the clock should just live
 * with the timeclock"). Who else is on the clock sits inside My Day's Now card for the office,
 * shaped by one pure helper over the same read Timecards draws.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { crewPulse, crewForCard, sinceWords } from "@/lib/crew-pulse";
import type { CrewMember } from "@/lib/crew-status";

// The Now card punches through the clock's actions and opens the clock's Which Job sheet; rendered only
// (the same mocks my-day-switches.test.ts uses for it).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/planner",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/app/(app)/timeclock/actions", () => ({ clockIn: vi.fn(), clockOut: vi.fn() }));
vi.mock("@/app/(app)/timeclock/which-job-actions", () => ({ whichJobChoices: vi.fn(), putPunchOnJob: vi.fn() }));
import { NowCard } from "@/app/(app)/planner/now-card";
import { CREW_UNREAD, WhosOnTheClock, weeksBack } from "@/app/(app)/timeclock/whos-on-the-clock";

const read = (p: string) => readFileSync(p, "utf8");
const TZ = "America/Los_Angeles";
const TODAY = "2026-10-13";
const m = (over: Partial<CrewMember>): CrewMember => ({ id: "x", name: "Someone", clockedIn: false, jobLabel: null, entryId: null, clockIn: null, splitFrom: null, ...over });
const crew: CrewMember[] = [
  m({ id: "me", name: "Owner", clockedIn: true, jobLabel: "Bayberry kitchen", entryId: "e-me", clockIn: "2026-10-13T14:10:00Z" }),
  m({ id: "b", name: "Crew B", clockedIn: true, jobLabel: "Bayberry panel", entryId: "e-b", clockIn: "2026-10-13T15:05:00Z" }),
  m({ id: "c", name: "Crew C", clockedIn: true, jobLabel: null, entryId: "e-c", clockIn: "2026-10-13T13:30:00Z" }),
  m({ id: "d", name: "Crew D" }),
];

describe("who else is on the clock", () => {
  it("counts everyone, lists everyone but the caller, longest-on first, by job NAME or 'no job yet'", () => {
    const p = crewPulse(crew, "me", TZ, TODAY);
    expect(p.on).toBe(3);
    expect(p.of).toBe(4);
    expect(p.rows.map((r) => r.id)).toEqual(["c", "b"]);
    expect(p.rows[0]).toEqual({ id: "c", name: "Crew C", job: null, since: "6:30 AM", href: "/timecards?week=0&entry=e-c" });
    expect(p.rows[1].job).toBe("Bayberry panel");
    expect(p.rows[1].since).toBe("8:05 AM");
  });
  it("a Switch Job's second piece reads since its SHIFT began, and sorts by it (audit v994 SW1)", () => {
    const p = crewPulse(crew, "me", TZ, TODAY, new Map([["e-b", "2026-10-13T12:00:00Z"]]));
    expect(p.rows.map((r) => r.id)).toEqual(["b", "c"]);
    expect(p.rows[0].since).toBe("5:00 AM");
  });
  it("a viewer who is not on the clock still sees the others; alone on the clock = no rows, on 1", () => {
    expect(crewPulse(crew, "d", TZ, TODAY).rows.length).toBe(3);
    expect(crewPulse([crew[0], crew[3]], "me", TZ, TODAY)).toEqual({ on: 1, of: 2, rows: [] });
  });
  it("a punch from another day carries its day; no clock-in reads as a dash; never a narrow space", () => {
    expect(sinceWords("2026-10-13T15:05:00Z", TZ, TODAY)).toBe("8:05 AM");
    expect(sinceWords("2026-10-12T15:05:00Z", TZ, TODAY)).toBe("Mon 8:05 AM");
    expect(sinceWords("2026-10-13T06:30:00Z", TZ, TODAY)).toBe("Mon 11:30 PM"); // 23:30 local the night before
    expect(sinceWords(null, TZ, TODAY)).toBe("—");
    expect(sinceWords("not a date", TZ, TODAY)).toBe("—");
    expect(sinceWords("2026-10-13T15:05:00Z", TZ, TODAY)).not.toMatch(/\u202f/);
  });
  it("what the card gets: nothing for a tech, nothing for a one-person company, null for a failed read, else the pulse", () => {
    expect(crewForCard({ crew: undefined }, "me", TZ, TODAY)).toBeUndefined();
    expect(crewForCard({ crew: null }, "me", TZ, TODAY)).toBeNull();
    expect(crewForCard({ crew: [crew[0]] }, "me", TZ, TODAY)).toBeUndefined();
    expect(crewForCard({ crew, starts: new Map() }, "me", TZ, TODAY)?.rows.length).toBe(2);
  });
});

describe("the Now card draws it", () => {
  const card = (crewProp: ReturnType<typeof crewForCard>) =>
    renderToStaticMarkup(createElement(NowCard, { open: null, job: null, userId: "me", crew: crewProp }));
  it("a tech's card (crew undefined) has no block", () => {
    expect(card(undefined)).not.toContain("On The Clock");
  });
  it("a failed read is said, never a silent nobody", () => {
    const html = card(null);
    expect(html).toContain("Couldn’t read who’s on the clock — reload to try again.");
    expect(html).not.toContain("Nobody right now.");
  });
  it("rows are 44px links to the entry on Timecards, the job by name, since when", () => {
    const html = card(crewPulse(crew, "me", TZ, TODAY));
    expect(html).toContain("On The Clock");
    expect(html).toContain("3 of 4");
    expect(html).toContain('href="/timecards?week=0&amp;entry=e-c"');
    expect(html).toMatch(/<a[^>]*class="flex min-h-11 items-center/);
    expect(html).toContain("Crew C");
    expect(html).toContain("no job yet");
    expect(html).toContain("Bayberry panel");
    expect(html).toContain("since 6:30 AM");
  });
  it("alone on the clock says so; nobody says so", () => {
    expect(card({ on: 1, of: 3, rows: [] })).toContain("Just you.");
    expect(card({ on: 0, of: 3, rows: [] })).toContain("Nobody right now.");
  });
});

describe("the doors (source pins)", () => {
  it("My Day starts the read the moment the role is known, staff only, chains the shift starts, and says a failure", () => {
    const s = read("src/app/(app)/planner/page.tsx");
    expect(s).toMatch(/const crewP[^=]*= isStaff\s*\?\s*getCrewStatus\(supabase\)/);
    expect(s).toContain('reportError("planner-crew-status", e);');
    expect(s).toContain('reportError("planner-crew-shift-chain", e);');
    expect(s).toContain("return { crew: null, starts: new Map<string, string>() };");
    expect(s).toContain("crew={crewForCard(crewR, user?.id ?? null, tz, todayStr)}");
    expect(s.indexOf("const crewP")).toBeLessThan(s.indexOf("const [crewR, curJobRes"));
  });
  it("a returned read error is thrown by getCrewStatus, and the Time Clock says it — for staff only; Timecards no longer draws the block (cn-v1134)", () => {
    const s = read("src/lib/crew-status.ts");
    expect(s).toContain("if (membersError) throw membersError;");
    expect(s).toContain("if (openError) throw openError;");
    expect(s).toContain('"id, profile_id, clock_in, split_from, job:job_id(job_number, name)"');
    // Erik, 2026-10-27: "keep the who's on the clock with Time Clock instead of Timecards".
    const clock = read("src/app/(app)/timeclock/page.tsx");
    expect(clock).toMatch(/const crewP[^=]*= isStaff\s*\?\s*getCrewStatus\(supabase\)/); // a tech's page reads nothing here
    expect(clock).toContain(": Promise.resolve({ crew: undefined, starts: new Map<string, string>() });");
    expect(clock).toContain('reportError("timeclock-crew-status", e);');
    expect(clock).toContain('reportError("timeclock-crew-shift-chain", e);');
    expect(clock).toContain("return { crew: null, starts: new Map<string, string>() };");
    expect(clock).toContain("{crewR.crew !== undefined && (");
    expect(clock).toContain("<WhosOnTheClock");
    expect(clock).not.toContain("countTeammates"); // W2-01 stands: the block is not a door row
    const cards = read("src/app/(app)/timecards/page.tsx");
    for (const gone of ["getCrewStatus", "timecards-crew-status", "Couldn&rsquo;t read who&rsquo;s on the clock", "On the clock</span>", "const onClock"]) {
      expect(cards, gone).not.toContain(gone);
    }
    // My Day is not touched: its Now card still gets the pulse.
    expect(read("src/app/(app)/planner/page.tsx")).toContain("crew={crewForCard(crewR, user?.id ?? null, tz, todayStr)}");
  });
});

describe("the Time Clock draws it (the block takes what the page read; staff only, by the page's gate)", () => {
  const NOW = Date.parse("2026-10-13T16:00:00Z"); // 9:00 AM Pacific on the fixture's day
  const block = (over: Partial<Parameters<typeof WhosOnTheClock>[0]> = {}) =>
    renderToStaticMarkup(createElement(WhosOnTheClock, { crew, starts: new Map(), selfId: "me", tz: TZ, todayStr: TODAY, weekStart: "monday", nowMs: NOW, ...over }));
  it("a failed read is said, never a silent nobody", () => {
    const html = block({ crew: null });
    expect(html).toContain(CREW_UNREAD);
    expect(CREW_UNREAD).toBe("Couldn’t read who’s on the clock — reload to try again.");
    expect(html).not.toContain("Nobody right now");
  });
  it("Title Case heading, the count of everyone, one 44px row per person on the clock — the job by name, since when, Clock Out <Name> into that entry's sheet on Timecards", () => {
    const html = block();
    expect(html).toContain("Who’s On The Clock");
    expect(html).toContain("3 of 4");
    expect(html).toContain('href="/timecards?week=0&amp;entry=e-b"');
    // clockDoorWords: the first name for a teammate ("Clock Out Crew" for Crew B and Crew C), none for yourself.
    expect(html.match(/Clock Out Crew</g)).toHaveLength(2);
    expect(html).toContain("Clock Out<svg");
    expect(html).toContain("Bayberry panel");
    expect(html).toContain("since 8:05 AM");
    expect(html).toMatch(/<a[^>]*min-h-\[44px\]/);
    expect(html).not.toContain("Crew D"); // off the clock: counted, not listed
    expect(html).not.toContain("bg-amber-50"); // nobody has been on twelve hours
  });
  it("a Switch Job's second piece reads since its SHIFT began, with its day when that was not today, and a long clock is tinted", () => {
    const html = block({ starts: new Map([["e-b", "2026-10-13T02:00:00Z"]]) }); // 7:00 PM the night before: 14 h by NOW
    expect(html).toContain("since Mon 7:00 PM");
    expect(html).toContain("bg-amber-50");
  });
  it("the row's week is the entry's own clock-in week, by the company's week start (Timecards' ?week= counts weeks back)", () => {
    expect(weeksBack("2026-10-13", "2026-10-13", "monday", TZ)).toBe(0);
    expect(weeksBack("2026-10-12", "2026-10-13", "monday", TZ)).toBe(0); // the Monday this week began
    expect(weeksBack("2026-10-11", "2026-10-13", "monday", TZ)).toBe(1); // Sunday: last week when weeks start Monday
    expect(weeksBack("2026-10-11", "2026-10-13", "sunday", TZ)).toBe(0); // …this week when they start Sunday
    expect(weeksBack("2026-09-30", "2026-10-13", "monday", TZ)).toBe(2);
    expect(weeksBack("nope", "2026-10-13", "monday", TZ)).toBe(0);
    const html = block({ crew: [m({ id: "b", name: "Crew B", clockedIn: true, entryId: "e-old", clockIn: "2026-10-06T15:05:00Z" })] });
    expect(html).toContain('href="/timecards?week=1&amp;entry=e-old"');
  });
  it("nobody on the clock says so; an empty company draws nothing", () => {
    expect(block({ crew: [crew[3]] })).toContain("Nobody right now");
    expect(block({ crew: [crew[3]] })).toContain("0 of 1");
    expect(block({ crew: [] })).toBe("");
  });
});
