import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { liveFixDoor, needsSharpProof, type LiveFix } from "@/lib/fence-live";
import type { GeoResult } from "@/lib/geo";

/**
 * ROUGH READS MAY SAY "INSIDE"; ONLY A SHARP READ MAY SAY "OUTSIDE" (cn-v1208, skeptic #103's B1).
 * The phone-fed live watch marks every fix rough; a rough fix that would count as outside is not used
 * at all, and one sharp read decides instead. No coordinates matter here: the distance is handed in.
 */

describe("needsSharpProof: the table", () => {
  const rows: [boolean | undefined, number, number, number, boolean][] = [
    // rough, distance, radius, accuracy → needs a sharp read
    [true, 500, 150, 65, true], // rough and outside the padded radius
    [true, 216, 150, 65, true], // one metre past the padding
    [true, 215, 150, 65, false], // exactly on the padded edge counts as inside
    [true, 100, 150, 65, false], // rough and inside: it may say so
    [true, 0, 150, 0, false],
    [false, 500, 150, 65, false], // a sharp fix decides by itself
    [undefined, 500, 150, 65, false], // no mark (a browser, an older shell): as before
  ];
  for (const [rough, distanceM, radiusM, accuracyM, want] of rows) {
    it(`rough ${String(rough)}, ${distanceM} m from the centre, radius ${radiusM} + ${accuracyM} → ${want}`, () => {
      expect(needsSharpProof({ rough, distanceM, radiusM, accuracyM })).toBe(want);
    });
  }
});

/** A door with fakes. The distance of each fix rides on its own lat, so a test can say "500 m out". */
function setup(o: { alive?: () => boolean; trip?: () => unknown; askSharp?: () => Promise<GeoResult> } = {}) {
  const count = vi.fn();
  let answer: (r: GeoResult) => void = () => {};
  let fail: (e: unknown) => void = () => {};
  const askSharp = vi.fn(o.askSharp ?? (() => new Promise<GeoResult>((res, rej) => ((answer = res), (fail = rej)))));
  const proofOut = { current: false };
  const clock = { ms: 1_000_000 };
  const door = liveFixDoor({
    alive: o.alive ?? (() => true),
    trip: o.trip ?? (() => "trip-a"),
    ignoreAccuracyM: 200,
    radiusM: 150,
    distanceM: (c) => c.lat,
    proofOut,
    askSharp,
    now: () => clock.ms,
    staleMs: 30_000,
    count,
  });
  const at = (m: number, extra: Partial<LiveFix> = {}): LiveFix => ({ coords: { lat: m, lng: 0 }, accuracy: 20, ...extra });
  return { door, count, askSharp, proofOut, clock, at, answer: (r: GeoResult) => answer(r), fail: (e: unknown) => fail(e) };
}
const ok = (m: number, accuracy = 10): GeoResult => ({ status: "ok", coords: { lat: m, lng: 0 }, accuracy, ts: 1 });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("liveFixDoor: the live watch's one door for a fix", () => {
  it("a rough fix that would count as OUTSIDE is not used at all and asks ONE sharp read", () => {
    const s = setup();
    s.door(s.at(500, { rough: true }));
    expect(s.count).not.toHaveBeenCalled();
    expect(s.askSharp).toHaveBeenCalledTimes(1);
    expect(s.proofOut.current).toBe(true);
  });

  it("the sharp read's 'ok' runs through the same door with no mark: outside is counted, inside is counted", async () => {
    for (const m of [500, 30]) {
      const s = setup();
      s.door(s.at(500, { rough: true }));
      s.answer(ok(m));
      await settle();
      expect(s.count.mock.calls).toEqual([[{ coords: { lat: m, lng: 0 }, accuracy: 10 }, m]]);
      expect(s.askSharp).toHaveBeenCalledTimes(1);
      expect(s.proofOut.current).toBe(false);
    }
  });

  it("any other answer: nothing this round, and the next rough outside fix may ask again", async () => {
    for (const r of [{ status: "timeout" }, { status: "unavailable" }, { status: "denied" }] as GeoResult[]) {
      const s = setup();
      s.door(s.at(500, { rough: true }));
      s.answer(r);
      await settle();
      expect(s.count).not.toHaveBeenCalled();
      s.door(s.at(500, { rough: true }));
      expect(s.askSharp).toHaveBeenCalledTimes(2);
    }
  });

  it("one proof at a time: rough outside fixes while one is out ask nothing and count nothing", async () => {
    const s = setup();
    s.door(s.at(500, { rough: true }));
    s.door(s.at(600, { rough: true }));
    s.door(s.at(700, { rough: true }));
    expect(s.askSharp).toHaveBeenCalledTimes(1);
    expect(s.count).not.toHaveBeenCalled();
    s.answer(ok(500));
    await settle();
    expect(s.count).toHaveBeenCalledTimes(1);
  });

  it("a late proof is dropped: the effect disposed, the shift done, or another trip", async () => {
    let alive = true;
    const a = setup({ alive: () => alive });
    a.door(a.at(500, { rough: true }));
    alive = false;
    a.answer(ok(500));
    await settle();
    expect(a.count).not.toHaveBeenCalled();
    expect(a.proofOut.current).toBe(false); // the slot is free again

    let trip = "trip-a";
    const b = setup({ trip: () => trip });
    b.door(b.at(500, { rough: true }));
    trip = "trip-b";
    b.answer(ok(500));
    await settle();
    expect(b.count).not.toHaveBeenCalled();
  });

  it("FRESH OR NOTHING: an answer that lands more than staleMs after it was asked is dropped (the phone slept on it), inside or outside", async () => {
    for (const [waited, counted] of [[30_000, 1], [30_001, 0], [2 * 60 * 60_000, 0]] as const) {
      for (const m of [30, 500]) {
        const s = setup();
        s.door(s.at(500, { rough: true }));
        s.clock.ms += waited;
        s.answer(ok(m));
        await settle();
        expect(s.count, `${waited} ms, ${m} m`).toHaveBeenCalledTimes(counted);
        expect(s.proofOut.current).toBe(false); // dropped or counted, the slot is free again
      }
    }
  });

  it("FRESH OR NOTHING: a fix older than staleMs is dropped whatever it says; exactly the limit, and a fix with no age, are counted", async () => {
    for (const [fixAgeMs, counted] of [[30_001, 0], [3 * 60 * 60_000, 0], [30_000, 1], [undefined, 1]] as const) {
      for (const m of [30, 500]) {
        const s = setup();
        s.door(s.at(500, { rough: true }));
        s.answer(fixAgeMs === undefined ? ok(m) : ({ ...ok(m), fixAgeMs } as GeoResult));
        await settle();
        expect(s.count, `age ${String(fixAgeMs)}, ${m} m`).toHaveBeenCalledTimes(counted);
        expect(s.proofOut.current).toBe(false);
      }
    }
  });

  it("a sharp answer that is not a position is dropped: an accuracy negative or not finite, a coordinate not finite", async () => {
    const bads: GeoResult[] = [
      ok(500, -1),
      ok(500, Number.NaN),
      ok(30, -1),
      { status: "ok", coords: { lat: Number.NaN, lng: 0 }, accuracy: 10, ts: 1 },
      { status: "ok", coords: { lat: 500, lng: Number.POSITIVE_INFINITY }, accuracy: 10, ts: 1 },
    ];
    for (const [i, bad] of bads.entries()) {
      const s = setup();
      s.door(s.at(500, { rough: true }));
      s.answer(bad);
      await settle();
      expect(s.count, `row ${i}`).not.toHaveBeenCalled();
      expect(s.proofOut.current).toBe(false);
    }
  });

  it("the slot is freed whatever happens, and the one warning is fixed words: a read that cannot be asked, one that rejects, a count that throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let tries = 0;
      const a = setup({
        askSharp: () => {
          tries++;
          throw new Error("at 39.3, -120.2");
        },
      });
      expect(() => a.door(a.at(500, { rough: true }))).not.toThrow();
      expect(a.proofOut.current).toBe(false);
      a.door(a.at(500, { rough: true }));
      expect(tries).toBe(2); // the next rough outside fix asks again
      expect(a.count).not.toHaveBeenCalled();

      const b = setup();
      b.door(b.at(500, { rough: true }));
      b.fail(new Error("at 39.3, -120.2"));
      await settle();
      expect(b.proofOut.current).toBe(false);
      expect(b.count).not.toHaveBeenCalled();
      b.door(b.at(500, { rough: true }));
      expect(b.askSharp).toHaveBeenCalledTimes(2);

      const c = setup();
      c.count.mockImplementation(() => {
        throw new Error("at 39.3, -120.2");
      });
      c.door(c.at(500, { rough: true }));
      c.answer(ok(500));
      await settle();
      expect(c.proofOut.current).toBe(false);

      const words = "[geofence] the live watch's sharp read could not be counted";
      expect(warn.mock.calls).toEqual([[words], [words], [words], [words]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("an unmarked fix (a browser, an older shell) behaves exactly as before: outside is counted, no second read", () => {
    const s = setup();
    s.door(s.at(500));
    s.door(s.at(500, { rough: false }));
    expect(s.askSharp).not.toHaveBeenCalled();
    expect(s.count.mock.calls).toEqual([
      [{ coords: { lat: 500, lng: 0 }, accuracy: 20 }, 500],
      [{ coords: { lat: 500, lng: 0 }, accuracy: 20 }, 500],
    ]);
  });

  it("a rough fix that says INSIDE is counted at once", () => {
    const s = setup();
    s.door(s.at(100, { rough: true }));
    expect(s.askSharp).not.toHaveBeenCalled();
    expect(s.count).toHaveBeenCalledWith({ coords: { lat: 100, lng: 0 }, accuracy: 20 }, 100);
  });

  it("as before: a fix rougher than the ignore limit, or one after the shift is done, is dropped before anything", () => {
    const s = setup();
    s.door(s.at(500, { rough: true, accuracy: 201 }));
    s.door(s.at(500, { accuracy: 201 }));
    expect(s.askSharp).not.toHaveBeenCalled();
    expect(s.count).not.toHaveBeenCalled();
    const d = setup({ alive: () => false });
    d.door(d.at(500, { rough: true }));
    d.door(d.at(500));
    expect(d.askSharp).not.toHaveBeenCalled();
    expect(d.count).not.toHaveBeenCalled();
  });
});

describe("the monitor's wiring (geofence-monitor.tsx, LIVE WATCH)", () => {
  const g = readFileSync(path.resolve(__dirname, "../components/geofence-monitor.tsx"), "utf8");
  const live = g.slice(g.indexOf("// ── 2. LIVE WATCH"), g.indexOf("const turnOnLocation"));

  it("the watch's onFix is liveFixDoor, asking the sharp read through getPosition with Best, 10 s, no cache", () => {
    expect(live).toContain("const onFix = liveFixDoor({");
    expect(live).toContain("askSharp: async () =>");
    // The gate stands in front of the sharp read (it is never inside a tap), and a closed gate is "unavailable", never the WebView.
    expect(live).toContain('(await mayReadLocation()) ? getPosition({ enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }) : { status: "unavailable" },');
    expect(live).toContain("now: () => Date.now(),");
    expect(live).toContain("staleMs: STALE_FIX_MS,");
    expect(live.split("getPosition(").length - 1).toBe(1); // the one sharp read; nothing else in the live watch reads
    expect(live).toContain("proofOut: sharpProofOutRef,");
    expect(live).toContain("alive: () => !disposed && !doneRef.current,");
    expect(live).toContain("trip: () => tripKeyRef.current,");
    expect(live).toContain("stop = watchPosition(onFix, onErr, opts);");
  });

  it("every ref the watch writes is written inside count, which only the door calls", () => {
    const door = live.indexOf("const onFix = liveFixDoor({");
    const countAt = live.indexOf("const count = (");
    expect(countAt).toBeGreaterThan(0);
    expect(door).toBeGreaterThan(countAt);
    for (const ref of ["lastFixRef.current =", "lastFixMsRef.current =", "lastInsideMsRef.current =", "seenInsideRef.current =", "firstOutsideMsRef.current ="]) {
      const at = live.indexOf(ref);
      expect(at, ref).toBeGreaterThan(countAt);
      expect(live.lastIndexOf(ref), ref).toBeLessThan(door);
    }
    expect(live.split("count(").length - 1).toBe(0); // the monitor never calls count itself
  });

  it("a gate that says yes clears 'location is off': the line's own Open Settings door must not leave it standing", () => {
    // Before anything else arm() does once the gate passed, and nowhere else: only a yes from the gate clears it.
    expect(live).toContain("setWatchOff(false);\n      setWaitingGrant(false);\n      stop();\n      stop = watchPosition(onFix, onErr, opts);");
    expect(g.split("setWatchOff(false)").length - 1).toBe(1);
    const gate = live.indexOf("if (!(await mayReadLocation())) {");
    expect(gate).toBeGreaterThan(0);
    expect(live.indexOf("setWatchOff(false);")).toBeGreaterThan(live.indexOf("return;", gate));
    // A denial still sets it, from the watch and from the Turn On Location tap.
    expect(g.split("setWatchOff(true)").length - 1).toBe(2);
  });

  it("the wake exit check drops an answer about then: one that lands more than STALE_FIX_MS after it was asked concludes nothing, before anything is stamped", () => {
    // The clock is read on the line before the read is asked, and compared after it answers.
    const from = g.indexOf("const askedMs = Date.now();\n        const r = await getPosition({ enableHighAccuracy: true, timeout: 4_000, maximumAge: 30_000 });");
    expect(from).toBeGreaterThan(0);
    const wake = g.slice(from, g.indexOf('openPrompt("wake");', from));
    const notOk = wake.indexOf('if (r.status !== "ok") return;');
    const stale = wake.indexOf("if (Date.now() - askedMs > STALE_FIX_MS) return;");
    expect(notOk).toBeGreaterThan(0);
    expect(stale).toBeGreaterThan(notOk);
    expect(wake.split("askedMs").length - 1).toBe(2); // set once, read once
    expect(wake).not.toContain("fixAgeMs"); // the fix's own age is not read here (cn-v1201's rule stands)
    for (const stamp of ["lastFixRef.current =", "seenInsideRef.current =", "lastInsideMsRef.current =", "firstOutsideMsRef.current ="]) {
      expect(wake.indexOf(stamp), stamp).toBeGreaterThan(stale);
    }
    expect(g).toContain('import { firePunchLocation, fixWord, lastPunchMiss, STALE_FIX_MS } from "@/lib/punch-gps";');
  });
});
