import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A VISIT ALREADY ANSWERED IS NOT ASKED ABOUT AGAIN (cn-v1158; found by the review of cn-v1157).
 *
 * On /inspections a visit that was scheduled, is past and holds no notes sits under Didn't Happen?,
 * and one of its two answers is Lost: the visit's OUTCOME is written (appointments.outcome, 0205) and
 * its status stays 'scheduled'. The page files it from then on. But My Day's Visits to Close Out read
 * past visits by STATUS alone and never read the outcome, so the visit he had just answered came back
 * there, asking to be closed out. The same for a write-up row marked Lost from its ⋯ while the visit
 * was still scheduled: it left Inspections to Write Up and reappeared one pile over.
 *
 * The owner's rule is by outcome, whatever the status: a visit that did not become work is LOST,
 * everywhere. An answer of any kind (0205: null means still open business) ends the asking.
 *
 * THE FAKE DATABASE HERE APPLIES THE FILTERS IT IS SENT (eq, is, in, the day window, the order and the
 * limit, with the exact count taken before the limit, as PostgREST gives it). The other fakes in this
 * folder hand every row to every read, which is right for what they test and would pass this file
 * with the filter deleted. This one answers as the database would, so the rows leave only because
 * the QUERY said so.
 */

type Call = [method: string, ...args: unknown[]];
type ReadLog = { table: string; cols: string; calls: Call[] };

const state = vi.hoisted(() => ({ visits: [] as any[], reads: [] as { table: string; cols: string; calls: [string, ...unknown[]][] }[] }));

const when = (v: unknown) => Date.parse(String(v));

/** One filter on one row, the way the database would decide it. Anything else (order, limit) keeps. */
function keeps(row: Record<string, unknown>, [method, col, val]: Call): boolean {
  const v = row[String(col)];
  if (method === "eq") return v === val;
  if (method === "is") return val === null ? v === null || v === undefined : v === val;
  if (method === "in") return (val as unknown[]).includes(v);
  if (method === "gte") return when(v) >= when(val);
  if (method === "lte") return when(v) <= when(val);
  if (method === "lt") return when(v) < when(val);
  return true;
}

/** The rows a read gets back, and its exact count (every row that passed, before the limit). */
function answer(read: ReadLog): { data: any; count: number } {
  if (read.table === "profiles") return { data: { org_id: "org-1", role: "owner" }, count: 1 };
  if (read.table !== "appointments") return { data: [], count: 0 };
  let rows = state.visits.filter((r) => read.calls.every((c) => keeps(r, c)));
  const order = read.calls.find((c) => c[0] === "order") as [string, string, { ascending?: boolean }?] | undefined;
  if (order) {
    const dir = order[2]?.ascending === false ? -1 : 1;
    rows = [...rows].sort((a, b) => dir * (when(a[order[1]]) - when(b[order[1]])));
  }
  const count = rows.length;
  const limit = read.calls.find((c) => c[0] === "limit");
  return { data: limit ? rows.slice(0, Number(limit[1])) : rows, count };
}

function fakeClient() {
  const chain = (table: string) => {
    const read: ReadLog = { table, cols: "", calls: [] };
    state.reads.push(read);
    const q: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const { data, count } = answer(read);
            return (ok: any, err: any) => Promise.resolve({ data, error: null, count }).then(ok, err);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return async () => {
              const { data } = answer(read);
              return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null };
            };
          }
          if (prop === "select") {
            return (c?: string) => {
              read.cols = c ?? "";
              return q;
            };
          }
          return (...args: unknown[]) => {
            read.calls.push([prop, ...args]);
            return q;
          };
        },
      },
    );
    return q;
  };
  return { from: (table: string) => chain(table), rpc: () => chain("rpc") };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { getActionItems } from "./query";

const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T20:00:00Z`) - n * 86_400_000).toISOString();
const NOTES = { notes: "100A panel, full. Wants a 200A service.", measurements: "", materials: "", photos: [] };

/** A past visit, still 'scheduled', nothing on it, nobody's answer: the row Visits to Close Out asks about. */
const visit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: "inspection",
  title: `Visit ${id}`,
  starts_at: daysAgo(3),
  status: "scheduled",
  job_id: null,
  inquiry_id: null,
  assigned_to: "tech-1",
  absorbed: false,
  location: null,
  capture: null,
  outcome: null,
  customers: { name: "Sam Tillery" },
  inquiries: null,
  ...over,
});

beforeEach(() => {
  state.visits = [];
  state.reads = [];
});

const office = () => getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
/** Every row on Now, a pile opened into its rows. */
const rows = (r: Awaited<ReturnType<typeof office>>) => r.now.flatMap((i) => i.children ?? [i]);
const idsOf = (r: Awaited<ReturnType<typeof office>>, kind: string) => rows(r).filter((i) => i.kind === kind).map((i) => i.id).sort();

describe("Visits to Close Out asks only about a visit nobody has answered", () => {
  it("the Didn't Happen? row answered Lost is gone from the pile; the unanswered one beside it still asks", async () => {
    state.visits = [visit("open-1"), visit("answered-lost", { outcome: "lost", customers: { name: "Dana Rook" } })];
    const r = await office();
    expect(idsOf(r, "appointment")).toEqual(["open-1"]);
    // Nowhere else on Now either: it is filed, not moved.
    expect(rows(r).map((i) => i.id)).not.toContain("answered-lost");
  });

  it("before the answer it WAS asked (the control: this fixture is the pile's own row)", async () => {
    state.visits = [visit("open-1"), visit("answered-lost", { outcome: null })];
    expect(idsOf(await office(), "appointment")).toEqual(["answered-lost", "open-1"]);
  });

  it("a write-up row marked Lost while its visit is still scheduled leaves BOTH piles", async () => {
    // Field notes on a past, still-scheduled visit: Inspections to Write Up, with Lost under its ⋯.
    state.visits = [visit("wu", { capture: NOTES })];
    const before = await office();
    expect(idsOf(before, "inspection_writeup")).toEqual(["wu"]);
    expect(idsOf(before, "appointment")).toEqual([]);
    // ⋯ Lost writes the outcome and nothing else (dispatch-map: appointment.setOutcome).
    state.visits = [visit("wu", { capture: NOTES, outcome: "lost" })];
    const after = await office();
    expect(idsOf(after, "inspection_writeup")).toEqual([]);
    expect(idsOf(after, "appointment")).toEqual([]);
  });

  it("any answer ends the asking: lost, the old no_bid, and won; on every kind of visit", async () => {
    state.visits = [
      visit("open-1"),
      visit("lost", { outcome: "lost" }),
      visit("no-bid", { outcome: "no_bid" }),
      visit("won", { outcome: "won", job_id: "job-1" }),
      // Not an estimate visit: the write-up feeder never reads it, so this pile was its only reader.
      visit("meeting-lost", { type: "meeting", outcome: "lost" }),
      visit("open-call", { type: "call" }),
    ];
    expect(idsOf(await office(), "appointment")).toEqual(["open-1", "open-call"]);
  });

  it("a tech's own list too: his answered visit is not put in front of him again", async () => {
    state.visits = [visit("his-open"), visit("his-lost", { outcome: "lost" }), visit("someone-elses", { assigned_to: "tech-2" })];
    const r = await getActionItems({ todayStr: TODAY, isStaff: false, userId: "tech-1", tz: "America/Los_Angeles" });
    expect(rows(r).map((i) => i.id)).toEqual(["his-open"]);
  });
});

describe("the outcome is tested IN THE QUERY, so the pile's count is the read's own count", () => {
  it("the read is sent the filter: status scheduled, not absorbed, outcome null", async () => {
    state.visits = [visit("open-1")];
    await office();
    // The close-out read is the appointments read that names assigned_to (the write-up read names capture).
    const read = state.reads.find((x) => x.table === "appointments" && x.cols.includes("assigned_to"));
    expect(read, "the close-out read ran").toBeTruthy();
    expect(read!.calls).toContainEqual(["eq", "status", "scheduled"]);
    expect(read!.calls).toContainEqual(["eq", "absorbed", false]);
    expect(read!.calls).toContainEqual(["is", "outcome", null]);
  });

  it("sixty answered visits older than two open ones: the pile is the two, counted 2, never '2+' and never crowded out", async () => {
    // The read is the OLDEST 50 with an exact count. Were the outcome tested in code after the read,
    // the sixty answered ones (older, so first) would fill all 50 places: the two visits still asking
    // would never be read at all, and the count would be 62.
    const answered = Array.from({ length: 60 }, (_, i) => visit(`old-${i}`, { starts_at: daysAgo(10), outcome: "lost" }));
    state.visits = [...answered, visit("open-1", { starts_at: daysAgo(2) }), visit("open-2", { starts_at: daysAgo(1) })];
    const r = await office();
    const pile = r.now.find((i) => i.id === "pile:visits_to_close_out");
    expect(pile, "two open visits roll into the pile").toBeTruthy();
    expect(pile!.title).toBe("Visits to Close Out · 2");
    expect(pile!.children!.map((c) => c.id).sort()).toEqual(["open-1", "open-2"]);
  });

  it("in the source: the filter sits in apptP's own chain, and the loop that draws the rows tests no outcome", () => {
    const q = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    const read = q.slice(q.indexOf("const apptP"), q.indexOf("const inspP"));
    expect(read).toMatch(/\.eq\("status", "scheduled"\)\s*\.eq\("absorbed", false\)\s*\.is\("outcome", null\)\s*\.gte\("starts_at", dayStartIso\(from\)\)\s*\.lt\("starts_at", dayStartIso\(todayStr\)\);/);
    // Sent before the tech's own filter, the order and the limit: one read, for the office and a tech alike.
    expect(read.indexOf('.is("outcome", null)')).toBeLessThan(read.indexOf('q.eq("assigned_to", userId)'));
    const loop = q.slice(q.indexOf("// ── VISITS NOBODY CLOSED OUT."), q.indexOf("counts.visits_to_close_out = codeCount(apptR);"));
    expect(loop.length).toBeGreaterThan(200);
    expect(loop).not.toContain("outcome");
  });
});

/**
 * THE NEIGHBOURS THAT READ THE SAME PAST VISITS ALREADY ASKED THE OUTCOME, each through the one
 * function they share (lib/inspections bucketInspections: any outcome settles a visit whose time has
 * passed). Pinned here because it holds only while their SELECT lists name the column: a projection
 * that drops `outcome` would hand bucketInspections a row with no answer on it, and the lost visit
 * would be back under Inspections to Write Up, or under Didn't Happen?, with nothing failing.
 */
describe("the write-up feeder and the Didn't Happen? group read the outcome column", () => {
  /** The columns of the first select in a piece of source, as a list. */
  const selected = (source: string) => (/\.select\(\s*"([^"]*)"/.exec(source)?.[1] ?? "").split(/,\s*/);
  /** What bucketInspections decides a row's pile from: drop one from a select and it decides blind. */
  const BUCKET_READS = ["status", "starts_at", "capture", "inquiry_id", "job_id", "outcome"];

  it("Inspections to Write Up (inspP) selects outcome and hands its rows to bucketInspections", () => {
    const q = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    const cols = selected(q.slice(q.indexOf("const inspP"), q.indexOf("const doneP")));
    for (const c of BUCKET_READS) expect(cols, c).toContain(c);
    expect(q).toMatch(/const \{ toWriteUp \} = bucketInspections\(\s*\(inspR\.data \?\? \[\]\) as any\[\],/);
  });

  it("the Inspections page (the Didn't Happen? group's source) selects outcome and buckets with the same function", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/inspections/page.tsx"), "utf8");
    const cols = selected(page.slice(page.indexOf('.from("appointments")')));
    for (const c of BUCKET_READS) expect(cols, c).toContain(c);
    expect(page).toMatch(/const \{ toWriteUp, upcoming, missed, filed \} = bucketInspections\(/);
  });

  it("driven: an answered visit with field notes is not a write-up row, whatever its status", async () => {
    state.visits = [
      visit("open-notes", { capture: NOTES }),
      visit("lost-notes", { capture: NOTES, outcome: "lost" }),
      visit("lost-done", { status: "completed", outcome: "lost" }),
      visit("nobid-done", { status: "completed", outcome: "no_bid" }),
    ];
    expect(idsOf(await office(), "inspection_writeup")).toEqual(["open-notes"]);
  });
});
