import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chipDot, crewChips, crewDayLines, crewWords, dayRowsByDay, type CrewDayRow } from "@/lib/schedule/block-info";
import { pillColorForPerson } from "@/lib/employee-color";
import { CrewInitials } from "./crew-initials";

/**
 * WHO'S ON IT, DRAWN ON THE TILE (Wave 2, SV-chips). The crew as initials chips, each in the person's
 * own color (the /timecards person color), marks never doors; and THE DAY ROW WINS for that day (the
 * 0139/0170 precedence law): Everyone's Day's 'off' row dims and strikes a person through, a 'job' row
 * for another job dims them, a 'job' row for this job puts someone on it for the day. A person who
 * left is still drawn and named. The merged names: crewChips (lib/schedule/block-info) and CrewInitials
 * (components/crew-initials) are the brief's crewChipsFor and <CrewChips>.
 */
const team = [
  { id: "p-erik", full_name: "Erik Taylor" },
  { id: "p-brian", full_name: "Brian Cole" },
  { id: "p-jimmy", full_name: "Jimmy Ruiz" },
];
const everyone = [...team, { id: "p-gone", full_name: "Dana Whitfield" }];
const DAY = "2026-10-06";
const row = (profile_id: string, kind: "job" | "off", job_id: string | null = null): CrewDayRow => ({ profile_id, work_date: DAY, kind, job_id });
const jobNames = new Map([["j-other", "12 Elm St · J-048"]]);

describe("crewChips: the crew as that day leaves it", () => {
  it("in the crew's order, initials and the whole name, deduped, with no day: exactly the crew", () => {
    const chips = crewChips(["p-brian", "p-erik", "p-erik", ""], team);
    expect(chips.map((c) => [c.id, c.initials, c.name])).toEqual([
      ["p-brian", "BC", "Brian Cole"],
      ["p-erik", "ET", "Erik Taylor"],
    ]);
    // A plain chip carries no day's state: it is on, titled by its name.
    expect(chips.every((c) => c.state === undefined && c.title === undefined)).toBe(true);
    expect(crewChips(null, team)).toEqual([]);
  });

  it("an 'off' row: dimmed and struck, titled '<Name> · Off That Day'", () => {
    const [b] = crewChips(["p-brian"], team, { rows: [row("p-brian", "off")], jobId: "j-this" });
    expect(b).toMatchObject({ state: "off", title: "Brian Cole · Off That Day" });
  });

  it("a 'job' row for another job: dimmed, titled with that job's words, or 'On Another Job That Day' when it isn't loaded", () => {
    const [b] = crewChips(["p-brian"], team, { rows: [row("p-brian", "job", "j-other")], jobId: "j-this", jobNames });
    expect(b).toMatchObject({ state: "elsewhere", otherJob: "12 Elm St · J-048", title: "Brian Cole · On 12 Elm St · J-048 That Day" });
    const [unknown] = crewChips(["p-brian"], team, { rows: [row("p-brian", "job", "j-unloaded")], jobId: "j-this", jobNames });
    expect(unknown).toMatchObject({ state: "elsewhere", otherJob: null, title: "Brian Cole · On Another Job That Day" });
  });

  it("a 'job' row for THIS job keeps them on it, and puts someone not on the crew on it for the day", () => {
    const chips = crewChips(["p-erik"], team, { rows: [row("p-erik", "job", "j-this"), row("p-jimmy", "job", "j-this")], jobId: "j-this" });
    expect(chips.map((c) => [c.id, c.state ?? "on"])).toEqual([
      ["p-erik", "on"],
      ["p-jimmy", "on"],
    ]);
  });

  it("a visit carries one person and reads only an 'off' row", () => {
    expect(crewChips(["p-brian"], team, { rows: [row("p-brian", "job", "j-other")], jobId: null })[0].state).toBeUndefined();
    expect(crewChips(["p-brian"], team, { rows: [row("p-brian", "off")], jobId: null })[0].state).toBe("off");
    // Nobody is ever added to a visit by a day row.
    expect(crewChips([], team, { rows: [row("p-jimmy", "job", "j-this")], jobId: null })).toEqual([]);
  });

  it("a person who left still draws, named from everyone the company had, titled 'No Longer On The Team'", () => {
    const [gone] = crewChips(["p-gone"], team, { people: everyone });
    expect(gone).toMatchObject({ initials: "DW", name: "Dana Whitfield", departed: true, title: "Dana Whitfield · No Longer On The Team" });
    // Nobody the company ever had: still a chip, never dropped.
    expect(crewChips(["p-nobody"], team, { people: everyone })[0]).toMatchObject({ name: "Unnamed", initials: "U" });
  });

  it("one person is one color: the /timecards person color, by id", () => {
    expect(chipDot({ id: "p-erik" })).toBe(pillColorForPerson("p-erik").dot);
    expect(chipDot({ id: "p-erik", dot: "bg-slate-400" })).toBe("bg-slate-400");
  });

  it("the words: 'Crew: …' or 'Nobody on it'; the sheet's lines for whoever the day moved", () => {
    const chips = crewChips(["p-erik", "p-brian", "p-jimmy"], team, {
      rows: [row("p-brian", "off"), row("p-jimmy", "job", "j-other")],
      jobId: "j-this",
      jobNames,
    });
    expect(crewWords(chips)).toBe("Crew: Erik Taylor, Brian Cole (off that day), Jimmy Ruiz (on 12 Elm St · J-048 that day)");
    expect(crewWords([])).toBe("Nobody on it");
    expect(crewDayLines(chips)).toEqual(["Brian is off that day.", "Jimmy is on 12 Elm St · J-048 that day."]);
    expect(crewDayLines(crewChips(["p-erik"], team))).toEqual([]);
  });

  it("the day rows group by day; a bad row is dropped", () => {
    const by = dayRowsByDay([
      { profile_id: "p-erik", work_date: "2026-10-06", kind: "off", job_id: null },
      { profile_id: "p-brian", work_date: "2026-10-07T00:00:00", kind: "job", job_id: "j1" },
      { profile_id: "", work_date: "2026-10-06", kind: "off", job_id: null },
      { profile_id: "p-jimmy", work_date: "nope", kind: "off", job_id: null },
    ]);
    expect(Object.keys(by).sort()).toEqual(["2026-10-06", "2026-10-07"]);
    expect(by["2026-10-07"]).toEqual([{ profile_id: "p-brian", work_date: "2026-10-07", kind: "job", job_id: "j1" }]);
  });
});

describe("where the day's rows come from, and where the chips draw", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

  it("the schedule reads Everyone's Day's rows (both kinds) from today on, and everyone the company had", () => {
    const panel = read("src/app/(app)/schedule/calendar-panel.tsx");
    expect(panel).toMatch(/\.from\("crew_day_assignments"\)\s*\.select\("profile_id, work_date, kind, job_id"\)/);
    expect(panel).not.toMatch(/crew_day_assignments"\)[\s\S]{0,120}\.eq\("kind"/);
    expect(panel).toContain('.limit(2000)');
    expect(panel).toContain('supabase.from("profiles").select("id, full_name, active")');
    expect(panel).toContain("dayRows={dayRowsByDay(");
  });

  it("the grid, the day drill's card and a visit's row draw the day's crew; the month draws none", () => {
    const view = read("src/app/(app)/calendar/calendar-view.tsx");
    expect(view).toContain("crew: jobCrewOn(job, k)");
    expect(view).toContain("crew: visitCrewOn(a, k)");
    expect(view).toContain("crew={jobCrewOn ? jobCrewOn(job, dayK) : undefined}");
    expect(view).toContain("crew={visitCrewOn ? visitCrewOn(a, dayK) : undefined}");
    // A visit row's person, for the office, is a 44px tap that opens that visit's sheet.
    expect(view).toMatch(/onClick=\{onOpenPerson\}[\s\S]{0,120}min-h-11/);
    expect(view).toContain('onOpenVisit={canEdit ? (visitId) => setSheet({ kind: "visit", id: visitId, day: anchorK }) : undefined}');
    const month = view.slice(view.indexOf("function monthPills("), view.indexOf("const MONTH_MAX_PILLS"));
    expect(month).not.toContain("CrewInitials");
  });

  it("My Day's rows read today's rows (and the week's, for a tech's week), names only", () => {
    const page = read("src/app/(app)/planner/page.tsx");
    expect(page).toContain('supabase.from("crew_day_assignments").select("profile_id, work_date, kind, job_id").eq("work_date", todayStr)');
    expect(page).toMatch(/\.from\("crew_day_assignments"\)\s*\.select\("profile_id, work_date, kind, job_id"\)\s*\.gte\("work_date", weekStartStr\)/);
    expect(page).toContain("crewChips(j.assigned_to, people, { rows: crewRowsByDay[day], jobId: j.id, jobNames })");
  });
});

describe("<CrewInitials>: marks, never a door", () => {
  const html = (crew: ReturnType<typeof crewChips>, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(CrewInitials, { crew, ...extra }));

  it("an empty crew is ONE dashed Nobody, never a blank", () => {
    expect(html([])).toMatch(/^<span[^>]*border-dashed[^>]*>Nobody<\/span>$/);
    expect(html([], { size: "xs" })).toMatch(/border-dashed[^>]*>Nobody</);
  });

  it("each chip wears its person's color, titled by its name; no button, no link", () => {
    const out = html(crewChips(["p-erik", "p-brian"], team));
    expect(out).toContain(`title="Erik Taylor" class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-white ${pillColorForPerson("p-erik").dot}"`);
    expect(out).toContain(pillColorForPerson("p-brian").dot);
    expect(out).not.toContain("bg-brand");
    expect(out).not.toMatch(/<(button|a)\b/);
    expect(out).toContain('aria-label="Crew: Erik Taylor, Brian Cole"');
  });

  it("the day's rows show: off is dimmed and struck through, on another job is dimmed, each titled", () => {
    const out = html(
      crewChips(["p-erik", "p-brian"], team, { rows: [row("p-erik", "off"), row("p-brian", "job", "j-other")], jobId: "j-this", jobNames }),
    );
    expect(out).toMatch(/title="Erik Taylor · Off That Day" class="[^"]* line-through opacity-40"/);
    expect(out).toMatch(/title="Brian Cole · On 12 Elm St · J-048 That Day" class="[^"]* opacity-40"/);
  });

  it("at most three, then '+N' titled with the names it hides (two on a squeezed pill)", () => {
    const four = crewChips(["p-erik", "p-brian", "p-jimmy", "p-gone"], team, { people: everyone });
    const out = html(four);
    expect(out.match(/rounded-full text-\[10px\]/g)).toHaveLength(3);
    expect(out).toMatch(/<span title="Dana Whitfield · No Longer On The Team"[^>]*>\+1<\/span>/);
    const squeezed = html(four, { size: "xs", max: 2 });
    expect(squeezed.match(/h-3\.5 w-3\.5/g)).toHaveLength(2);
    expect(squeezed).toMatch(/<span title="Jimmy Ruiz, Dana Whitfield · No Longer On The Team"[^>]*>\+2<\/span>/);
  });
});
