import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * W2-05: ONE DOOR FOR WAITING WORK. The calendar's "To Schedule" tray is cut (every job it held was
 * already on the rail); each rail card's verbs sit behind one 44px ⋯ (its record; a job's hold, snooze,
 * why, take off hold), with no status dropdown beside the job page's one status pill; and the rail's
 * place carries the Undo the tray had, putting the days AND the status back, refused in words when the
 * job changed since.
 */
type Row = Record<string, any>;
const db = vi.hoisted(() => ({
  jobs: [] as Row[],
  segments: [] as Row[],
  entries: [] as Row[],
  appts: [] as Row[],
  writes: [] as { table: string; op: string; patch?: Row }[],
  tz: "America/Los_Angeles",
}));

/** A small in-memory PostgREST: the calls the schedule writers make, over four tables. */
function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "update" | "insert" | "delete" = "select";
  let patch: Row | null = null;
  let inserted: Row[] = [];
  let returning = false;
  let single = false;
  let orderBy: string | null = null;
  const rowsOf = (): Row[] =>
    table === "jobs" ? db.jobs : table === "job_schedule_segments" ? db.segments : table === "time_entries" ? db.entries : table === "appointments" ? db.appts : [];
  const run = () => {
    if (table === "organizations") return { data: single ? { settings: { timezone: db.tz, work_day_start: "09:00", work_day_end: "17:00" } } : [], error: null };
    if (table === "schedule_proposals") return { data: [], error: null };
    const all = rowsOf();
    const hit = all.filter((r) => filters.every((f) => f(r)));
    if (op === "insert") {
      db.writes.push({ table, op });
      for (const r of inserted) all.push({ id: `row-${all.length + 1}`, ...r });
      return { data: returning ? inserted : null, error: null };
    }
    if (op === "delete") {
      db.writes.push({ table, op });
      for (const r of hit) all.splice(all.indexOf(r), 1);
      return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
    }
    if (op === "update") {
      db.writes.push({ table, op, patch: patch! });
      for (const r of hit) Object.assign(r, patch);
      return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
    }
    const out = orderBy ? [...hit].sort((a, b) => String(a[orderBy!]).localeCompare(String(b[orderBy!]))) : hit;
    const copy = out.map((r) => ({ ...r }));
    return { data: single ? (copy[0] ?? null) : copy, error: null };
  };
  const b: any = {
    select: () => ((returning = op !== "select"), b),
    insert: (r: Row | Row[]) => ((op = "insert"), (inserted = Array.isArray(r) ? r : [r]), b),
    update: (p: Row) => ((op = "update"), (patch = p), b),
    delete: () => ((op = "delete"), b),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
    is: (c: string, v: null) => (filters.push((r) => (r[c] ?? null) === v), b),
    lte: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) <= v), b),
    lt: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) < v), b),
    gte: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) >= v), b),
    gt: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) > v), b),
    order: (c: string) => ((orderBy = c), b),
    limit: () => b,
    maybeSingle: async () => ((single = true), run()),
    single: async () => ((single = true), run()),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}
const client = { from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: client, userId: "office-1", orgId: "org-1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => undefined) }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn(async () => undefined) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));

const { placeAppointmentOnDay, placeJobOnDay, undoPlaceJob, undoPlaceVisit, sizeAppointment } = await import("./actions");
const { RailCardRows } = await import("./place-rail");
const { todayStrInTz } = await import("@/lib/tz");
const { addDays } = await import("@/lib/come-back-days");

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

beforeEach(() => {
  db.jobs = [];
  db.segments = [];
  db.entries = [];
  db.appts = [];
  db.writes = [];
});

describe("the tray is cut: the rail is the one door for waiting work", () => {
  it("the calendar has no 'To Schedule ·' tray, no CalUnscheduled type and no unscheduled prop", () => {
    const view = read("src/app/(app)/calendar/calendar-view.tsx");
    const live = code("src/app/(app)/calendar/calendar-view.tsx");
    expect(live).not.toMatch(/To Schedule ·|To schedule ·/);
    expect(view).not.toContain("CalUnscheduled");
    expect(live).not.toMatch(/\bunscheduled\b/);
    // Its Undo pill and its snapshot/placer went with it.
    for (const gone of ["runUndo", "placeOnDay(", "trayOpen", "unplaceJob"]) expect(live, gone).not.toContain(gone);
  });

  it("the panel no longer reads dateless jobs for it (one query fewer per schedule load)", () => {
    const panel = code("src/app/(app)/schedule/calendar-panel.tsx");
    expect(panel).not.toContain('.is("scheduled_start", null)');
    expect(panel).not.toContain("unschedRows");
  });

  it("a day tap drills in unless the rail has armed it (the header says so)", () => {
    expect(read("src/app/(app)/calendar/calendar-view.tsx")).toContain("tap drills into that day, UNLESS the rail has armed it");
  });
});

describe("a rail card: one ⋯, no status dropdown", () => {
  const job = (over: Record<string, unknown> = {}) => ({
    id: "j1",
    kind: "job" as const,
    name: "498 May Dell Lane",
    address: "498 May Dell Lane",
    city: "Truckee",
    status: "to_be_scheduled",
    ...over,
  });
  const rows = (i: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(RailCardRows, { i: i as any, todayStr: "2026-09-28", close: () => {} }));

  it("the card carries no Job status select, no inline hold reason and no 'Open →'; it imports the app's one row sheet", () => {
    const rail = code("src/app/(app)/schedule/place-rail.tsx");
    expect(rail).not.toContain('aria-label="Job status"');
    expect(rail).not.toContain("Why is this on hold");
    expect(rail).not.toContain("Open →");
    expect(rail).not.toContain("setJobStatus");
    expect(read("src/app/(app)/schedule/place-rail.tsx")).toContain('import { RowMoreSheet, SheetLink, SHEET_ROW } from "@/components/row-more-sheet";');
    // The ⋯ sits beside the box and the body, never inside either.
    expect(rail).toMatch(/<RailCardMore i=\{i\} todayStr=\{todayStr\} \/>/);
  });

  it("a job not on hold: Open The Job, and Put On Hold…", () => {
    const html = rows(job());
    expect(html).toMatch(/<a[^>]*href="\/jobs\/j1"[^>]*>Open The Job<\/a>/);
    expect(text(html)).toContain("Put On Hold…");
    expect(text(html)).not.toMatch(/Snooze|Change Why|Take Off Hold/);
  });

  it("a held job: Snooze…, Change Why… and Take Off Hold; never Put On Hold", () => {
    const t = text(rows(job({ onHold: true, holdReason: "Waiting on the permit", status: "on_hold" })));
    for (const w of ["Open The Job", "Snooze…", "Change Why…", "Take Off Hold"]) expect(t, w).toContain(w);
    expect(t).not.toContain("Put On Hold");
  });

  it("a visit opens its visit, a lead its lead; neither has hold verbs", () => {
    const visit = rows({ id: "a1", kind: "appointment", name: "Site inspection: Rita Moss", address: null, city: null });
    expect(visit).toMatch(/<a[^>]*href="\/appointments\/a1"[^>]*>Open The Visit<\/a>/);
    const lead = rows({ id: "l1", kind: "lead", name: "Rita Moss", address: null, city: null });
    expect(lead).toMatch(/<a[^>]*href="\/leads\?focus=l1"[^>]*>Open The Lead<\/a>/);
    expect(text(visit + lead)).not.toMatch(/Hold|Snooze|Why/);
  });

  it("every row is a 44px door", () => {
    const html = rows(job({ onHold: true, holdReason: "x", status: "on_hold" }));
    for (const d of html.match(/<(button|a)\b[^>]*>/g) ?? []) expect(d, d).toMatch(/min-h-\[44px\]|\bh-11\b|min-h-11/);
  });

  it("the hold verbs: Hold It asks why and a day; Snooze asks why only when none is saved; Take Off Hold says where it goes", () => {
    const rail = read("src/app/(app)/schedule/place-rail.tsx");
    expect(rail).toMatch(/label="Hold It"\s*requireWhy/);
    expect(rail).toContain("setJobHold(i.id, w, when)");
    expect(rail).toMatch(/label="Snooze"\s*askWhy=\{!i\.holdReason\}/);
    expect(rail).toContain("snoozeJobHold(i.id, when, w || null)");
    expect(rail).toContain("setJobHold(i.id, why.trim())");
    expect(rail).toContain("setJobHold(i.id, null)");
    expect(rail).toContain("`${i.name} is off hold. It stays here until it has a day.`");
  });

  it("the footer says Jump To The Calendar ↓ and Clear Time, every target 44px", () => {
    const rail = read("src/app/(app)/schedule/place-rail.tsx");
    expect(rail).toContain("Jump To The Calendar ↓");
    expect(rail).toContain("Clear Time");
    expect(rail).not.toMatch(/Jump to the calendar|clear time/);
    const footer = rail.slice(rail.indexOf("{chosen.length > 0 && ("));
    expect(footer).not.toMatch(/\bh-8\b/);
  });
});

describe("the heading counts what waits, and says when a list is capped", () => {
  it("'Waiting For A Day (n)', '(n+)' and one line when any rail read hits its cap", () => {
    const page = read("src/app/(app)/schedule/page.tsx");
    expect(page).toContain("Waiting For A Day <span");
    expect(page).toContain('({waiting.length}{railCapped ? "+" : ""})');
    expect(page).toContain("More is waiting than this list shows. Find the rest on Jobs and Leads.");
    expect(page).toContain("const RAIL_LIMITS = { leads: 500, jobs: 200, visits: 200 } as const;");
    for (const k of ["leads", "jobs", "visits"]) expect(page).toContain(`.limit(RAIL_LIMITS.${k})`);
  });
});

describe("Undo on the rail's place", () => {
  const today = () => todayStrInTz(db.tz);
  const dateless = (over: Row = {}) => ({
    id: "j1",
    name: "498 May Dell Lane",
    status: "to_be_scheduled",
    scheduled_start: null,
    scheduled_end: null,
    planned_minutes: null,
    ...over,
  });

  it("the place's toast carries Undo only when every job and visit landed, and never for a held job or a booked lead", () => {
    const ctx = read("src/app/(app)/schedule/placement-context.tsx");
    expect(ctx).toContain('toast(msg.text, msg.tone, { label: "Undo", onClick: () => undoPlace(priors, visits, withdrew) });');
    expect(ctx).toMatch(/!leads\.length &&/);
    expect(ctx).toContain("jobs.every((j, i) => !j.onHold && jobResults[i]?.ok && !!jobResults[i]?.prior)");
    expect(ctx).toContain("undoPlaceJob(p.id, p.prior)");
    // A visit goes back through the guarded undo (which calls unscheduleAppointment itself), and only
    // when the place handed back the start it wrote.
    expect(ctx).toContain("undoPlaceVisit(v.id, v.placedAt)");
    expect(ctx).toContain("apptResults.every((r) => r.ok && !!r.placedAt)");
    expect(ctx).not.toContain('from "../appointments/actions"');
    expect(read("src/app/(app)/schedule/actions.ts")).toContain("return unscheduleAppointment(id);");
    expect(ctx).toContain('"Put back where it was."');
    expect(ctx).toContain("The customer's pick-a-time link stays withdrawn.");
    // placeMessage (lane 4's test) is untouched: the Undo rides the toast's action.
    expect(read("src/lib/schedule/placement-plan.ts")).not.toContain("Undo");
  });

  it("placeJobOnDay returns what it changed, read before the write: the days, the status, the listed day", async () => {
    db.jobs = [dateless()];
    db.segments = [{ id: "s1", job_id: "j1", start_date: "2026-09-22", end_date: "2026-09-22" }];
    db.entries = [{ id: "e1", job_id: "j1", clock_in: "2026-09-22T17:00:00Z" }];
    const day = addDays(today(), 3);
    const res = await placeJobOnDay("j1", day, "09:00");
    expect(res.ok).toBe(true);
    expect(res.prior).toMatchObject({ status: "to_be_scheduled", listed: null });
    expect(res.prior!.ranges.map((r) => [r.start, r.end])).toEqual([["2026-09-22", "2026-09-22"]]);
    expect(res.prior!.days).toEqual(["2026-09-22", day]);
    // The place did what it always did: the day is the plan, the worked day stays, Scheduled.
    expect(db.jobs[0].status).toBe("scheduled");
    expect(db.jobs[0].scheduled_start).not.toBeNull();
  });

  it("undoPlaceJob puts the days, the listed day and the status back", async () => {
    db.jobs = [dateless()];
    const day = addDays(today(), 3);
    const placed = await placeJobOnDay("j1", day, "09:00");
    expect(db.jobs[0].status).toBe("scheduled");
    db.writes = [];
    const res = await undoPlaceJob("j1", placed.prior!);
    expect(res).toEqual({ ok: true });
    expect(db.jobs[0]).toMatchObject({ status: "to_be_scheduled", scheduled_start: null, scheduled_end: null });
    expect(db.segments).toEqual([]);
    // The status went back only from Scheduled (the guard), in its own write.
    expect(db.writes.filter((w) => w.table === "jobs" && w.patch?.status === "to_be_scheduled")).toHaveLength(1);
  });

  it("refuses, in words and with nothing written, a job that changed since", async () => {
    db.jobs = [dateless()];
    const placed = await placeJobOnDay("j1", addDays(today(), 3), "09:00");
    // Someone added another day meanwhile.
    db.segments.push({ id: "s-new", job_id: "j1", start_date: addDays(today(), 5), end_date: addDays(today(), 5) });
    db.writes = [];
    expect(await undoPlaceJob("j1", placed.prior!)).toEqual({ ok: false, error: "It changed since, so nothing was undone." });
    expect(db.writes).toEqual([]);
    expect(db.jobs[0].status).toBe("scheduled");
  });

  it("a job the place took off hold gets no Undo (its reason and day went with the hold)", async () => {
    db.jobs = [dateless({ status: "on_hold", hold_reason: "Waiting on the permit" })];
    const placed = await placeJobOnDay("j1", addDays(today(), 3), "09:00");
    expect(placed.prior!.status).toBe("on_hold");
    db.writes = [];
    const res = await undoPlaceJob("j1", placed.prior!);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/can't put a job back on hold/);
    expect(db.writes).toEqual([]);
  });

  it("a status that moved on since is left as it is, and the answer says so", async () => {
    db.jobs = [dateless()];
    const placed = await placeJobOnDay("j1", addDays(today(), 3), "09:00");
    db.jobs[0].status = "in_progress";
    const res = await undoPlaceJob("j1", placed.prior!);
    expect(res.ok).toBe(true);
    expect(res.note).toBe("Its days are back. Its status had moved on since, so it stays as it is.");
    expect(db.jobs[0].status).toBe("in_progress");
  });

  it("a job with a listed day gets its exact start and end back", async () => {
    const start = "2026-10-05T16:00:00.000Z";
    const end = "2026-10-05T18:00:00.000Z";
    db.jobs = [dateless({ status: "scheduled", scheduled_start: start, scheduled_end: end, planned_minutes: 120 })];
    db.segments = [{ id: "s1", job_id: "j1", start_date: "2026-10-05", end_date: "2026-10-05" }];
    const placed = await placeJobOnDay("j1", "2026-10-07", "13:00");
    expect(placed.prior!.listed).toEqual({ start: "2026-10-05", end: "2026-10-05", startIso: start, endIso: end });
    expect(await undoPlaceJob("j1", placed.prior!)).toEqual({ ok: true });
    expect(db.jobs[0]).toMatchObject({ scheduled_start: start, scheduled_end: end, planned_minutes: 120, status: "scheduled" });
    expect(db.segments.map((s) => [s.start_date, s.end_date])).toEqual([["2026-10-05", "2026-10-05"]]);
  });

  it("a prior that isn't one is refused", async () => {
    expect(await undoPlaceJob("j1", { ranges: [{ start: "nope", end: "x" }], status: null, listed: null, days: [] } as any)).toEqual({
      ok: false,
      error: "There's nothing to put back.",
    });
  });

  /* A VISIT'S UNDO KEEPS THE SAME PROMISE AS A JOB'S. The toast lives ten seconds; if someone moves the
     same visit in that time, Undo must not take their newer time away and call it "Put back where it
     was." — it says what happened instead. */
  describe("a placed visit", () => {
    const waiting = () => [{ id: "a1", title: "Smith walk-through", type: "inspection", status: "scheduled", starts_at: null, ends_at: null, planned_minutes: null }];

    it("the place hands back the start it wrote, and the Undo puts the visit back to waiting", async () => {
      db.appts = waiting();
      const placed = await placeAppointmentOnDay("a1", "2026-10-07", "09:00", 120);
      expect(placed.ok).toBe(true);
      expect(placed.placedAt).toBe(db.appts[0].starts_at);
      db.writes = [];
      expect(await undoPlaceVisit("a1", placed.placedAt!)).toEqual({ ok: true });
      expect(db.appts[0]).toMatchObject({ starts_at: null, ends_at: null, status: "scheduled" });
    });

    it("refuses in words, and leaves the newer time alone, when the visit moved since the place", async () => {
      db.appts = waiting();
      const placed = await placeAppointmentOnDay("a1", "2026-10-07", "09:00", 120);
      // Another tab moved it an hour later while the Undo toast was still up.
      const moved = "2026-10-07T17:00:00.000Z";
      db.appts[0].starts_at = moved;
      db.writes = [];
      expect(await undoPlaceVisit("a1", placed.placedAt!)).toEqual({ ok: false, error: "It changed since, so nothing was undone." });
      expect(db.appts[0].starts_at).toBe(moved);
      expect(db.appts[0].ends_at).not.toBeNull();
      // The guard's own UPDATE matched no row (so it wrote nothing); the day was never cleared.
      expect(db.writes.some((w) => w.patch && ("starts_at" in w.patch || "status" in w.patch))).toBe(false);
    });

    it("a start that isn't one is refused, with nothing written", async () => {
      db.appts = waiting();
      db.writes = [];
      expect(await undoPlaceVisit("a1", "not a time")).toEqual({ ok: false, error: "There's nothing to put back." });
      expect(db.writes).toEqual([]);
      expect(db.appts[0].starts_at).toBeNull();
    });
  });
});

describe("the small parts: every header door 44px (W2-01), one word (W2-10), no junk kind (W2-06)", () => {
  const view = () => read("src/app/(app)/calendar/calendar-view.tsx");

  it("the header's icons are 44px targets, Everyone's Day first, its link, gate and href exactly as they were", () => {
    const v = view();
    expect(v).toContain(`const iconBtn =\n    "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg before:absolute before:-inset-1.5 before:content-['']";`);
    const at = v.indexOf('href="/schedule?view=crew"');
    expect(at).toBeGreaterThan(0);
    expect(v.slice(Math.max(0, at - 300), at)).toMatch(/\{crewBoard && \(/);
    expect(v.slice(at, at + 300)).toContain("className={`${iconBtn} text-slate-400");
    // The paging buttons: 32px to the eye, 44 to the thumb (the icon-sm bleed; Today bleeds up and down).
    expect(v).toContain('<Button size="icon-sm" variant="outline" onClick={() => shiftAnchor(-1)} aria-label="Previous" title="Previous">');
    expect(v).toContain('<Button size="icon-sm" variant="outline" onClick={() => shiftAnchor(1)} aria-label="Next" title="Next">');
    expect(v).toContain(`className="relative overflow-visible! before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']"`);
    expect(v).toMatch(/← Week/);
    expect(v).toContain("before:-inset-y-3.5");
    // The person filter's chips, the armed strip's Cancel, and the day drill's small icons: 44px.
    expect(v.match(/className="flex h-11 shrink-0 items-center"/g)?.length).toBe(2);
    expect(v).toContain('className="ml-auto inline-flex min-h-11 items-center px-1 text-xs font-semibold');
    expect(v).not.toMatch(/rounded-md p-1 text-slate-400/);
    expect(v).not.toMatch(/const iconBtn = "flex h-8 w-8/);
  });

  it("the calendar's walk-through tooltip says Walk-through", () => {
    const v = view();
    expect(v).toContain('title="Walk-through — notes, measurements, photos"');
    expect(v).not.toContain("Inspection capture");
  });

  it("sizeAppointment refuses a kind that isn't one, and takes any known kind (an old Quote or Office too) and Other", async () => {
    db.appts = [{ id: "a1", type: "inspection", starts_at: null, planned_minutes: null }];
    expect(await sizeAppointment("a1", { workKind: "junk" })).toEqual({ ok: false, error: "That isn't a kind of work." });
    expect(db.writes).toEqual([]);
    for (const k of ["quote", "office", "service", "other"]) {
      expect(await sizeAppointment("a1", { workKind: k }), k).toEqual({ ok: true });
    }
    // A size alone never asks about the kind.
    expect(await sizeAppointment("a1", { plannedMinutes: 60 })).toEqual({ ok: true });
  });
});
