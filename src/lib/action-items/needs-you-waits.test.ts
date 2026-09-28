import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AFFORDANCES, type ActionItem } from "./types";
import { WAITABLE_KINDS, foldWaitingRows, isMissingWaitsTable, readNeedsYouWaits, saveNeedsYouWait, waitKey } from "./needs-you-waits";

/**
 * ENDLESS ROWS GET A SNOOZE (Erik, 2026-09-27; 0367 needs_you_waits): a row with no day of its own
 * and no honest ending picks a day, waits in the fold with it, and comes back on it. The code ships
 * before 0367 runs: then no Snooze door and no error anywhere.
 */
const TODAY = "2026-09-27";
const item = (o: Partial<Omit<ActionItem, "stream">>): Omit<ActionItem, "stream"> => ({
  id: "materials-j1",
  kind: "materials_needed",
  title: "Rhodesia Panel · J-034",
  when: null,
  urgency: 1,
  done: false,
  href: "/jobs/j1?tab=materials",
  affordances: ["snooze", "open"],
  waitKey: waitKey("materials_needed", "j1"),
  ...o,
});

/** A pretend client: records what it was asked, answers what it is told. */
function fake(answers: { select?: { data?: unknown; error?: unknown }; upsert?: { data?: unknown; error?: unknown } } = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const chain = (op: string, answer: { data?: unknown; error?: unknown } | undefined) => {
    const q: any = {
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: answer?.data ?? null, error: answer?.error ?? null }).then(res, rej),
    };
    for (const m of ["select", "eq", "gt", "lt", "limit", "delete", "upsert"]) {
      q[m] = (...args: unknown[]) => {
        calls.push({ op: `${op}.${m}`, args });
        return q;
      };
    }
    return q;
  };
  return {
    calls,
    from: (table: string) => ({
      select: (...a: unknown[]) => (calls.push({ op: `${table}.select`, args: a }), chain("select", answers.select)).select(...a),
      upsert: (...a: unknown[]) => (calls.push({ op: `${table}.upsert`, args: a }), chain("upsert", answers.upsert)),
      delete: () => chain("delete", { data: [], error: null }),
    }),
  };
}

describe("the key", () => {
  it("is the row's kind and its record, for the endless kinds only", () => {
    expect(waitKey("materials_needed", "j1")).toBe("materials_needed:j1");
    expect(WAITABLE_KINDS).toEqual(["job_unbilled_work", "materials_needed"]);
    // Money and legal clocks are never snoozed this way: they aren't endless, they have endings.
    for (const k of ["invoice_overdue", "lien_deadline", "contract_unsigned", "time_stray", "visit_unbilled"]) expect(WAITABLE_KINDS as readonly string[]).not.toContain(k);
    expect(AFFORDANCES.job_unbilled_work).toEqual(["open"]);
    expect(AFFORDANCES.materials_needed).toEqual(["open"]);
  });
});

describe("the fold", () => {
  it("a row whose key has a later day waits in the fold with its day and reason; the rest stay on Now", () => {
    const a = item({});
    const b = item({ id: "materials-j2", waitKey: waitKey("materials_needed", "j2") });
    const waits = new Map([[a.waitKey!, { until: "2026-10-03", reason: "Breaker back-ordered" }]]);
    const out = foldWaitingRows([a, b], waits);
    expect(out.now.map((i) => i.id)).toEqual([b.id]);
    expect(out.waiting).toEqual([{ id: a.id, kind: "materials_needed", title: a.title, why: "Breaker back-ordered", backOn: "2026-10-03", href: a.href }]);
    // No reason given: it still says why it's there.
    expect(foldWaitingRows([a], new Map([[a.waitKey!, { until: "2026-10-03", reason: null }]])).waiting[0].why).toBe("Snoozed");
  });

  it("a row with no key never folds, and a wait whose day is bad never hides its row", () => {
    const plain = item({ waitKey: null });
    expect(foldWaitingRows([plain], new Map([["materials_needed:j1", { until: "2026-10-03", reason: null }]])).now).toHaveLength(1);
    const a = item({});
    expect(foldWaitingRows([a], new Map([[a.waitKey!, { until: "someday", reason: null }]])).now).toHaveLength(1);
  });
});

describe("the read", () => {
  it("asks for this company's waits whose day is after today", async () => {
    const db = fake({ select: { data: [{ item_key: "materials_needed:j1", until: "2026-10-03", reason: " Back-ordered " }] } });
    const r = await readNeedsYouWaits(db, "org-1", TODAY);
    expect(r.ready).toBe(true);
    expect(r.waits.get("materials_needed:j1")).toEqual({ until: "2026-10-03", reason: "Back-ordered" });
    expect(db.calls).toContainEqual({ op: "select.eq", args: ["org_id", "org-1"] });
    expect(db.calls).toContainEqual({ op: "select.gt", args: ["until", TODAY] });
  });

  it("before 0367 (no table) or on a failed read: not ready, nothing folds, no error", async () => {
    expect(isMissingWaitsTable({ code: "42P01" })).toBe(true);
    expect(isMissingWaitsTable({ code: "PGRST205", message: "Could not find the table 'public.needs_you_waits' in the schema cache" })).toBe(true);
    expect(isMissingWaitsTable({ code: "42501" })).toBe(false);
    const missing = await readNeedsYouWaits(fake({ select: { error: { code: "42P01" } } }), "org-1", TODAY);
    expect(missing).toEqual({ ready: false, waits: new Map() });
    expect(await readNeedsYouWaits(fake(), null, TODAY)).toEqual({ ready: false, waits: new Map() });
  });
});

describe("the save", () => {
  it("one row per key, the day today or later, org-filtered, and a zero-row write is said", async () => {
    const ok = fake({ upsert: { data: [{ id: "w1" }] } });
    expect(await saveNeedsYouWait(ok, { orgId: "org-1", userId: "u1", key: "materials_needed:j1", date: "2026-10-03", reason: " Back-ordered ", todayStr: TODAY })).toEqual({ ok: true });
    const up = ok.calls.find((c) => c.op === "needs_you_waits.upsert")!;
    expect(up.args[0]).toMatchObject({ org_id: "org-1", item_key: "materials_needed:j1", until: "2026-10-03", reason: "Back-ordered", created_by: "u1" });
    expect(up.args[1]).toEqual({ onConflict: "org_id,item_key" });
    expect(await saveNeedsYouWait(ok, { orgId: "org-1", userId: "u1", key: "k", date: "2026-09-20", todayStr: TODAY })).toEqual({ ok: false, error: "Pick today or later" });
    expect((await saveNeedsYouWait(fake({ upsert: { data: [] } }), { orgId: "org-1", userId: "u1", key: "k", date: "2026-10-03", todayStr: TODAY })).ok).toBe(false);
  });

  it("before 0367 the save says it needs one database update, and changes nothing", async () => {
    const r = await saveNeedsYouWait(fake({ upsert: { error: { code: "42P01" } } }), { orgId: "org-1", userId: "u1", key: "k", date: "2026-10-03", todayStr: TODAY });
    expect(r).toEqual({ ok: false, error: "Snooze needs one database update before it can hold a day. Nothing was changed." });
  });
});

describe("the build", () => {
  const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
  it("offers the Snooze only when the table is there, and folds before the sort", () => {
    expect(query).toContain('affordances: waitsR.ready ? ["snooze", "open"] : AFFORDANCES.job_unbilled_work');
    expect(query).toContain('affordances: waitsR.ready ? ["snooze", "open"] : AFFORDANCES.materials_needed');
    expect(query.indexOf("const folded = foldWaitingRows(items, waitsR.waits);")).toBeLessThan(query.indexOf("const sorted = sortActionItems("));
  });
});
