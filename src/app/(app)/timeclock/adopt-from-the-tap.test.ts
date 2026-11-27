import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE FENCE'S CLOCK-IN WINDOW OPENS AT THE TAP (cn-v1169).
 *
 * The owner, 2026-11-18, started his clock with a start typed eighty-one minutes back; the phone gave
 * no location at the tap. A missing anchor may be adopted from a live fix for fifteen minutes, and
 * the fifteen were counted from the START, so they were over before the entry existed: the fence was
 * off for that clock-in, and the app could only say so. His go the next morning, to the fix as it was
 * put to him: "check it and go for both".
 *
 * Three things are pinned here:
 *   1. the rule (adoptOpensAtMs): the later of the start and the making of the row, except for an
 *      offline punch, whose row is made wherever the phone found a signal again;
 *   2. the server's door (adoptGeofenceAnchor) reads the row's made-at time and source and applies it,
 *      and still refuses a phone opened long after the tap;
 *   3. the monitor reads the same rule from what the layout now hands it, never moves the trip's own
 *      start (which is how it tells a switch), and asks again once a minute while the window is open
 *      (adoptTick), saying so when it closes.
 * Coordinates here are invented and belong to nobody.
 */
const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client), createServiceClient: vi.fn(() => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => {}), notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}), orgStaffIds: vi.fn(async () => []) }));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import { adoptGeofenceAnchor } from "./actions";
import { ADOPT_AFTER_CLOCK_IN_MS, ADOPT_AFTER_SWITCH_MS, adoptOpensAtMs, adoptTick } from "./adopt-window";

const MIN = 60_000;
const T0 = Date.parse("2026-11-18T15:00:00.000Z");

describe("adoptOpensAtMs: where the clock-in window opens", () => {
  it("a live punch: the start and the making of the row are the same moment", () => {
    expect(adoptOpensAtMs({ clockInMs: T0, madeAtMs: T0 + 400, source: "app" })).toBe(T0 + 400);
  });
  it("a start typed 81 minutes back: the window opens at the tap, not at the start", () => {
    expect(adoptOpensAtMs({ clockInMs: T0 - 81 * MIN, madeAtMs: T0, source: "manual" })).toBe(T0);
  });
  it("a tech's start rounded back to the half hour: at the tap", () => {
    expect(adoptOpensAtMs({ clockInMs: T0 - 25 * MIN, madeAtMs: T0, source: "manual" })).toBe(T0);
  });
  it("an offline punch keeps its start, however much later its row was made", () => {
    expect(adoptOpensAtMs({ clockInMs: T0 - 4 * 60 * MIN, madeAtMs: T0, source: "offline" })).toBe(T0 - 4 * 60 * MIN);
  });
  it("a start corrected to LATER than the tap: the start, as it always was", () => {
    expect(adoptOpensAtMs({ clockInMs: T0 + 20 * MIN, madeAtMs: T0, source: "app" })).toBe(T0 + 20 * MIN);
  });
  it("no made-at time (an older caller, a row read without it): the start", () => {
    for (const madeAtMs of [undefined, null, NaN]) expect(adoptOpensAtMs({ clockInMs: T0, madeAtMs, source: null })).toBe(T0);
    expect(adoptOpensAtMs({ clockInMs: T0 })).toBe(T0);
  });
  it("nothing known at all is 0, which every caller reads as no window", () => {
    expect(adoptOpensAtMs({ clockInMs: NaN, madeAtMs: NaN })).toBe(0);
    expect(adoptOpensAtMs({ clockInMs: NaN, madeAtMs: T0, source: "offline" })).toBe(0);
  });
});

describe("adoptTick: the once-a-minute ask while the window is open", () => {
  const base = { fromMs: T0, windowMs: ADOPT_AFTER_CLOCK_IN_MS, throttleMs: MIN };
  it("a minute after the last check, inside the window: ask now and come back in a minute", () => {
    expect(adoptTick({ ...base, nowMs: T0 + 2 * MIN, lastCheckMs: T0 + MIN })).toEqual({ kind: "wait", check: true, againInMs: MIN + 250 });
  });
  it("a wake's check ran 20 seconds ago: do not ask on top of it, come back in a minute", () => {
    expect(adoptTick({ ...base, nowMs: T0 + 2 * MIN, lastCheckMs: T0 + 2 * MIN - 20_000 })).toEqual({ kind: "wait", check: false, againInMs: MIN + 250 });
  });
  it("forty seconds before the window ends: the next tick lands just past the end", () => {
    const t = adoptTick({ ...base, nowMs: T0 + ADOPT_AFTER_CLOCK_IN_MS - 40_000, lastCheckMs: 0 });
    expect(t).toEqual({ kind: "wait", check: true, againInMs: 40_250 });
    // ...and that tick finds it closed.
    expect(adoptTick({ ...base, nowMs: T0 + ADOPT_AFTER_CLOCK_IN_MS + 250, lastCheckMs: T0 })).toEqual({ kind: "closed" });
  });
  it("exactly at the window's end it is still open, as the check itself reads it (closed only once past it)", () => {
    expect(adoptTick({ ...base, nowMs: T0 + ADOPT_AFTER_CLOCK_IN_MS, lastCheckMs: 0 }).kind).toBe("wait");
    expect(adoptTick({ ...base, nowMs: T0 + ADOPT_AFTER_CLOCK_IN_MS + 1, lastCheckMs: 0 }).kind).toBe("closed");
  });
  it("the wider window after a switch is asked through too", () => {
    expect(adoptTick({ ...base, windowMs: ADOPT_AFTER_SWITCH_MS, nowMs: T0 + 30 * MIN, lastCheckMs: 0 }).kind).toBe("wait");
    expect(adoptTick({ ...base, nowMs: T0 + 30 * MIN, lastCheckMs: 0 }).kind).toBe("closed");
  });
  it("nothing known about when the window opened: nothing to wait for", () => {
    expect(adoptTick({ ...base, fromMs: 0, nowMs: T0, lastCheckMs: 0 })).toEqual({ kind: "stop" });
  });
  it("bounded: asked once a minute from the tap, a clock-in's window is at most fifteen asks", () => {
    let now = T0;
    let last = T0; // the mount check
    let asks = 0;
    for (let i = 0; i < 200; i++) {
      const t = adoptTick({ ...base, nowMs: now, lastCheckMs: last });
      if (t.kind !== "wait") break;
      if (t.check) {
        asks++;
        last = now;
      }
      now += t.againInMs;
    }
    expect(asks).toBeGreaterThanOrEqual(13);
    expect(asks).toBeLessThanOrEqual(15);
  });
});

// ── the server's door ────────────────────────────────────────────────────────────────────────────
type Q = { table: string; verb: "select" | "update"; cols: string; payload?: any; filters: any[] };
function fakeSupabase(row: Record<string, unknown> | null, calls: Q[]) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      calls.push(q);
      const answer = () => {
        if (table !== "time_entries") return { data: null, error: null }; // the caller's language: English
        if (q.verb === "update") return { data: [{ id: "e1" }], error: null };
        return { data: row, error: null };
      };
      const chain: any = {
        select(cols?: string) { if (q.verb === "select") q.cols = cols ?? ""; return chain; },
        update(p: any) { q.verb = "update"; q.payload = p; return chain; },
        maybeSingle() { return Promise.resolve(answer()); },
        single() { return Promise.resolve(answer()); },
        then(resolve: any) { resolve(answer()); },
      };
      for (const m of ["eq", "is", "in", "limit", "order"]) chain[m] = (...a: any[]) => { q.filters.push([m, ...a]); return chain; };
      return chain;
    },
  };
}
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString();
const fix = { lat: 10.5, lng: 20.5, accuracy: 20 };
const TOO_LONG = "Too long since clock-in to backfill a location.";
/** The window-is-over refusal: the sentence, and the flag the phone stops asking on. */
const CLOSED = { ok: false, error: TOO_LONG, windowClosed: true };

describe("adoptGeofenceAnchor: the server counts the fifteen minutes from the tap", () => {
  let calls: Q[] = [];
  beforeEach(() => {
    calls = [];
  });
  const entry = (over: Record<string, unknown>) => ({ id: "e1", gps_in: null, notes: null, split_how: null, source: "manual", ...over });
  const run = async (row: Record<string, unknown>) => {
    state.client = fakeSupabase(row, calls);
    return adoptGeofenceAnchor("e1", fix);
  };

  it("the refusal's words are the catalog's", async () => {
    const { dict } = await import("@/lib/i18n");
    expect(dict("en").cs_tooLongToBackfill).toBe(TOO_LONG);
  });

  it("HIS CASE: a start typed 81 minutes back, tapped two minutes ago, adopts", async () => {
    expect(await run(entry({ clock_in: ago(83), created_at: ago(2) }))).toEqual({ ok: true });
    const upd = calls.find((c) => c.verb === "update")!;
    expect(upd.payload.gps_in).toMatchObject({ lat: 10.5, lng: 20.5, accuracy: 20 });
    expect(typeof upd.payload.gps_in.captured_at).toBe("string"); // an anchor taken after the punch says so
    // Still the caller's own open entry with no anchor yet (the silent-write law's predicates).
    expect(upd.filters).toEqual(expect.arrayContaining([["eq", "id", "e1"], ["eq", "profile_id", "user-1"], ["eq", "status", "open"], ["is", "gps_in", null]]));
  });

  it("the same entry twenty minutes after the tap is refused: a phone opened later is still never the job", async () => {
    expect(await run(entry({ clock_in: ago(101), created_at: ago(20) }))).toEqual(CLOSED);
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("a tech's start rounded back 25 minutes, tapped a minute ago, adopts (it was dead on arrival before)", async () => {
    expect(await run(entry({ clock_in: ago(26), created_at: ago(1) }))).toEqual({ ok: true });
  });

  it("an offline punch filed just now for a tap 30 minutes ago is refused: its row's time says nothing of where the tap was", async () => {
    expect(await run(entry({ clock_in: ago(30), created_at: ago(0.2), source: "offline" }))).toEqual(CLOSED);
    // ...and one filed inside its own fifteen minutes still adopts, as before.
    expect(await run(entry({ clock_in: ago(8), created_at: ago(0.2), source: "offline" }))).toEqual({ ok: true });
  });

  it("an ordinary punch is unchanged: ten minutes in adopts, sixteen does not", async () => {
    expect(await run(entry({ clock_in: ago(10), created_at: ago(10), source: "app" }))).toEqual({ ok: true });
    expect(await run(entry({ clock_in: ago(16), created_at: ago(16), source: "app" }))).toEqual(CLOSED);
  });

  it("a row read without a made-at time falls back to the start (nothing widens by accident)", async () => {
    expect(await run(entry({ clock_in: ago(30) }))).toEqual(CLOSED);
    expect(await run(entry({ clock_in: ago(5) }))).toEqual({ ok: true });
  });

  it("a Switch Job's piece keeps its 45 minutes, and the tap rule does not stretch them", async () => {
    expect(await run(entry({ clock_in: ago(30), created_at: ago(30), split_how: "live", source: "app" }))).toEqual({ ok: true });
    expect(await run(entry({ clock_in: ago(50), created_at: ago(50), split_how: "live", source: "app" }))).toEqual(CLOSED);
  });

  it("the read names what it uses (the projection law)", async () => {
    await run(entry({ clock_in: ago(1), created_at: ago(1) }));
    const read = calls.find((c) => c.table === "time_entries" && c.verb === "select")!;
    expect(read.cols).toBe("id, clock_in, created_at, source, gps_in, notes, split_how");
    expect(read.filters).toEqual(expect.arrayContaining([["eq", "id", "e1"], ["eq", "profile_id", "user-1"], ["eq", "status", "open"]]));
  });

  it("an anchor already there is never replaced", async () => {
    expect(await run(entry({ clock_in: ago(83), created_at: ago(2), gps_in: { lat: 1, lng: 2 } }))).toEqual({ ok: false, error: "Anchor already set." });
  });

  it("ONLY the window being over carries the flag the phone stops on: every other refusal can still be asked again", async () => {
    // A fix too fuzzy, coordinates that are not numbers, an anchor already there, a shift that is
    // not open: none of them says the window is over.
    state.client = fakeSupabase(entry({ clock_in: ago(1), created_at: ago(1) }), calls);
    expect((await adoptGeofenceAnchor("e1", { ...fix, accuracy: 900 })).windowClosed).toBeUndefined();
    expect((await adoptGeofenceAnchor("e1", { lat: Number.NaN, lng: 1 } as never)).windowClosed).toBeUndefined();
    expect((await run(entry({ clock_in: ago(1), created_at: ago(1), gps_in: { lat: 1, lng: 2 } }))).windowClosed).toBeUndefined();
    expect((await run(entry({ clock_in: ago(1), created_at: ago(1) }))).windowClosed).toBeUndefined(); // it adopted
    // At the source: one return in the whole file sets it.
    const actions = readFileSync(join(process.cwd(), "src/app/(app)/timeclock/actions.ts"), "utf8");
    expect(actions.split("windowClosed: true").length - 1).toBe(1);
    expect(actions).toContain('return { ok: false, error: t("cs_tooLongToBackfill"), windowClosed: true };');
  });
});

// ── the phone's side: one rule, read from what the layout hands over ───────────────────────────────
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the monitor and the layout (pinned at the source)", () => {
  const monitor = src("src/components/geofence-monitor.tsx");
  const layout = src("src/app/(app)/layout.tsx");
  const actions = src("src/app/(app)/timeclock/actions.ts");

  it("the layout reads the row's made-at time and source and hands both to the monitor", () => {
    expect(layout).toContain('.select("id, gps_in, clock_in, created_at, source, job_id, split_from, split_how, job:job_id(job_number, name)")');
    expect(layout).toContain("madeAtIso={openEntry.created_at ?? null}");
    expect(layout).toContain("source={openEntry.source ?? null}");
  });

  it("the monitor's window is the server's rule, and both the check and the timer read it from one place", () => {
    expect(monitor).toContain('import { adoptOpensAtMs, adoptTick, adoptWindowMs } from "@/app/(app)/timeclock/adopt-window";');
    expect(monitor).toContain("const opensMs = adoptOpensAtMs({ clockInMs: ciMs, madeAtMs: madeAtIso ? Date.parse(madeAtIso) : null, source });");
    expect(monitor).toContain("return { fromMs: Math.max(opensMs, tripStartMsRef.current || 0), windowMs: adoptWindowMs(switched) };");
    expect(monitor.split("adoptWindow()").length - 1).toBe(5); // the check, the tick, the first arming, the trace row and the gate's refusal (cn-v1201)
    expect(actions).toContain("const openedAt = Math.max(opensMs, swMs ?? 0);");
  });

  it("the trip's own start is NOT moved to the tap: a tap later than a typed start must not pass for a switch", () => {
    // Set where it always was: the start at mount, now at a job change. Nothing else writes it.
    expect(monitor).toContain("const tripStartMsRef = useRef(Date.parse(clockInIso) || Date.now());");
    expect(monitor.split("tripStartMsRef.current = ").length - 1).toBe(1);
    expect(monitor).toContain("if (newTrip) tripStartMsRef.current = Date.now();");
    expect(monitor).toContain("const switched = startedBySwitch || (!isNaN(ciMs) && tripStartMsRef.current > ciMs);");
  });

  it("the window closing is said once, by the check or by the timer, through the same gate", () => {
    expect(monitor).toContain("windowClosed(!!fromMs);");
    const tick = monitor.slice(monitor.indexOf("const tick = () => {"), monitor.indexOf("if (typeof anchorLat !== \"number\" || typeof anchorLng !== \"number\") {\n      const w = adoptWindow();"));
    expect(tick).toContain("if (cancelled || doneRef.current || serverClosed) return;");
    // Since cn-v1201 a refusal of the gate there still leaves the trace's row (gateRefused), never the line.
    expect(tick).toContain('if (next.kind === "closed") {\n        void mayReadLocation().then((may) => {\n          if (cancelled || doneRef.current) return;\n          if (may) windowClosed();\n          else gateRefused();');
    expect(tick).toContain("if (next.check) void check();\n      retry = setTimeout(tick, next.againInMs);");
    // The decision is the pure function's; the monitor passes it the throttle the check itself uses.
    expect(tick).toContain("lastCheckMs: lastWakeCheckRef.current, throttleMs: WAKE_THROTTLE_MS");
  });

  it("THE SERVER'S WINDOW IS THE AUTHORITY: its refusal is said at once and nothing asks again", () => {
    // The phone's count can be wider than the server's (a job picked after clock-in reads as a
    // switch here and leaves no breadcrumb there). The flag ends it: said once, then quiet.
    expect(monitor).toContain("let serverClosed = false;");
    expect(monitor.split("serverClosed = true;").length - 1).toBe(1);
    expect(monitor).toContain(
      'const res = await adoptGeofenceAnchor(entryId, fix);\n          trace("fence adopt", res.ok ? "ok" : res.windowClosed ? "window closed" : "refused");\n          if (cancelled) return;\n          if (res.ok) {\n            setAnchor(fix); // arms the live watch',
    );
    expect(monitor).toContain(
      '} else if (res.windowClosed) {\n            serverClosed = true;\n            windowClosed();\n          }',
    );
    // The check stops before it reads anything (no location read, no throttle slot taken)...
    expect(monitor).toContain("const check = async () => {\n      if (cancelled || doneRef.current || serverClosed) return;");
    // ...and the flag lives and dies with the effect: an anchor or a new trip starts clean.
    const effect = monitor.slice(monitor.indexOf("let inFlightStamp = 0;"), monitor.indexOf("}, [tripKey, anchorLat, anchorLng, radiusM, clockInIso, startedBySwitch, madeAtIso, source]);"));
    expect(effect).toContain("let serverClosed = false;");
    expect(monitor).not.toMatch(/serverClosed(Ref)?\.current/);
  });

  it("the timer is armed only while there is no anchor, and never outlives its effect", () => {
    expect(monitor).toContain('if (first.kind === "wait") retry = setTimeout(tick, first.againInMs);');
    expect(monitor).toContain("cancelled = true;\n      if (retry) clearTimeout(retry);");
    expect(monitor).toContain("}, [tripKey, anchorLat, anchorLng, radiusM, clockInIso, startedBySwitch, madeAtIso, source]);");
  });

  it("the comments no longer say My Day and the job page punch with no location: every door asks", () => {
    for (const [name, text] of [["layout", layout], ["actions", actions], ["panel", src("src/app/(app)/timeclock/timeclock-panel.tsx")], ["privacy", src("src/app/north-site/privacy/page.tsx")]] as const) {
      expect(text, name).not.toMatch(/punch(es)? (with|carry) gps:null/);
      expect(text, name).not.toContain("punch\n// instantly with no GPS at all");
    }
    // What they do, at the source: each reads a fix before it punches.
    expect(src("src/app/(app)/planner/now-card.tsx")).toContain("const { gps } = await punchGps(2500);"); // the one punch read since cn-v1201
    expect(src("src/app/(app)/jobs/[id]/job-time-button.tsx")).toContain("const gps = await gpsBestEffort();\n      return clockIn({ job_id: jobId, job_code: null, gps, clock_in_at: startAt || null });");
    expect(src("src/app/(app)/appointments/[id]/visit-start-card.tsx")).toContain("const gps = await gpsBestEffort();");
  });
});
