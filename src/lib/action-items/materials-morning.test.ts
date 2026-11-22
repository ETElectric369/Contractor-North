import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE MORNING MATERIALS NOTICE (cn-v1179). The owner, 2026-11-22: "picking up materials which could
 * be a reminder notification the morning of a job". Pinned here:
 *   - THE RULE is Needs You's materials row narrowed to the company's TODAY, on a stand-in database
 *     that honours every filter and the column list it is asked for (a stand-in that ignored them
 *     would let another company's job through and prove nothing);
 *   - the two doors share their rule functions (a source pin on this file and on query.ts);
 *   - the words: one job, several, "+N more jobs", both languages, no price;
 *   - the step: the office only (a tech never), once a day by the bell's lines, nothing when nothing
 *     is to buy, a lost read sends nothing and files its row.
 */

type Row = Record<string, any>;
type Db = Record<string, Row[] | { error: { message: string; code?: string } }>;

/** The top-level names a select asks for: "a, b, rel(x, y)" -> a, b, rel. */
function selected(cols: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of cols) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((c) => c.replace(/\(.*$/s, "").replace(/!.*$/, "").trim());
}

/** A stand-in that HONOURS the filters, the order, the limit and the column list. */
function fakeDb(db: Db) {
  const reads: { table: string; filters: string[] }[] = [];
  const from = (table: string) => {
    const preds: ((r: Row) => boolean)[] = [];
    const filters: string[] = [];
    const orders: [string, boolean][] = [];
    let cols = "*";
    let lim = Infinity;
    const q: any = {
      select(c: string) {
        cols = c;
        return q;
      },
      eq(c: string, v: unknown) {
        filters.push(`${c}=${v}`);
        preds.push((r) => r[c] === v);
        return q;
      },
      in(c: string, vs: unknown[]) {
        filters.push(`${c} in`);
        preds.push((r) => vs.includes(r[c]));
        return q;
      },
      gte(c: string, v: string) {
        filters.push(`${c}>=${v}`);
        preds.push((r) => r[c] != null && String(r[c]) >= v);
        return q;
      },
      gt(c: string, v: string) {
        filters.push(`${c}>${v}`);
        preds.push((r) => r[c] != null && String(r[c]) > v);
        return q;
      },
      lte(c: string, v: string) {
        filters.push(`${c}<=${v}`);
        preds.push((r) => r[c] != null && String(r[c]) <= v);
        return q;
      },
      lt(c: string, v: string) {
        filters.push(`${c}<${v}`);
        preds.push((r) => r[c] != null && String(r[c]) < v);
        return q;
      },
      order(c: string, o?: { ascending?: boolean }) {
        orders.push([c, o?.ascending !== false]);
        return q;
      },
      limit(n: number) {
        lim = n;
        return q;
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        reads.push({ table, filters });
        const t = db[table];
        if (t && !Array.isArray(t)) return Promise.resolve({ data: null, error: t.error }).then(resolve, reject);
        let rows = (t ?? []).filter((r) => preds.every((p) => p(r)));
        for (const [c, asc] of [...orders].reverse()) {
          rows = [...rows].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1));
        }
        const names = cols === "*" ? null : selected(cols);
        const data = rows.slice(0, lim).map((r) => (names ? Object.fromEntries(names.filter((n) => n in r).map((n) => [n, r[n]])) : r));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  return { from, reads };
}

const svc = vi.hoisted(() => ({ client: null as any }));
const sent = vi.hoisted(() => ({ calls: [] as any[][] }));
const orgs = vi.hoisted(() => ({ rows: [] as { id: string; settings: unknown }[], lapsed: 0 }));
const sink = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => svc.client, createClient: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  notifyPeople: vi.fn(async (...a: any[]) => {
    sent.calls.push(a);
    return { bell: true, pushed: a[1] };
  }),
}));
vi.mock("@/lib/cron-orgs", () => ({ readActiveOrgs: vi.fn(async () => ({ rows: orgs.rows, lapsedSkipped: orgs.lapsed })) }));
vi.mock("@/lib/observe", () => ({ reportError: sink.reportError, reportErrorAwaited: vi.fn() }));

import { companyToday, materialsTodayNotice, readMaterialsToday, sendMaterialsMorning, type MaterialsTodayJob } from "./materials-morning";
import { translator } from "@/lib/i18n";

const ORG = "org-north";
const OTHER = "org-other";
const TZ = "America/Los_Angeles";
// Monday 2026-11-23, 8:00 AM Pacific (PST, UTC-8): the company's 8 AM run.
const NOW = Date.parse("2026-11-23T16:00:00Z");

const job = (id: string, over: Row = {}): Row => ({
  id,
  org_id: ORG,
  job_number: `J-${id.slice(-3)}`,
  name: id[0].toUpperCase() + id.slice(1).replace(/-\d+$/, ""),
  status: "scheduled",
  scheduled_start: null,
  ...over,
});
const lines = (open: number, extra: Row[] = []) => [
  ...Array.from({ length: open }, () => ({ purchased: false, is_tool: false })),
  { purchased: true, is_tool: false },
  { purchased: false, is_tool: true }, // a tool is brought, not bought
  ...extra,
];
const list = (jobId: string, open: number, over: Row = {}): Row => ({
  id: `list-${jobId}`,
  org_id: ORG,
  job_id: jobId,
  created_at: "2026-11-01T00:00:00Z",
  material_list_items: lines(open),
  ...over,
});

/** The table the rule is judged on: each job is named for the reason it is in or out. */
function world(): Db {
  const jobs = [
    job("larkspur-101", { scheduled_start: "2026-11-23T17:00:00.000Z" }), // today, 9 AM: IN (5)
    // 11:30 PM on the company's Monday is already Tuesday in UTC: still the company's today: IN (1)
    job("thistlewood-102", { scheduled_start: "2026-11-24T07:30:00.000Z" }),
    // 9 PM Sunday Pacific is Monday in UTC: NOT the company's today: OUT
    job("sundaynight-103", { scheduled_start: "2026-11-23T05:00:00.000Z" }),
    job("bayberry-104", { scheduled_start: "2026-11-24T17:00:00.000Z" }), // tomorrow: OUT
    job("held-105", { scheduled_start: "2026-11-23T17:00:00.000Z", status: "on_hold" }), // OUT
    job("cancelled-106", { scheduled_start: "2026-11-23T17:00:00.000Z", status: "cancelled" }), // OUT
    job("finished-107", { scheduled_start: "2026-11-23T17:00:00.000Z", status: "complete" }), // OUT
    job("snoozed-108", { scheduled_start: "2026-11-23T18:00:00.000Z" }), // snoozed to Wednesday: OUT
    job("backtoday-109", { scheduled_start: "2026-11-23T18:00:00.000Z" }), // its snooze ended today: IN (1)
    job("bought-110", { scheduled_start: "2026-11-23T18:00:00.000Z" }), // nothing open: OUT
    job("relisted-111", { scheduled_start: "2026-11-23T18:00:00.000Z" }), // the OLD list is open, the newest is not: OUT
    job("snowbell-112", { scheduled_start: "2026-11-20T16:00:00.000Z", status: "in_progress" }), // a segment covers today: IN (2)
    job("otherco-113", { org_id: OTHER, scheduled_start: "2026-11-23T17:00:00.000Z" }), // ANOTHER COMPANY: OUT
    job("othersegment-114", { org_id: OTHER, scheduled_start: "2026-11-01T16:00:00.000Z" }), // another company's segment: OUT
  ];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const segJob = (id: string) => {
    const j = byId.get(id)!;
    return { id: j.id, org_id: j.org_id, job_number: j.job_number, name: j.name, status: j.status };
  };
  return {
    jobs,
    job_schedule_segments: [
      { org_id: ORG, job_id: "snowbell-112", start_date: "2026-11-22", end_date: "2026-11-25", jobs: segJob("snowbell-112") },
      { org_id: ORG, job_id: "bayberry-104", start_date: "2026-11-24", end_date: "2026-11-26", jobs: segJob("bayberry-104") }, // starts tomorrow
      { org_id: OTHER, job_id: "othersegment-114", start_date: "2026-11-20", end_date: "2026-11-30", jobs: segJob("othersegment-114") },
    ],
    material_lists: [
      list("larkspur-101", 5),
      list("thistlewood-102", 1),
      list("sundaynight-103", 4),
      list("bayberry-104", 3),
      list("held-105", 2),
      list("cancelled-106", 2),
      list("finished-107", 2),
      list("snoozed-108", 2),
      list("backtoday-109", 1),
      list("bought-110", 0),
      list("relisted-111", 6, { id: "list-old-111", created_at: "2026-10-01T00:00:00Z" }),
      list("relisted-111", 0, { id: "list-new-111", created_at: "2026-11-10T00:00:00Z" }),
      list("snowbell-112", 2),
      list("otherco-113", 4, { org_id: OTHER }),
      list("othersegment-114", 4, { org_id: OTHER }),
    ],
    needs_you_waits: [
      { org_id: ORG, item_key: "materials_needed:snoozed-108", until: "2026-11-25", reason: "Back-ordered" },
      { org_id: ORG, item_key: "materials_needed:backtoday-109", until: "2026-11-23", reason: "Back-ordered" },
      // Another company's snooze on Larkspur's id never quiets OUR row.
      { org_id: OTHER, item_key: "materials_needed:larkspur-101", until: "2026-11-30", reason: null },
    ],
    profiles: [
      { id: "sam-owner", org_id: ORG, role: "owner", active: true },
      { id: "dana-office", org_id: ORG, role: "office", active: true },
      { id: "theo-tech", org_id: ORG, role: "tech", active: true },
      { id: "casey-gone", org_id: ORG, role: "office", active: false },
      { id: "other-owner", org_id: OTHER, role: "owner", active: true },
    ],
    notifications: [],
  };
}

describe("the company's today", () => {
  it("is the company's calendar day and its own midnight-to-midnight, never the server's UTC date", () => {
    expect(companyToday(TZ, NOW)).toEqual({
      todayStr: "2026-11-23",
      dayStart: new Date("2026-11-23T08:00:00.000Z"),
      dayEnd: new Date("2026-11-24T08:00:00.000Z"),
    });
    // 11 PM Pacific on Monday is Tuesday in UTC; it is still Monday for the company.
    expect(companyToday(TZ, Date.parse("2026-11-24T07:00:00Z")).todayStr).toBe("2026-11-23");
  });
});

describe("readMaterialsToday: Needs You's rule, narrowed to today, one company", () => {
  it("the table: tomorrow, held, cancelled, finished, snoozed, nothing open, an old list, another company's job each left out", async () => {
    const db = fakeDb(world());
    const r = await readMaterialsToday(db, ORG, TZ, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jobs.map((j) => [j.id, j.open])).toEqual([
      ["larkspur-101", 5],
      ["snowbell-112", 2],
      ["backtoday-109", 1],
      ["thistlewood-102", 1],
    ]);
  });

  it("EVERY read names the company by hand (the service client reads all three)", async () => {
    const db = fakeDb(world());
    await readMaterialsToday(db, ORG, TZ, NOW);
    expect(db.reads.map((x) => x.table).sort()).toEqual(["job_schedule_segments", "jobs", "material_lists", "needs_you_waits"]);
    for (const read of db.reads) expect(read.filters, read.table).toContain(`org_id=${ORG}`);
  });

  it("the other company, read with its own id, sees its own jobs and none of ours", async () => {
    const r = await readMaterialsToday(fakeDb(world()), OTHER, TZ, NOW);
    expect(r.ok && r.jobs.map((j) => j.id)).toEqual(["otherco-113", "othersegment-114"]);
  });

  it("a lost read is a failure, never 'nothing to buy': the jobs, the lists, or the snoozes", async () => {
    for (const table of ["jobs", "job_schedule_segments", "material_lists", "needs_you_waits"]) {
      const w = world();
      w[table] = { error: { message: `${table} timed out` } };
      const r = await readMaterialsToday(fakeDb(w), ORG, TZ, NOW);
      expect(r.ok, table).toBe(false);
    }
  });

  it("nothing on today: an empty answer, and no list read at all", async () => {
    const db = fakeDb(world());
    const r = await readMaterialsToday(db, ORG, TZ, Date.parse("2026-12-15T16:00:00Z"));
    expect(r).toEqual({ ok: true, jobs: [] });
    expect(db.reads.map((x) => x.table)).not.toContain("material_lists");
  });
});

describe("two doors, one rule (source pin)", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/action-items/materials-morning.ts"), "utf8");
  const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");

  it("this file calls the same exported rule functions the Needs You row calls, and keeps no list of statuses of its own", () => {
    expect(src).toContain('import { materialsJobStatusOk } from "./materials-needed-rule";');
    expect(src).toContain('import { isOpenToBuy, newestListPerJob } from "@/lib/materials-checklist";');
    expect(src).toContain('import { readNeedsYouWaits, waitKey } from "./needs-you-waits";');
    expect(src).toMatch(/materialsJobStatusOk\(j\.status\)/);
    expect(src).toMatch(/newestListPerJob\(/);
    expect(src).toMatch(/\.filter\(isOpenToBuy\)/);
    expect(src).toContain('waitKey("materials_needed", job.id)');
    expect(src).not.toMatch(/"(cancelled|complete|invoiced|on_hold)"/);
    // And the Needs You row still asks the same functions.
    expect(query).toContain('import { materialsJobStatusOk } from "./materials-needed-rule";');
    expect(query).toMatch(/newestListPerJob\(lists\)/);
    expect(query).toContain('waitKey("materials_needed", jobId)');
  });

  it("carries no catalog: the words come in through the translator the daily run hands it", () => {
    expect(src).not.toMatch(/from "@\/lib\/i18n"|from "@\/lib\/words\//);
  });
});

describe("the notice's words", () => {
  const J = (id: string, name: string, open: number, num = `J-${id}`): MaterialsTodayJob => ({ id, job_number: num, name, open });
  const en = (jobs: MaterialsTodayJob[]) => materialsTodayNotice(jobs, "en", translator("en"));
  const es = (jobs: MaterialsTodayJob[]) => materialsTodayNotice(jobs, "es", translator("es"));
  const five = [J("1", "Larkspur", 5), J("2", "Snowbell", 2), J("3", "Bayberry", 1), J("4", "Thistlewood", 1), J("5", "Juniper", 1)];

  it("one job: '<job>: 5 to buy', opening its Materials tab", () => {
    expect(en([J("1", "Larkspur", 5)])).toEqual({ title: "Materials to Buy Today", body: "Larkspur · J-1: 5 to buy", url: "/jobs/1?tab=materials" });
  });

  it("several: '<job> (5), <job> (2)', opening Needs You", () => {
    expect(en(five.slice(0, 2))).toEqual({ title: "Materials to Buy Today", body: "Larkspur · J-1 (5), Snowbell · J-2 (2)", url: "/planner" });
  });

  it("at most three named, then '+N more jobs' (one more: '+1 more job')", () => {
    expect(en(five)!.body).toBe("Larkspur · J-1 (5), Snowbell · J-2 (2), Bayberry · J-3 (1) +2 more jobs");
    expect(en(five.slice(0, 4))!.body).toBe("Larkspur · J-1 (5), Snowbell · J-2 (2), Bayberry · J-3 (1) +1 more job");
  });

  it("in Spanish", () => {
    expect(es([J("1", "Larkspur", 5)])).toEqual({ title: "Materiales por Comprar Hoy", body: "Larkspur · J-1: 5 por comprar", url: "/jobs/1?tab=materials" });
    expect(es(five)!.body).toBe("Larkspur · J-1 (5), Snowbell · J-2 (2), Bayberry · J-3 (1) +2 trabajos más");
    expect(es(five.slice(0, 4))!.body).toBe("Larkspur · J-1 (5), Snowbell · J-2 (2), Bayberry · J-3 (1) +1 trabajo más");
  });

  it("a job with neither name nor number reads 'A Job' (Needs You's own wording)", () => {
    expect(en([J("9", "", 2, "")])!.body).toBe("A Job: 2 to buy");
  });

  it("no price, ever, and nothing at all for no jobs", () => {
    for (const n of [en(five), es(five), en(five.slice(0, 1)), es(five.slice(0, 1))]) expect(JSON.stringify(n)).not.toMatch(/\$/);
    expect(en([])).toBeNull();
  });
});

describe("sendMaterialsMorning: the step", () => {
  let w: Db;
  beforeEach(() => {
    w = world();
    sent.calls = [];
    sink.reportError.mockReset();
    orgs.rows = [{ id: ORG, settings: { timezone: TZ } }];
    orgs.lapsed = 0;
  });
  const run = (only?: string[]) => {
    svc.client = fakeDb(w);
    return sendMaterialsMorning(svc.client, { nowMs: NOW, wordsFor: (lang) => translator(lang), ...(only ? { orgIds: new Set(only) } : {}) });
  };

  it("ONE notice to the office (owner and office, active), never a tech, of kind materials_today", async () => {
    const counts = await run();
    expect(counts).toMatchObject({ orgs: 1, sent: 1, failed: 0 });
    expect(sent.calls).toHaveLength(1);
    const [org, to, kind, words] = sent.calls[0];
    expect(org).toBe(ORG);
    expect(to.sort()).toEqual(["dana-office", "sam-owner"]);
    expect(kind).toBe("materials_today");
    expect(words("en")).toEqual({
      title: "Materials to Buy Today",
      body: "Larkspur · J-101 (5), Snowbell · J-112 (2), Backtoday · J-109 (1) +1 more job",
      url: "/planner",
    });
    expect(words("es").title).toBe("Materiales por Comprar Hoy");
    expect(JSON.stringify([words("en"), words("es")])).not.toMatch(/\$/);
  });

  it("ONCE A DAY: a person whose bell already has today's line is passed over; when everyone has it, nothing is sent", async () => {
    w.notifications = [
      { org_id: ORG, user_id: "sam-owner", type: "materials_today", created_at: "2026-11-23T08:30:00.000Z" }, // today: counts
      { org_id: ORG, user_id: "dana-office", type: "materials_today", created_at: "2026-11-22T16:00:00.000Z" }, // yesterday: not
      { org_id: ORG, user_id: "dana-office", type: "day_ahead", created_at: "2026-11-23T16:00:00.000Z" }, // another kind: not
      { org_id: OTHER, user_id: "dana-office", type: "materials_today", created_at: "2026-11-23T16:00:00.000Z" }, // another company: not
    ];
    await run();
    expect(sent.calls.map((c) => c[1])).toEqual([["dana-office"]]);

    sent.calls = [];
    (w.notifications as Row[]).push({ org_id: ORG, user_id: "dana-office", type: "materials_today", created_at: "2026-11-23T16:00:01.000Z" });
    const again = await run();
    expect(sent.calls).toEqual([]);
    expect(again).toMatchObject({ already: 1, sent: 0 });
  });

  it("nothing to buy today: nothing sent", async () => {
    w.material_lists = [];
    const counts = await run();
    expect(sent.calls).toEqual([]);
    expect(counts).toMatchObject({ nothing: 1, sent: 0, failed: 0 });
  });

  it("a lost read sends nothing and files cron-materials-today with the company", async () => {
    w.material_lists = { error: { message: "timeout" } };
    let counts = await run();
    expect(sent.calls).toEqual([]);
    expect(counts.failed).toBe(1);
    expect(sink.reportError).toHaveBeenCalledWith("cron-materials-today", expect.anything(), { orgId: ORG });

    w = world();
    w.notifications = { error: { message: "timeout" } };
    counts = await run();
    expect(sent.calls).toEqual([]);
    expect(counts.failed).toBe(1);

    w = world();
    w.profiles = { error: { message: "timeout" } };
    counts = await run();
    expect(sent.calls).toEqual([]);
    expect(counts.failed).toBe(1);
  });

  it("only the companies at their 8 AM; another company is handed its own jobs and its own office", async () => {
    orgs.rows = [
      { id: ORG, settings: { timezone: TZ } },
      { id: OTHER, settings: { timezone: TZ } },
    ];
    await run([OTHER]);
    expect(sent.calls).toHaveLength(1);
    const [org, to, , words] = sent.calls[0];
    expect(org).toBe(OTHER);
    expect(to).toEqual(["other-owner"]);
    expect(words("en").body).toBe("Otherco · J-113 (4), Othersegment · J-114 (4)");
  });
});
