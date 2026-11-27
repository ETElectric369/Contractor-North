import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE PUNCH'S LOCATION (cn-v1201). The owner, 2026-11-26: "the gps isnt working right on the phone,
 * i was at the job today when i clocked in and it said it couldnt secure a gps coordinate".
 *
 * Pinned here: the server keeps a clock-in's position by the same rule as switch job and the late
 * stamp (R4); no punch door and neither of the fence's two reads calls getPosition, and each door
 * keeps its cap (R2, R3); the trace row's payload holds codes and counts only (R5); and what the
 * person reads after a clock-in with no position (R6). Positions are plainly fake.
 */
const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client), createServiceClient: vi.fn(() => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn(), recordAppError: vi.fn(async () => null) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => undefined), notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => undefined), orgStaffIds: vi.fn(async () => []) }));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import { adoptGeofenceAnchor, clockIn } from "./actions";
import { ADOPT_AFTER_CLOCK_IN_MS, PHONE_ANCHOR_MAX_M, SERVER_FIX_MAX_M, keepsFix } from "./adopt-window";
import { bucketMetres, newPunchTally, punchTracePayload, punchTraceTitle, roundSeconds, tallyCheck } from "@/lib/punch-trace";
import { reportClientError } from "@/app/report-client-error";
import { recordAppError } from "@/lib/observe";
import { dict, fillText } from "@/lib/i18n";
import { titleCaseOffender } from "../../../../tests/title-case-words";

const ROOT = join(__dirname, "../../../..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

type Q = { table: string; verb: string; cols: string; payload?: any };
function fakeSupabase(route: (q: Q) => { data?: any; error?: any } | undefined, calls: Q[]) {
  const answer = (q: Q) => {
    const r = route(q);
    if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb} [${q.cols}]`);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc(fn: string) {
      const q: Q = { table: `rpc:${fn}`, verb: "rpc", cols: "" };
      calls.push(q);
      return Promise.resolve(answer(q));
    },
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "" };
      calls.push(q);
      const chain: any = {
        select(cols?: string) { if (q.verb === "select") q.cols = cols ?? ""; return chain; },
        insert(p: any) { q.verb = "insert"; q.payload = p; return chain; },
        update(p: any) { q.verb = "update"; q.payload = p; return chain; },
        delete() { q.verb = "delete"; return chain; },
        single() { return Promise.resolve(answer(q)); },
        maybeSingle() { return Promise.resolve(answer(q)); },
        then(resolve: any, reject: any) { try { resolve(answer(q)); } catch (e) { reject?.(e); } },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "order", "limit", "contains"]) chain[m] = () => chain;
      return chain;
    },
  };
}

const JOB = "d0000000-0000-4000-8000-00000000000d";
let calls: Q[] = [];
function liveClient() {
  return fakeSupabase((q) => {
    if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
    if (q.table === "profiles") return { data: { role: "tech" } };
    if (q.table === "jobs" && q.verb === "select" && q.cols === "id") return { data: { id: JOB } };
    if (q.table === "jobs" && q.verb === "select") return { data: { org_id: "org-1" } };
    if (q.table === "jobs" && q.verb === "update") return { data: [] };
    if (q.table === "time_entries" && q.verb === "insert") return { data: null };
  }, calls);
}
const inserted = () => calls.find((c) => c.table === "time_entries" && c.verb === "insert")!.payload;

beforeEach(() => {
  calls = [];
});

describe("R4 · the server keeps a clock-in's position by the one rule", () => {
  it("at the 200 m limit it is kept, and the punch is an app punch", async () => {
    state.client = liveClient();
    const gps = { lat: 0.5, lng: 1.5, accuracy: SERVER_FIX_MAX_M };
    expect(await clockIn({ job_id: JOB, job_code: null, gps })).toEqual({ ok: true });
    expect(inserted().gps_in).toEqual(gps);
    expect(inserted().source).toBe("app");
  });
  it("with unknown accuracy it is kept", async () => {
    state.client = liveClient();
    const gps = { lat: 0.5, lng: 1.5 };
    expect(await clockIn({ job_id: JOB, job_code: null, gps })).toEqual({ ok: true });
    expect(inserted().gps_in).toEqual(gps);
    expect(inserted().source).toBe("app");
  });
  it("one metre past it: no position is stored, the source is as for no position, and the punch is never refused", async () => {
    state.client = liveClient();
    expect(await clockIn({ job_id: JOB, job_code: null, gps: { lat: 0.5, lng: 1.5, accuracy: SERVER_FIX_MAX_M + 1 } })).toEqual({ ok: true });
    expect(inserted().gps_in).toBeNull();
    expect(inserted().source).toBe("manual");
  });
  it("the late stamp refuses past the same constant", async () => {
    state.client = liveClient();
    const r = await adoptGeofenceAnchor("e0000000-0000-4000-8000-00000000000e", { lat: 0.5, lng: 1.5, accuracy: SERVER_FIX_MAX_M + 1 });
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.table === "time_entries")).toBe(false);
  });
  it("keepsFix is the one rule; clockIn, switch job and the late stamp read the constant, and no literal 200 is left", () => {
    expect(SERVER_FIX_MAX_M).toBe(200);
    expect(PHONE_ANCHOR_MAX_M).toBe(150);
    expect(keepsFix({ lat: 0.5, lng: 1.5, accuracy: 200 })).toBe(true);
    expect(keepsFix({ lat: 0.5, lng: 1.5, accuracy: 201 })).toBe(false);
    expect(keepsFix({ lat: 0.5, lng: 1.5 })).toBe(true);
    expect(keepsFix({ lat: Number.NaN, lng: 1.5 })).toBe(false);
    expect(keepsFix(null)).toBe(false);
    const actions = src("src/app/(app)/timeclock/actions.ts");
    expect(actions).toContain("const keptGps = keepsFix(input.gps) ? input.gps : null;");
    expect(actions).toContain("gps_in: keptGps,");
    expect(actions).toContain('source: offlinePunch ? "offline" : backdated ? "manual" : keptGps ? "app" : "manual",');
    expect(actions).toContain("const usableFix = keepsFix(gps);");
    expect(actions).toContain("if (gps.accuracy != null && gps.accuracy > SERVER_FIX_MAX_M) return { ok: false, error: t(\"cs_fixTooFuzzy\") };");
    expect(actions).not.toMatch(/accuracy\s*[<>]=?\s*200\b/);
  });
});

describe("R2 + R3 · every punch door and both fence reads use the punch's read", () => {
  const doors = {
    panel: "src/app/(app)/timeclock/timeclock-panel.tsx",
    nowCard: "src/app/(app)/planner/now-card.tsx",
    job: "src/app/(app)/jobs/[id]/job-time-button.tsx",
    visit: "src/app/(app)/appointments/[id]/visit-start-card.tsx",
  };
  it("no punch door calls getPosition", () => {
    for (const [name, p] of Object.entries(doors)) {
      expect(src(p), name).not.toMatch(/\bgetPosition\b/);
      expect(src(p), name).toContain('from "@/lib/punch-gps";');
    }
  });
  it("each door keeps its cap", () => {
    const panel = src(doors.panel);
    expect(panel).toContain("const { gps, miss } = await punchGps(2500);"); // in
    expect(panel).toContain("const { gps } = await punchGps(2500);\n        const res = await switchJob({"); // switch
    expect(panel).toContain("const { gps } = await punchGps(3000);"); // out
    const now = src(doors.nowCard);
    expect(now).toContain("const { gps } = await punchGps(2500);");
    expect(now).toContain("const { gps } = await punchGps(3000);");
    for (const p of [doors.job, doors.visit]) expect(src(p)).toContain("return (await punchGps(4_000)).gps;");
  });
  it("no await stands ahead of the punch read in a tap handler", () => {
    const panel = src(doors.panel);
    const inTap = panel.slice(panel.indexOf("function doClockIn() {"), panel.indexOf("await punchGps(2500);"));
    expect(inTap).not.toContain("await ");
    const now = src(doors.nowCard);
    const nowTap = now.slice(now.indexOf("function doClockIn() {"), now.indexOf("await punchGps(2500);"));
    expect(nowTap).not.toContain("await ");
  });
  it("no await stands ahead of the read in the job page's and the visit page's gpsBestEffort", () => {
    for (const p of [doors.job, doors.visit]) {
      const text = src(p);
      const from = text.indexOf("async function gpsBestEffort(");
      const to = text.indexOf("await punchGps(4_000)");
      expect(from, p).toBeGreaterThan(-1);
      expect(to, p).toBeGreaterThan(from);
      expect(text.slice(from + "async function gpsBestEffort(".length, to), p).not.toContain("await ");
    }
  });
  it("the fence's adoption reads with getPunchPosition first and never does worse than before; Turn On Location keeps getPosition", () => {
    const g = src("src/components/geofence-monitor.tsx");
    const check = g.slice(g.indexOf("const check = async () => {"), g.indexOf("checkRef.current = () => void check();"));
    const adopt = check.slice(check.indexOf("const { fromMs, windowMs } = adoptWindow();"), check.indexOf("if (now < snoozedUntil(entryId)) return;"));
    expect(adopt).toContain("const ADOPT_READ: PositionOptions = { enableHighAccuracy: true, timeout: 4_000, maximumAge: 30_000 };");
    expect(adopt.split("await getPunchPosition(").length - 1).toBe(1);
    expect(adopt.indexOf("let r = await getPunchPosition(ADOPT_READ);")).toBeLessThan(adopt.indexOf("r = await getPosition(ADOPT_READ);"));
    // The punch's read is tallied under its own word; when that word is not ok and not denied, ONE
    // sharp read follows at once, tallied sharpOk / sharpMiss, and is adopted only when ITS word is ok.
    expect(adopt).toContain("let word = fixWord(r);");
    expect(adopt).toContain("tallyCheck(tallyRef.current.tally, word, r.status === \"ok\" ? r.accuracy : null);");
    expect(adopt).toMatch(/if \(hasNativeRead\(\) && word !== "ok" && word !== "denied"\) \{\s*if \(cancelled \|\| doneRef\.current\) return;\s*r = await getPosition\(ADOPT_READ\);\s*word = fixWord\(r\);/);
    expect(adopt).toContain('tallyCheck(tallyRef.current.tally, word === "ok" ? "sharpOk" : "sharpMiss", r.status === "ok" ? r.accuracy : null);');
    expect(adopt.split("getPosition(ADOPT_READ)").length - 1).toBe(1);
    // Rough, stale or invalid is never adopted, and the guards stand after the last await before the adopt.
    const guard = 'if (cancelled || doneRef.current || r.status !== "ok" || word !== "ok") return;';
    expect(adopt.indexOf(guard)).toBeGreaterThan(adopt.indexOf("r = await getPosition(ADOPT_READ);"));
    expect(adopt.indexOf(guard)).toBeLessThan(adopt.indexOf("await adoptGeofenceAnchor(entryId, fix);"));
    expect(check).not.toMatch(/>\s*150\b/);
    expect(g).toContain("void getPosition({ enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 }).then((r) => {");
  });
  it("the wake's exit check reads as it did before cn-v1201: getPosition, the same options, no stale line", () => {
    const g = src("src/components/geofence-monitor.tsx");
    const check = g.slice(g.indexOf("const check = async () => {"), g.indexOf("checkRef.current = () => void check();"));
    const exit = check.slice(check.indexOf("if (now < snoozedUntil(entryId)) return;"));
    expect(exit).toMatch(
      /const r = await getPosition\(\{ enableHighAccuracy: true, timeout: 4_000, maximumAge: 30_000 \}\);\s*if \(cancelled \|\| doneRef\.current \|\| phaseRef\.current !== "idle"\) return;\s*if \(r\.status !== "ok"\) return; \/\/ denied\/timeout — nothing honest to conclude\s*const acc = r\.accuracy \?\? 0;/,
    );
    expect(exit).not.toContain("getPunchPosition");
    expect(exit).not.toContain("fixAgeMs");
    expect(g).toContain('import { firePunchLocation, fixWord, lastPunchMiss } from "@/lib/punch-gps";');
    // Its comment is true: in the shell the phone's own timer is 10 s whatever `timeout` says.
    expect(exit).toContain("in the shell the phone's own timer is\n        // 10 s whatever `timeout` says.");
  });
});

describe("R5 · the trace row: codes and counts only", () => {
  const payload = () => {
    const tally = newPunchTally();
    tallyCheck(tally, "timeout");
    tallyCheck(tally, "rough", 1730);
    tallyCheck(tally, "ok", 61);
    tallyCheck(tally, "noRead");
    return punchTracePayload({ outcome: "no-position", tap: "cap", tally, openedMs: 1_000_000, nowMs: 1_000_000 + 912_400, native: true, shell1116: true, auth: "always" });
  };
  it("the payload's keys are exactly the list, and every check word is counted", () => {
    const p = payload();
    expect(Object.keys(p).sort()).toEqual(["auth", "best_m", "checks", "native", "outcome", "seconds", "shell1116", "tap"]);
    expect(p.checks).toEqual({ ok: 1, rough: 1, stale: 0, timeout: 1, unavailable: 0, denied: 0, insecure: 0, noRead: 1, sharpOk: 0, sharpMiss: 0 });
    expect(p).toMatchObject({ outcome: "no-position", tap: "cap", best_m: 100, seconds: 910, native: true, shell1116: true, auth: "always" });
  });
  it("nothing in it could hold a position", () => {
    const text = JSON.stringify(payload());
    expect(text).not.toMatch(/lat|lng|lon|coord|address|label|job|entry|name/i);
    expect(text).not.toContain("0.5");
    expect(text).not.toContain("1.5");
  });
  it("best_m rounds UP to a multiple of 50; seconds round to 5", () => {
    expect(bucketMetres(1)).toBe(50);
    expect(bucketMetres(50)).toBe(50);
    expect(bucketMetres(51)).toBe(100);
    expect(bucketMetres(null)).toBeNull();
    expect(roundSeconds(2_400)).toBe(0);
    expect(roundSeconds(2_600)).toBe(5);
    expect(roundSeconds(-10)).toBe(0);
  });
  it("an unknown word is never passed through", () => {
    const p = punchTracePayload({ outcome: "stamped-late", tap: "somewhere" as never, tally: newPunchTally(), openedMs: 0, nowMs: 5, native: false, shell1116: false, auth: "a place" });
    expect(p.tap).toBeNull();
    expect(p.auth).toBeNull();
    expect(p.best_m).toBeNull();
  });
  it("titles never repeat, and carry no number but the load's and the row's", () => {
    const a = punchTraceTitle("no-position");
    const b = punchTraceTitle("no-position");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^clock-in location no-position \(load [a-z0-9]+, row \d+\)$/);
  });
  it('"geo" is in the closed list: the row lands as client:geo at trace', async () => {
    vi.mocked(recordAppError).mockClear();
    await reportClientError("geo", punchTraceTitle("stamped-late"), { ...payload() }, "trace");
    const [where, , , level] = vi.mocked(recordAppError).mock.calls[0] as unknown as [string, Error, unknown, string];
    expect(where).toBe("client:geo");
    expect(level).toBe("trace");
  });
  it("the follow-up sharp read is its own pair of words, and its accuracy feeds best_m", () => {
    const tally = newPunchTally();
    tallyCheck(tally, "rough", 1730);
    tallyCheck(tally, "sharpOk", 12);
    tallyCheck(tally, "sharpMiss");
    const p = punchTracePayload({ outcome: "stamped-late", tap: null, tally, openedMs: 1, nowMs: 2, native: true, shell1116: true, auth: null });
    expect(p.checks).toMatchObject({ rough: 1, sharpOk: 1, sharpMiss: 1 });
    expect(p.best_m).toBe(50);
  });
  it("the monitor sends at the two moments and nowhere else", () => {
    const g = src("src/components/geofence-monitor.tsx");
    // no-position: where the window is said closed, and where the gate refused after it closed (FX7).
    expect(g.split('leaveTrace("no-position")').length - 1).toBe(2);
    expect(g.split('leaveTrace("stamped-late")').length - 1).toBe(1);
    expect(g).toContain('if (known && !cancelled) {\n        setAnchorLost(true);\n        leaveTrace("no-position");');
    expect(g).toContain('setAnchor(fix); // arms the live watch\n            leaveTrace("stamped-late");');
    expect(g.split("sendPunchTrace(").length - 1).toBe(1);
  });
});

describe("R6 · what the person reads after a clock-in with no position", () => {
  const en = dict("en") as Record<string, string>;
  const es = dict("es") as Record<string, string>;
  const minutes = String(ADOPT_AFTER_CLOCK_IN_MS / 60_000);
  it("the three sentences, in both languages", () => {
    expect(en.tc_locationOffNote).toBe("Clocked in. Location is off for North, so this punch has no location. Turn it on in Settings.");
    expect(es.tc_locationOffNote).toBe("Entrada marcada. La ubicación está apagada para North, así que esta marcación no tiene ubicación. Enciéndela en Configuración.");
    expect(fillText(en.tc_noLocationYet, { minutes })).toBe("Clocked in. No location yet. Keep North open and it keeps trying for 15 minutes.");
    expect(fillText(es.tc_noLocationYet, { minutes })).toBe("Entrada marcada. Aún no hay ubicación. Deja North abierto: seguirá buscándola durante 15 minutos.");
    // Never an order to the person (skeptic #98): North keeps looking, the tech does not keep trying.
    expect(es.tc_noLocationYet).not.toMatch(/sigue intentando/);
    expect(en.tc_locationAdded).toBe("Location added to this punch.");
    expect(es.tc_locationAdded).toBe("Ubicación agregada a esta marcación.");
  });
  it("{minutes} is filled from the window constant, never typed", () => {
    const panel = src("src/app/(app)/timeclock/timeclock-panel.tsx");
    expect(panel).toContain('fillText(t("tc_noLocationYet"), { minutes: String(Math.round(ADOPT_AFTER_CLOCK_IN_MS / 60_000)) })');
    expect(en.tc_noLocationYet).toContain("{minutes}");
    expect(es.tc_noLocationYet).toContain("{minutes}");
  });
  it("the old one-sentence claim is gone from the catalog", () => {
    const cat = src("src/lib/words/timeclock.ts");
    expect(cat).not.toContain("GPS-stamped");
    expect(cat).not.toContain("sello GPS");
    expect(en.tc_gpsNote).toBeUndefined();
    expect(es.tc_gpsNote).toBeUndefined();
  });
  it("by cause: denied is location off, every other miss is still looking", () => {
    const panel = src("src/app/(app)/timeclock/timeclock-panel.tsx");
    expect(panel).toContain('const noteFor = (miss: PunchMiss | null): GpsNote | null => (miss === null ? null : miss === "denied" ? "denied" : "waiting");');
    expect(panel).toContain("if (!gps) setGpsNote(noteFor(miss));");
  });
  it("the Open Settings door is the shell's own, with its existing words, beside the location-off sentence only", () => {
    const panel = src("src/app/(app)/timeclock/timeclock-panel.tsx");
    expect(panel).toContain("useEffect(() => setCanSettings(canOpenLocationSettings()), []);");
    expect(panel).toContain('gpsNote === "denied" && canSettings ? (');
    expect(panel).toContain('onClick={() => void openLocationSettings()}');
    expect(panel).toContain('{t("sh_btn_openSettings")}');
    expect(titleCaseOffender(en.sh_btn_openSettings, "en")).toBeNull();
    expect(titleCaseOffender(es.sh_btn_openSettings, "es")).toBeNull();
  });
  it("the fence moves the note through ONE window event, named once, with detail.outcome", () => {
    const panel = src("src/app/(app)/timeclock/timeclock-panel.tsx");
    const g = src("src/components/geofence-monitor.tsx");
    expect(panel).toContain("const onPunchLocation = (e: Event) => setGpsNote((n) => punchNoteAfter(n, punchLocationOutcome(e)));");
    expect(panel).toContain("window.addEventListener(PUNCH_LOCATION_EVENT, onPunchLocation);");
    expect(panel).toContain("window.removeEventListener(PUNCH_LOCATION_EVENT, onPunchLocation);");
    // added: where the late stamp lands; closed: inside windowClosed (both places that say so); off:
    // where the gate refused a read with no anchor (the check, and the tick once the window closed).
    expect(g).toContain('leaveTrace("stamped-late");\n            // The Time Clock swaps its no-location note for "Location added" (cn-v1201).\n            firePunchLocation("added");');
    expect(g).toContain('setAnchorLost(true);\n        leaveTrace("no-position");\n        firePunchLocation("closed");');
    expect(g.split("firePunchLocation(").length - 1).toBe(3);
    expect(g).toMatch(/const gateRefused = \(\) => \{\s*if \(cancelled \|\| doneRef\.current\) return;\s*firePunchLocation\("off"\);/);
    for (const text of [panel, g]) expect(text).not.toMatch(/"cn:punch-location/);
    expect(src("src/lib/punch-gps.ts")).toContain('export const PUNCH_LOCATION_EVENT = "cn:punch-location";');
  });
  it("the note is cleared when a new clock-in, a switch or a clock-out starts, before the read", () => {
    const panel = src("src/app/(app)/timeclock/timeclock-panel.tsx");
    expect(panel).toContain("setError(null);\n    setGpsNote(null);\n    start(async () => {\n      // PUNCH FIRST.");
    expect(panel).toMatch(/function doSwitchJob\(\) \{\s*if \(!openEntry \|\| !switchJobId\) return;\s*setError\(null\);\s*setGpsNote\(null\);[^\n]*\n\s*startSwitch\(async \(\) => \{/);
    expect(panel).toMatch(/function doClockOut\(at\?: string\) \{\s*if \(!openEntry\) return;\s*setError\(null\);\s*setGpsNote\(null\);[^\n]*\n\s*start\(async \(\) => \{/);
  });
  it("'Location added' is drawn calm, never amber, and never with the Settings door", () => {
    const panel = src("src/app/(app)/timeclock/timeclock-panel.tsx");
    expect(panel).toContain('const gpsNoteTone = gpsNote === "added" ? "text-green-700" : "text-amber-600";');
    expect(panel.split("${gpsNoteTone}").length - 1).toBe(2);
    expect(panel).not.toMatch(/gpsNoteText[\s\S]{0,40}text-amber-600"/);
    expect(panel).toContain('gpsNote === "denied" && canSettings ? (');
  });
  it("the punch helper and the trace carry no words", () => {
    for (const p of ["src/lib/punch-gps.ts", "src/lib/punch-trace.ts"]) {
      expect(src(p)).not.toMatch(/@\/lib\/words|@\/lib\/i18n/);
    }
  });
});
