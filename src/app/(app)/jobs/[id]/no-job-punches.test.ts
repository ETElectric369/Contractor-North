import { describe, it, expect, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

/**
 * PUNCHES WITH NO JOB, ON THE JOB'S TIME TAB (the duplicate punches, 2026-09-26).
 *
 * On 9/19 the office billing 85 Whitney saw no 9/11 hours on the job's Time tab and typed the day
 * again; Brian's own 9/11 punch was in the book on no job. The tab now lists this job's crew's
 * closed, job-less, unbilled, non-company-time punches from the day before its first day to two
 * days after its last, each with Put This On <job> (office only), and shows nothing when there are
 * none.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../../timeclock/actions", () => ({
  putShiftOnJob: vi.fn(async () => ({ ok: true, sentence: "" })),
  takeShiftOffJob: vi.fn(async () => ({ ok: true })),
}));

import { NEAR_REST_HREF, NEAR_SHOWN, NoJobPunchesList, nearPunchLine, type NearPunch } from "./no-job-punches";
import { NEAR_JOB_CAP, jobCrewIds, nearJobWindow, readNoJobPunchesNearJob, type NoJobRow } from "@/lib/no-job-hours";
import { NO_JOB_HOURS_HREF } from "@/lib/action-items/no-job-hours-item";

const TZ = "America/Los_Angeles";

describe("the days a job's crew may have worked it on no job", () => {
  it("from the day before its first worked or scheduled day to two days after its last (org days)", () => {
    // J-028: scheduled Thu 9/10 only, Brian's hours on it that day.
    expect(
      nearJobWindow({
        tz: TZ,
        entries: [{ clock_in: "2026-09-10T15:00:00Z", clock_out: "2026-09-10T23:30:00Z" }],
        scheduledStart: "2026-09-10T15:00:00Z",
        scheduledEnd: "2026-09-10T23:00:00Z",
      }),
    ).toEqual({ from: "2026-09-09", to: "2026-09-12" });
  });

  it("segments and a later worked day stretch it; an evening punch counts on its Pacific day", () => {
    expect(
      nearJobWindow({
        tz: TZ,
        // 6 PM to 8 PM Pacific on 9/20 is 01:00-03:00 UTC on 9/21.
        entries: [{ clock_in: "2026-09-21T01:00:00Z", clock_out: "2026-09-21T03:00:00Z" }],
        segments: [{ start_date: "2026-09-14", end_date: "2026-09-15" }],
      }),
    ).toEqual({ from: "2026-09-13", to: "2026-09-22" });
  });

  it("a job never scheduled and never worked has nothing to be near", () => {
    expect(nearJobWindow({ tz: TZ, entries: [], segments: [] })).toBeNull();
  });

  it("its crew: the people assigned, and anyone with hours on it", () => {
    expect(jobCrewIds(["brian", null], [{ profile_id: "erik" }, { profile_id: "brian" }, { profile_id: null }])).toEqual(["brian", "erik"]);
    expect(jobCrewIds(null, [])).toEqual([]);
  });
});

describe("the read", () => {
  const row = (over: Partial<NoJobRow> = {}): NoJobRow => ({
    id: "punch",
    profile_id: "brian",
    // Brian's 9/11 app punch, 10:31 AM to 6:57 PM Pacific.
    clock_in: "2026-09-11T17:31:00Z",
    clock_out: "2026-09-12T01:57:00Z",
    lunch_minutes: 0,
    job_code: null,
    profiles: { full_name: "Brian Taylor" },
    ...over,
  });
  function fake(rows: NoJobRow[], claimedIds: string[] = [], fail?: string) {
    const calls: { table: string; ops: [string, unknown[]][] }[] = [];
    const chain = (table: string, result: { data: unknown; error: unknown }) => {
      const rec = { table, ops: [] as [string, unknown[]][] };
      calls.push(rec);
      const q: Record<string, unknown> = {};
      for (const op of ["select", "eq", "neq", "is", "not", "or", "order", "limit", "in", "gte", "lt", "overlaps"]) {
        q[op] = (...args: unknown[]) => {
          rec.ops.push([op, args]);
          return q;
        };
      }
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad);
      return q;
    };
    const supabase = {
      from: (table: string) => {
        if (fail === table) return chain(table, { data: null, error: { message: "boom" } });
        if (table === "job_codes") return chain(table, { data: [{ code: "SHOP" }], error: null });
        if (table === "time_entries") return chain(table, { data: rows, error: null });
        if (table === "invoice_items")
          return chain(table, {
            data: claimedIds.length
              ? [{ import_key: null, source_ids: claimedIds, invoices: { id: "inv-55", invoice_number: "INV-055", status: "sent", created_at: "2026-09-12T00:00:00Z", job_id: null, jobs: null } }]
              : [],
            error: null,
          });
        return chain(table, { data: [], error: null });
      },
    };
    return { supabase: supabase as never, calls };
  }
  const window = { from: "2026-09-09", to: "2026-09-12" };

  it("reads only this crew's closed no-job punches inside the window, the company's own time left out, newest first", async () => {
    const { supabase, calls } = fake([row()]);
    const out = await readNoJobPunchesNearJob(supabase, { crewIds: ["brian", "erik"], window, tz: TZ, todayStr: "2026-09-26" });
    expect(out?.shifts.map((s) => [s.id, s.name, s.hours])).toEqual([["punch", "Brian Taylor", 8.43]]);
    expect(out?.capped).toBe(false);
    const time = calls.find((c) => c.table === "time_entries")!.ops;
    expect(time).toContainEqual(["in", ["profile_id", ["brian", "erik"]]]);
    expect(time).toContainEqual(["is", ["job_id", null]]);
    expect(time).toContainEqual(["eq", ["status", "closed"]]);
    // Midnight Pacific on 9/9, to midnight Pacific after 9/12 (the day after the last one).
    expect(time).toContainEqual(["gte", ["clock_in", "2026-09-09T07:00:00.000Z"]]);
    expect(time).toContainEqual(["lt", ["clock_in", "2026-09-13T07:00:00.000Z"]]);
    expect(time).toContainEqual(["or", ['job_code.is.null,job_code.not.in.("SHOP")']]);
    expect(time).toContainEqual(["order", ["clock_in", { ascending: false }]]);
    expect(time).toContainEqual(["limit", [NEAR_JOB_CAP]]);
  });

  it("a punch an invoice already bills is not offered (a billed shift keeps its place), and today's is", async () => {
    const today = row({ id: "today", clock_in: "2026-09-26T15:00:00Z", clock_out: "2026-09-26T19:00:00Z" });
    const { supabase } = fake([today, row({ id: "billed" }), row()], ["billed"]);
    const out = await readNoJobPunchesNearJob(supabase, { crewIds: ["brian"], window: { from: "2026-09-09", to: "2026-09-28" }, tz: TZ, todayStr: "2026-09-26" });
    expect(out?.shifts.map((s) => s.id)).toEqual(["today", "punch"]);
  });

  it("a read that fills its cap says so: there may be older ones than these", async () => {
    const full = Array.from({ length: NEAR_JOB_CAP }, (_, i) => row({ id: `p${i}` }));
    const { supabase } = fake(full, ["p0"]);
    const out = await readNoJobPunchesNearJob(supabase, { crewIds: ["brian"], window, tz: TZ, todayStr: "2026-09-26" });
    // Capped by what the read brought back, not by what was left after the billed one came out.
    expect(out?.capped).toBe(true);
    expect(out?.shifts).toHaveLength(NEAR_JOB_CAP - 1);
  });

  it("no window or no crew reads nothing; a failed read is null (said), never an empty list", async () => {
    const none = fake([row()]);
    const nothing = { shifts: [], capped: false };
    expect(await readNoJobPunchesNearJob(none.supabase, { crewIds: ["brian"], window: null, tz: TZ, todayStr: "2026-09-26" })).toEqual(nothing);
    expect(await readNoJobPunchesNearJob(none.supabase, { crewIds: [], window, tz: TZ, todayStr: "2026-09-26" })).toEqual(nothing);
    expect(none.calls).toEqual([]);
    const broken = fake([row()], [], "time_entries");
    expect(await readNoJobPunchesNearJob(broken.supabase, { crewIds: ["brian"], window, tz: TZ, todayStr: "2026-09-26" })).toBeNull();
  });
});

describe("the list on the Time tab", () => {
  const punch: NearPunch = { id: "punch", name: "Brian Taylor", clockIn: "2026-09-11T17:31:00Z", clockOut: "2026-09-12T01:57:00Z", hours: 8.43, jobCode: null };
  const props = (over: Partial<Parameters<typeof NoJobPunchesList>[0]> = {}) => ({
    punches: [punch],
    jobLabel: "85 Whitney",
    tz: TZ,
    onPut: vi.fn(),
    ...over,
  });
  const render = (p: Parameters<typeof NoJobPunchesList>[0]) => renderToStaticMarkup(createElement(NoJobPunchesList, p));

  it("names each punch with its own clock times and offers Put This On <job>, 44px", () => {
    const html = render(props());
    expect(html).toContain("Punches With No Job");
    expect(html).toContain("Brian · Fri, Sep 11 · 10:31 AM to 6:57 PM · 8.43 h");
    expect(html).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*"[^>]*>Put This On 85 Whitney<\/button>/);
    expect(nearPunchLine({ ...punch, jobCode: "ROUGH" }, TZ)).toBe("Brian · Fri, Sep 11 · 10:31 AM to 6:57 PM · 8.43 h · ROUGH");
  });

  it("is hidden when there is nothing to put on the job; a failed check says so instead", () => {
    expect(render(props({ punches: [] }))).toBe("");
    expect(render(props({ punches: [], failed: true }))).toContain("Couldn’t check this crew’s punches with no job just now.");
  });

  it("the tap is Put This On for that punch; a refusal is a plain line under it", () => {
    const p = props();
    const tree = NoJobPunchesList(p) as ReactElement;
    const find = (node: ReactNode): ReactElement<{ onClick: () => void }> | null => {
      if (node == null || typeof node !== "object") return null;
      if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
      if (!isValidElement(node)) return null;
      const pr = node.props as { onClick?: unknown; children?: ReactNode };
      if (typeof pr.onClick === "function" && String(pr.children).startsWith("Put This On")) return node as ReactElement<{ onClick: () => void }>;
      return find(pr.children);
    };
    find(tree)!.props.onClick();
    expect(p.onPut).toHaveBeenCalledWith(punch);
    expect(render(props({ errors: { punch: "That shift is already on 22 Pine." } }))).toContain("That shift is already on 22 Pine.");
  });

  it("shows the newest five above the job's own entries, and Show All <n> (44px) opens the rest", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ ...punch, id: `p${i}` }));
    const short = render(props({ punches: many }));
    expect(short.match(/>Put This On 85 Whitney<\/button>/g)).toHaveLength(NEAR_SHOWN);
    expect(short).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*"[^>]*>Show All 13<\/button>/);
    const all = render(props({ punches: many, showAll: true }));
    expect(all.match(/>Put This On 85 Whitney<\/button>/g)).toHaveLength(13);
    expect(all).not.toContain("Show All");
    // Five or fewer: nothing to open.
    expect(render(props({ punches: many.slice(0, NEAR_SHOWN) }))).not.toContain("Show All");
  });

  it("a full cap is said, with the door to the rest; a full cap with nothing listable is said too, never hidden", () => {
    const capped = render(props({ capped: true }));
    expect(capped).toContain("These are the newest 1. Older ones are under");
    expect(capped).toContain(`href="${NEAR_REST_HREF}"`);
    expect(capped).toContain("Hours On No Job, on Timecards");
    expect(render(props())).not.toContain("Older ones are under");
    const unlisted = render(props({ punches: [], capped: true }));
    expect(unlisted).toContain("Couldn’t list every punch with no job around this job’s days");
    expect(unlisted).toContain(`href="${NEAR_REST_HREF}"`);
    // The same place Needs You's Hours On No Job line opens.
    expect(NEAR_REST_HREF).toBe(NO_JOB_HOURS_HREF);
  });

  it("a refusal is said in a toast too: the refresh after it drops a punch someone else moved, and its line with it", () => {
    const src = readFileSync(new URL("./no-job-punches.tsx", import.meta.url), "utf8");
    const refused = src.slice(src.indexOf("if (!r.ok) {"), src.indexOf("setGone((g) => new Set(g).add(p.id));"));
    expect(refused).toContain("setErrors((e) => ({ ...e, [p.id]: sentence }));");
    expect(refused).toContain('toast(sentence, "error");');
    // Said before the refresh that can take the row away.
    expect(refused.indexOf('toast(sentence, "error");')).toBeLessThan(refused.indexOf("router.refresh();"));
  });

  it("is the office's: computed and rendered only for staff on the job page", () => {
    const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(page).toContain("const nearPunchesP: Promise<NearPunches | null> = viewerIsStaff\n    ? readNoJobPunchesNearJob(");
    expect(page).toMatch(/\{viewerIsStaff && \(\s*<NoJobPunches\s+jobId=\{j\.id\}/);
    // The read's cap reaches the list, so a full cap is said there.
    expect(page).toContain("capped={!!nearPunches?.capped}");
  });

  it("never holds the page up on its own: started beside the page's other reads, awaited after them", () => {
    const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    const started = page.indexOf("const nearPunchesP");
    // Up to three round trips one after another; started once tz is known, before the shelf,
    // takes, documents and split reads are awaited, so it overlaps them instead of following them.
    expect(started).toBeGreaterThan(page.indexOf("const tz = getOrgSettings"));
    for (const later of ["await shelfNetP", "await takesP", "await signDocumentUrls", "await nearPunchesP"]) {
      expect(page.indexOf(later)).toBeGreaterThan(started);
    }
    // A failed read is reported and said (null), never a rejected promise the page trips on.
    expect(page).toContain('reportError("jobs.[id].noJobPunches", e, { jobId: id });\n          return null;');
  });
});
