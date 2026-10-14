/**
 * NORT IS CURRENT (cn-v1093). Erik, the first night Nort spoke first (2026-10-14, chat
 * 4a1a00b7): the "updates" Nort handed over were reports he filed weeks before, eight at a time
 * out of thirty-one — "its still repeating and pulsing after the report" — and when he asked
 * "are there any newer updates?" Nort had no tool. So: the hold is the WHOLE backlog and one yes
 * empties it (stamped by filter, summed in code); the greeting says how far back it was filed, in
 * the company's timezone; each line says when it was filed; skip marks the reports heard unread
 * and leaves a crew daily report alone; whats_new reads the release notes and says whether the
 * phone is behind.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fakeDb } from "@/test/fake-supabase";
import { APP_VERSION } from "@/lib/version";
import { HISTORY_FROM, NOTES_DEFAULT, NOTES_MAX, RELEASE_NOTES, isBehind, notesSince, versionNumber } from "@/lib/release-notes";
import { DATA_TOOLS, STAFF_ONLY_DATA_TOOLS, runDataTool } from "@/lib/assistant-tools";
import { REPORTS_LIMIT, REPORT_OLD_AFTER_MS, filedWords, holdingFor, readMyUpdates, reportsBack, summarize } from "@/lib/nort/updates";
import { greetingPhrase, holdingWords } from "@/lib/nort/greeting";

const read = (p: string) => readFileSync(p, "utf8");
const DAY = 86400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const LA = "America/Los_Angeles";

describe("the release notes", () => {
  it("the top entry IS the running build, versions descend without repeats, dates are ISO and never climb, history starts where it says", () => {
    expect(RELEASE_NOTES[0].version).toBe(APP_VERSION);
    expect(RELEASE_NOTES[RELEASE_NOTES.length - 1].version).toBe(HISTORY_FROM);
    const nums = RELEASE_NOTES.map((r) => versionNumber(r.version));
    for (let i = 1; i < nums.length; i++) expect(nums[i]!).toBeLessThan(nums[i - 1]!);
    for (let i = 1; i < RELEASE_NOTES.length; i++) expect(RELEASE_NOTES[i].date <= RELEASE_NOTES[i - 1].date).toBe(true);
    for (const r of RELEASE_NOTES) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.line.trim().length).toBeGreaterThan(8);
      expect(r.line.length).toBeLessThanOrEqual(200);
      // plain words: never a migration number or a file name
      expect(r.line).not.toMatch(/\(0\d{3}\)|\.tsx?\b/);
    }
  });
  it("notesSince: after a version, newest first, capped; an unknown since is the newest page; behind is a comparison or unknown", () => {
    expect(versionNumber("cn-v1093")).toBe(1093);
    expect(versionNumber("v1093")).toBeNull();
    const after = notesSince("cn-v1090");
    expect(after.map((r) => r.version)).toEqual(RELEASE_NOTES.filter((r) => versionNumber(r.version)! > 1090).map((r) => r.version));
    expect(after[0].version).toBe(APP_VERSION);
    expect(notesSince(APP_VERSION)).toEqual([]);
    expect(notesSince(null).length).toBe(Math.min(NOTES_DEFAULT, RELEASE_NOTES.length));
    expect(notesSince("nonsense", 2).length).toBe(2);
    expect(notesSince(null, 0).length).toBe(1);
    expect(notesSince(null, 999).length).toBe(Math.min(NOTES_MAX, RELEASE_NOTES.length));
    expect(notesSince(null, Number.NaN).length).toBe(Math.min(NOTES_DEFAULT, RELEASE_NOTES.length));
    expect(isBehind("cn-v1090")).toBe(true);
    expect(isBehind(APP_VERSION)).toBe(false);
    expect(isBehind(null)).toBeNull();
    expect(isBehind("1.2.3")).toBeNull();
  });
  it("the whats_new tool: latest vs the PHONE's build (from the route, never the model), more past the cap, for everyone", async () => {
    const def = DATA_TOOLS.find((t) => t.name === "whats_new");
    expect(def?.description).toContain("read_my_updates");
    expect(STAFF_ONLY_DATA_TOOLS.has("whats_new")).toBe(false);
    const db = fakeDb({});
    const r = JSON.parse(await runDataTool("whats_new", {}, db.sb));
    expect(r).toMatchObject({ latest: APP_VERSION, phone: null, behind: null, history_from: HISTORY_FROM, count: Math.min(NOTES_DEFAULT, RELEASE_NOTES.length), more: RELEASE_NOTES.length > NOTES_DEFAULT });
    expect(r.notes[0]).toEqual(RELEASE_NOTES[0]);
    expect(r).not.toHaveProperty("running");
    const behind = JSON.parse(await runDataTool("whats_new", { phone_version: "cn-v1090", since_version: "cn-v1091", limit: 1 }, db.sb));
    expect(behind).toMatchObject({ phone: "cn-v1090", behind: true, count: 1, more: true });
    expect(behind.notes.map((n: { version: string }) => n.version)).toEqual([APP_VERSION]);
    const junk = JSON.parse(await runDataTool("whats_new", { phone_version: "<script>" }, db.sb));
    expect(junk.phone).toBeNull();
    const route = read("src/app/api/chat/route.ts");
    expect(route).toContain('const phoneVersion = typeof body.version === "string" && /^cn-v\\d{1,6}$/.test(body.version) ? body.version : null;');
    expect(route).toContain("phone_version: phoneVersion }, supabase)");
    expect(route).toContain('whats_new: "Checking what\'s new…"');
    expect(route).toContain('read_my_updates: "Getting your updates…"');
    expect(route.split("What's new in the app itself is whats_new").length - 1).toBe(2);
    expect(read("src/app/(app)/assistant/assistant-chat.tsx")).toContain("greeted: consumeGreeted(), version: APP_VERSION }");
  });
});

describe("how far back, and when each was filed — in the company's timezone", () => {
  it("a fresh batch has no qualifier; ANY old one names the oldest filing month, with the year when it isn't this one", () => {
    const now = Date.parse("2026-10-14T06:00:00Z");
    expect(reportsBack([], now)).toBeNull();
    expect(reportsBack(["2026-10-12T00:00:00Z", "2026-10-05T00:00:00Z"], now)).toBeNull();
    expect(reportsBack(["2026-10-12T00:00:00Z", "2026-07-29T00:00:00Z"], now)).toBe("July"); // one fresh does not hide the stale
    expect(reportsBack(["2026-09-30T00:00:00Z"], now)).toBe("September");
    expect(reportsBack(["2025-12-30T00:00:00Z", "2026-01-02T00:00:00Z"], now)).toBe("December 2025");
    // the FILING day is the company's day: a July 31 evening in Tahoe is Aug 1 in UTC
    expect(reportsBack(["2026-08-01T03:00:00Z"], now, LA)).toBe("July");
    expect(reportsBack(["2026-08-01T03:00:00Z"], now, "UTC")).toBe("August");
    expect(reportsBack(["2026-08-01T03:00:00Z"], now, "Not/AZone")).toBe("August"); // a bad tz falls back, never throws
    expect(reportsBack([null, "garbage"], now)).toBeNull();
    expect(REPORT_OLD_AFTER_MS).toBe(14 * DAY);
    expect(filedWords("2026-09-30T02:34:46.777Z", LA)).toBe("Sep 29");
    expect(filedWords("2026-09-30T02:34:46.777Z")).toBe("Sep 30");
    expect(filedWords(null)).toBeNull();
    const s = summarize([{ status: "fixed", created_at: "2026-09-30T02:34:46Z" }, { status: "wontfix", created_at: "2026-07-29T19:05:24Z" }, { status: "closed", created_at: "2026-08-10T00:00:00Z" }], LA);
    expect(s).toEqual({ total: 3, shipped: 1, notBeingBuilt: 1, closed: 1, filedFrom: "Jul 29", filedTo: "Sep 29" });
  });
  it("the greeting says how far back the filing goes, precisely, and still asks the one question", () => {
    const h = { reports: 15, dailyReports: [], reportsBack: "July" };
    expect(holdingWords(h)).toBe("15 updates on things you reported, filed as far back as July");
    expect(greetingPhrase({ hour: 9, name: "Erik", holding: h })).toBe("Morning, Erik. I've got 15 updates on things you reported, filed as far back as July — want them now?");
    expect(holdingWords({ reports: 1, dailyReports: [], reportsBack: "September" })).toBe("one update on things you reported, filed in September");
    expect(holdingWords({ reports: 2, dailyReports: [] })).toBe("two updates on things you reported");
  });
});

describe("the whole backlog, once; or skipped", () => {
  const me = "u-me";
  const backlog = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `r${i}`, reported_by: me, status: i % 5 === 4 ? "wontfix" : i % 7 === 6 ? "closed" : "fixed", filer_notified_at: null,
      note: `thing ${i}`, created_at: ago(20 + i),
    }));
  const tables = (n = 15) => ({
    bug_reports: [
      ...backlog(n),
      { id: "fresh", reported_by: me, status: "fixed", filer_notified_at: null, note: "fixed yesterday", created_at: ago(1) },
      { id: "open", reported_by: me, status: "open", filer_notified_at: null, note: "still open", created_at: ago(1) },
      { id: "theirs", reported_by: "u-other", status: "fixed", filer_notified_at: null, note: "not mine", created_at: ago(1) },
    ],
    notifications: [
      { id: "n1", user_id: me, type: "daily_report", title: "Daily report from Brian Smith", body: "Pulled wire at Bayberry", url: "/planner", read_at: null, created_at: ago(0.1) },
      { id: "n2", user_id: me, type: "assigned", title: "Assigned", body: null, url: null, read_at: null, created_at: ago(0.1) },
    ],
  });
  const expectedBack = (days: number, tz: string) => {
    const d = new Date(Date.now() - days * DAY);
    const month = d.toLocaleDateString("en-US", { month: "long", timeZone: tz });
    const y = d.toLocaleDateString("en-US", { year: "numeric", timeZone: tz });
    return y === new Date().toLocaleDateString("en-US", { year: "numeric", timeZone: tz }) ? month : `${month} ${y}`;
  };
  it("holds ALL of them (one fresh among stale does not hide the stale), named with how far back the filing goes", async () => {
    expect(REPORTS_LIMIT).toBeGreaterThanOrEqual(100);
    const db = fakeDb(tables());
    const h = await holdingFor(me, db.sb, db.sb, LA);
    expect(h.reports).toBe(16);
    expect(h.reportsBack).toBe(expectedBack(34, LA));
    expect(holdingWords(h)).toMatch(/^Brian's daily report and 16 updates on things you reported, filed as far back as /);
  });
  it("on yes every line is handed over newest first with its filing day, old ones marked, the outcomes SUMMED IN CODE, and nothing left held — even past the cap", async () => {
    const db = fakeDb(tables(120));
    const u = await readMyUpdates(me, db.sb, db.sb, { tz: LA });
    expect(u.reports).toHaveLength(121);
    expect(u.reports[0]).toMatchObject({ outcome: "shipped", note: "fixed yesterday" });
    expect(u.reports[0].old).toBeUndefined();
    expect(u.reports.slice(1).every((r) => r.old === true && /^[A-Z][a-z]{2} \d{1,2}$/.test(r.filed ?? ""))).toBe(true);
    // i%5==4 → 24 not being built; i%7==6 and not i%5==4 → 14 closed (34, 69, 104 are both)
    expect(u.summary).toMatchObject({ total: 121, notBeingBuilt: 24, closed: 14, shipped: 121 - 24 - 14 });
    expect(u.summary?.filedFrom).toBe(filedWords(ago(139), LA));
    expect(u.summary?.filedTo).toBe(filedWords(ago(1), LA));
    expect(u.skipped).toBeUndefined();
    expect(u.unstamped).toBeUndefined();
    // stamped BY FILTER: all of mine, none of theirs, open ones untouched
    expect(db.tables.bug_reports.filter((r) => r.reported_by === me && r.status !== "open" && !r.filer_notified_at)).toHaveLength(0);
    expect(db.tables.bug_reports.find((r) => r.id === "open")?.filer_notified_at).toBeNull();
    expect(db.tables.bug_reports.find((r) => r.id === "theirs")?.filer_notified_at).toBeNull();
    expect(db.tables.notifications.find((n) => n.id === "n1")?.read_at).toBeTruthy();
    expect((await holdingFor(me, db.sb, db.sb)).reports).toBe(0);
  });
  it("on skip the reports are marked heard without a line read back; a crew daily report is NOT skipped and is named as still here", async () => {
    const db = fakeDb(tables());
    const u = await readMyUpdates(me, db.sb, db.sb, { skip: true });
    expect(u.reports).toEqual([]);
    expect(u.dailyReports).toEqual([]);
    expect(u.summary).toBeUndefined();
    expect(u.skipped).toEqual({ reports: 16 });
    expect(u.stillHolding).toEqual({ dailyReports: ["Brian"] });
    expect(u.unstamped).toBeUndefined();
    expect(db.tables.bug_reports.find((r) => r.id === "open")?.filer_notified_at).toBeNull();
    expect(db.tables.bug_reports.find((r) => r.id === "theirs")?.filer_notified_at).toBeNull();
    expect(db.tables.notifications.find((n) => n.id === "n1")?.read_at).toBeNull();
    const after = await holdingFor(me, db.sb, db.sb);
    expect(after.reports).toBe(0);
    expect(after.dailyReports).toEqual([{ from: "Brian" }]);
  });
  it("a skip that did not land is SAID, not swallowed; only a true skip skips", async () => {
    const refused = fakeDb(tables(), { onUpdate: (table) => (table === "bug_reports" ? { message: "permission denied" } : undefined) });
    const u = await readMyUpdates(me, refused.sb, refused.sb, { skip: true });
    expect(u.skipped).toEqual({ reports: 0 });
    expect(u.unstamped).toContain("Couldn't mark the report updates as heard");
    expect((await holdingFor(me, refused.sb, refused.sb)).reports).toBe(16);
    const db = fakeDb(tables());
    const notSkip = await readMyUpdates(me, db.sb, db.sb, { skip: "true" as unknown as boolean });
    expect(notSkip.reports.length).toBe(16);
    expect(notSkip.skipped).toBeUndefined();
  });
  it("the route passes skip and the company's timezone through, and the prompt knows skip, stillHolding, unstamped, the filing date, the summed rest, and offers skip only for a stale batch", () => {
    const r = read("src/app/api/chat/route.ts");
    expect(r).toContain("readMyUpdates(user.id, createServiceClient(), supabase, { skip: (tu.input as { skip?: unknown } | null)?.skip === true, tz: orgS.timezone })");
    expect(r.split("holdingFor(user.id, createServiceClient(), supabase, orgS.timezone)").length - 1).toBe(2);
    expect(r.split("read_my_updates with skip true").length - 1).toBe(2);
    expect(r.split('("from Sep 30: …")').length - 1).toBe(2);
    expect(r.split("EVERY not-being-built or closed one is its own line").length - 1).toBe(2);
    expect(r.split("the rest in ONE sentence from the tool's summary numbers (never counted by you)").length - 1).toBe(2);
    expect(r.split("if the result names stillHolding").length - 1).toBe(2);
    expect(r.split("unstamped").length - 1).toBe(2);
    expect(r.split(`\${holding.reportsBack ? ' — and because they were filed weeks ago add "or say skip."' : ""}`).length - 1).toBe(2);
    const tool = DATA_TOOLS.find((t) => t.name === "read_my_updates") as { description: string; input_schema: { properties: Record<string, unknown> } };
    expect(Object.keys(tool.input_schema.properties)).toEqual(["skip"]);
    expect(tool.description).toContain("a crew daily report is never skipped");
    expect(read("src/app/(app)/notification-actions.ts")).toContain("holdingFor(user.id, createServiceClient(), supabase, await orgTimezone(supabase))");
  });
});
