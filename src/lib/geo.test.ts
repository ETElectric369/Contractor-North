import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ONE POSITION SOURCE (2026-11-04, "the weather is stuck on home"; "it still asked after Always
 * Allow"). Inside a shell whose GeofencePlugin declares currentPosition, the phone answers both the
 * read and the permission; an older shell and Safari keep the WebView with the cn-v1124 gate. One
 * cache (gps:last, ≤ 10 min, never across a resume) and one resume signal.
 */

const shell = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => shell.on }));

type Fake = { arm: () => void; status: ReturnType<typeof vi.fn>; currentPosition: ReturnType<typeof vi.fn> };
let fake: Fake;
let store: Map<string, string>;
let webGet: ReturnType<typeof vi.fn>;
let webWatch: ReturnType<typeof vi.fn>;
let webClear: ReturnType<typeof vi.fn>;
let permState: string;
let docListeners: Record<string, (() => void)[]>;
let visibility = "visible";

function withHeaders(methods: string[]) {
  (globalThis as any).window.Capacitor = {
    Plugins: { Geofence: fake },
    PluginHeaders: [{ name: "Geofence", methods: methods.map((name) => ({ name, rtype: "promise" })) }],
  };
}

beforeEach(() => {
  vi.resetModules();
  shell.on = true;
  store = new Map();
  docListeners = {};
  permState = "prompt";
  fake = {
    arm: () => {},
    status: vi.fn(async () => ({ authorization: "always", armed: null, monitorable: true })),
    currentPosition: vi.fn(async () => ({ latitude: 39.3, longitude: -120.2, accuracy: 15, timestamp: Date.now() })),
  };
  webGet = vi.fn((ok: (p: unknown) => void) => ok({ coords: { latitude: 1, longitude: 2, accuracy: 30 } }));
  webWatch = vi.fn(() => 7);
  webClear = vi.fn();
  visibility = "visible";
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("navigator", {
    userAgent: "test",
    geolocation: { getCurrentPosition: webGet, watchPosition: webWatch, clearWatch: webClear },
    permissions: { query: async () => ({ state: permState }) },
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (ev: string, fn: () => void) => (docListeners[ev] ??= []).push(fn),
  });
  withHeaders(["arm", "disarm", "readPendingExit", "status", "currentPosition"]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const load = () => import("@/lib/geo");

describe("routing: the phone reads in a shell that offers currentPosition", () => {
  it("shell + method declared → the native read, never the WebView", async () => {
    const g = await load();
    expect(g.hasNativeRead()).toBe(true);
    const r = await g.getPosition();
    expect(r).toMatchObject({ status: "ok", coords: { lat: 39.3, lng: -120.2 }, accuracy: 15 });
    expect(fake.currentPosition).toHaveBeenCalledTimes(1);
    expect(webGet).not.toHaveBeenCalled();
  });
  it("an older shell (the method not declared — the proxy answers any name) → the WebView", async () => {
    withHeaders(["arm", "disarm", "readPendingExit", "status"]);
    const g = await load();
    expect(g.hasNativeRead()).toBe(false);
    expect((await g.getPosition()).status).toBe("ok");
    expect(fake.currentPosition).not.toHaveBeenCalled();
    expect(webGet).toHaveBeenCalledTimes(1);
  });
  it("Safari (off the shell) → the WebView", async () => {
    shell.on = false;
    const g = await load();
    expect(g.hasNativeRead()).toBe(false);
    await g.getPosition();
    expect(webGet).toHaveBeenCalledTimes(1);
  });
  it("native rejections: denied and timeout are said; not-determined hands the tap to the WebView", async () => {
    const g = await load();
    fake.currentPosition.mockRejectedValueOnce({ code: "denied", message: "denied" });
    expect((await g.getPosition()).status).toBe("denied");
    fake.currentPosition.mockRejectedValueOnce({ code: "timeout", message: "timeout" });
    expect((await g.getPosition()).status).toBe("timeout");
    expect(webGet).not.toHaveBeenCalled();
    fake.currentPosition.mockRejectedValueOnce({ code: "not-determined", message: "not-determined" });
    expect((await g.getPosition()).status).toBe("ok");
    expect(webGet).toHaveBeenCalledTimes(1);
  });
  it("the caller's accuracy rides to the phone (2026-11-16): only an explicit enableHighAccuracy false is coarse", async () => {
    const g = await load();
    await g.getPosition({ enableHighAccuracy: false, timeout: 10_000, maximumAge: 30 * 60 * 1000 }); // the weather's own options
    expect(fake.currentPosition).toHaveBeenLastCalledWith({ timeout: 10_000, highAccuracy: false });
    await g.getPosition({ enableHighAccuracy: true, timeout: 4_000, maximumAge: 30_000 });
    expect(fake.currentPosition).toHaveBeenLastCalledWith({ timeout: 10_000, highAccuracy: true });
    await g.getPosition();
    expect(fake.currentPosition).toHaveBeenLastCalledWith({ timeout: 10_000, highAccuracy: true });
    await g.getPosition({});
    expect(fake.currentPosition).toHaveBeenLastCalledWith({ timeout: 10_000, highAccuracy: true });
    expect(fake.currentPosition).toHaveBeenCalledTimes(4);
    expect(webGet).not.toHaveBeenCalled();
  });
});

describe("permission: from the phone in the shell, never from the WebView", () => {
  it("Always / While Using → granted; denied/restricted → denied; not determined → prompt", async () => {
    permState = "prompt"; // what the WebView says there, however the phone is set
    const g = await load();
    expect(await g.geoPermission()).toBe("granted");
    fake.status.mockResolvedValueOnce({ authorization: "whenInUse", monitorable: true });
    expect(await g.geoPermission()).toBe("granted");
    fake.status.mockResolvedValueOnce({ authorization: "denied", monitorable: true });
    expect(await g.geoPermission()).toBe("denied");
    fake.status.mockResolvedValueOnce({ authorization: "restricted", monitorable: true });
    expect(await g.geoPermission()).toBe("denied");
    fake.status.mockResolvedValueOnce({ authorization: "notDetermined", monitorable: true });
    expect(await g.geoPermission()).toBe("prompt");
  });
  it("Safari keeps the Permissions API", async () => {
    shell.on = false;
    permState = "granted";
    const g = await load();
    expect(await g.geoPermission()).toBe("granted");
    expect(fake.status).not.toHaveBeenCalled();
  });
  it("native-geofence re-exports the one shellMayReadLocation", async () => {
    const g = await load();
    const n = await import("@/lib/native-geofence");
    expect(n.shellMayReadLocation).toBe(g.shellMayReadLocation);
  });
});

describe("the cn-v327 rule: no read without a tap unless the gate says the phone already allows", () => {
  it("shell, phone allows → the gate opens (the WebView's 'prompt' does not matter)", async () => {
    const g = await load();
    expect(await g.mayReadLocation()).toBe(true);
  });
  it("shell, phone not asked yet → closed", async () => {
    fake.status.mockResolvedValue({ authorization: "notDetermined", monitorable: true });
    const g = await load();
    expect(await g.mayReadLocation()).toBe(false);
  });
  it("shell, denied → closed", async () => {
    fake.status.mockResolvedValue({ authorization: "denied", monitorable: true });
    const g = await load();
    expect(await g.mayReadLocation()).toBe(false);
  });
  it("older shell → the cn-v1124 gate (the phone's answer through status)", async () => {
    withHeaders(["arm", "status"]);
    const g = await load();
    expect(await g.mayReadLocation()).toBe(true);
    fake.status.mockResolvedValueOnce({ authorization: "notDetermined", monitorable: true });
    expect(await g.mayReadLocation()).toBe(false); // null → the web rule, and the WebView says prompt
  });
  it("Safari in 'prompt' → closed; granted → open", async () => {
    shell.on = false;
    const g = await load();
    expect(await g.mayReadLocation()).toBe(false);
    permState = "granted";
    expect(await g.mayReadLocation()).toBe(true);
  });
});

describe("one cache: gps:last, ≤ 10 minutes, never across a resume", () => {
  it("a fix is written as { lat, lng, accuracy, at } and served for 10 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T08:00:00Z"));
    const g = await load();
    await g.getPosition();
    expect(JSON.parse(store.get("gps:last")!)).toMatchObject({ lat: 39.3, lng: -120.2, accuracy: 15 });
    expect(g.lastFix()).toEqual({ lat: 39.3, lng: -120.2 });
    vi.setSystemTime(new Date("2026-11-04T08:09:00Z"));
    expect(g.lastFix()).not.toBeNull();
    vi.setSystemTime(new Date("2026-11-04T08:11:00Z"));
    expect(g.lastFix()).toBeNull();
    expect(g.LAST_FIX_MAX_MS).toBe(10 * 60 * 1000);
  });
  it("cn-v1208: a fix that is not a position is never kept as the shared last fix; the read itself answers as before", async () => {
    const g = await load();
    const bads = [
      { latitude: 39.3, longitude: -120.2, accuracy: -1 },
      { latitude: 39.3, longitude: -120.2, accuracy: Number.NaN },
      { latitude: Number.NaN, longitude: -120.2, accuracy: 15 },
      { latitude: 39.3, longitude: Number.POSITIVE_INFINITY, accuracy: 15 },
    ];
    for (const [i, bad] of bads.entries()) {
      fake.currentPosition.mockResolvedValueOnce({ ...bad, timestamp: Date.now() });
      const r = await g.getPunchPosition();
      expect(r.status, `row ${i}`).toBe("ok"); // what such a fix is worth stays the caller's rule (fixWord, the watch, the fence)
      expect(store.has("gps:last"), `row ${i}`).toBe(false);
      expect(g.lastFix(), `row ${i}`).toBeNull();
    }
    await g.getPosition(); // a real position is kept, as before
    expect(JSON.parse(store.get("gps:last")!)).toMatchObject({ lat: 39.3, lng: -120.2, accuracy: 15 });
    expect(g.notAPosition({ coords: { lat: 39.3, lng: -120.2 }, accuracy: 0 })).toBe(false);
    expect(g.notAPosition({ coords: { lat: 39.3, lng: -120.2 }, accuracy: -1 })).toBe(true);
  });

  it("a fix written before cn-v1142 ({ ts }) still reads; a long-window reader keeps it", async () => {
    store.set("gps:last", JSON.stringify({ lat: 3, lng: 4, ts: Date.now() - 60 * 60_000 }));
    const g = await load();
    expect(g.lastFix()).toBeNull();
    expect(g.lastFix(24 * 3600_000)).toEqual({ lat: 3, lng: 4 });
  });
  it("resume (the page turns visible) invalidates the fix before any subscriber runs", async () => {
    const g = await load();
    await g.getPosition();
    let seen: unknown = "unset";
    const stop = g.onResume(() => {
      seen = g.lastFix();
    });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5_000);
    visibility = "visible";
    for (const fn of docListeners.visibilitychange ?? []) fn();
    expect(seen).toBeNull();
    expect(g.lastFix(24 * 3600_000)).not.toBeNull(); // the address box's day-long bias keeps it
    stop();
  });
  it("Capacitor's appStateChange active is a resume too, and the two together fire once", async () => {
    let appCb: ((s: { isActive: boolean }) => void) | null = null;
    const w = (globalThis as any).window;
    w.Capacitor.Plugins.App = { addListener: vi.fn(async (_ev: string, cb: any) => ((appCb = cb), { remove() {} })) };
    w.Capacitor.PluginHeaders.push({ name: "App", methods: [{ name: "addListener" }] });
    const g = await load();
    const sub = vi.fn();
    g.onResume(sub);
    expect(appCb).not.toBeNull();
    appCb!({ isActive: true });
    for (const fn of docListeners.visibilitychange ?? []) fn();
    expect(sub).toHaveBeenCalledTimes(1);
    appCb!({ isActive: false });
    expect(sub).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE PUNCH'S READ (cn-v1201, "it said it couldnt secure a gps coordinate"). In a shell that reads
 * natively a punch asks the phone for a hundred metres whatever its caller passes (a Best read waited
 * for GPS to settle and ran out the punch's cap); a browser keeps the caller's own options. A fix
 * from the phone's own read carries its age; a WebView fix never does. Positions here are plainly fake.
 */
describe("getPunchPosition: a hundred metres in the shell, the caller's options elsewhere", () => {
  const PUNCH = { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 };
  it("the shell is asked with highAccuracy false whatever the caller passes", async () => {
    fake.currentPosition.mockImplementation(async () => ({ latitude: 0.5, longitude: 1.5, accuracy: 20 }));
    const g = await load();
    for (const o of [PUNCH, { enableHighAccuracy: true }, undefined, {}]) {
      const r = await g.getPunchPosition(o);
      expect(r).toMatchObject({ status: "ok", accuracy: 20 });
      expect(fake.currentPosition).toHaveBeenLastCalledWith({ timeout: 10_000, highAccuracy: false });
    }
    expect(webGet).not.toHaveBeenCalled();
  });
  it("the first call starts synchronously, inside the caller's tap (no await ahead of it)", async () => {
    const g = await load();
    const pending = g.getPunchPosition(PUNCH);
    expect(fake.currentPosition).toHaveBeenCalledTimes(1);
    await pending;
    shell.on = false;
    const pendingWeb = g.getPunchPosition(PUNCH);
    expect(webGet).toHaveBeenCalledTimes(1);
    await pendingWeb;
  });
  it("in a browser and in an older shell, the WebView with the caller's own options, unchanged", async () => {
    shell.on = false;
    const g = await load();
    await g.getPunchPosition(PUNCH);
    expect(webGet.mock.calls[0][2]).toEqual(PUNCH);
    expect(fake.currentPosition).not.toHaveBeenCalled();
    shell.on = true;
    withHeaders(["arm", "status"]);
    await g.getPunchPosition(PUNCH);
    expect(webGet.mock.calls[1][2]).toEqual(PUNCH);
    expect(fake.currentPosition).not.toHaveBeenCalled();
  });
  it("'not asked yet' and an older plugin hand over to the WebView with the caller's options", async () => {
    const g = await load();
    fake.currentPosition.mockRejectedValueOnce({ code: "not-determined", message: "not-determined" });
    expect((await g.getPunchPosition(PUNCH)).status).toBe("ok");
    expect(webGet.mock.calls[0][2]).toEqual(PUNCH);
    fake.currentPosition.mockRejectedValueOnce({ code: "UNIMPLEMENTED", message: "not implemented" });
    expect((await g.getPunchPosition(PUNCH)).status).toBe("ok");
    expect(webGet).toHaveBeenCalledTimes(2);
    fake.currentPosition.mockRejectedValueOnce({ code: "denied", message: "denied" });
    expect((await g.getPunchPosition(PUNCH)).status).toBe("denied");
    fake.currentPosition.mockRejectedValueOnce({ code: "timeout", message: "timeout" });
    expect((await g.getPunchPosition(PUNCH)).status).toBe("timeout");
    expect(webGet).toHaveBeenCalledTimes(2);
  });
  it("a native fix carries its age from CoreLocation's timestamp; absent when there is none", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T16:00:00Z"));
    const now = Date.now();
    const g = await load();
    fake.currentPosition.mockResolvedValueOnce({ latitude: 0.5, longitude: 1.5, accuracy: 20, timestamp: now - 45_000 });
    expect(await g.getPunchPosition(PUNCH)).toMatchObject({ status: "ok", fixAgeMs: 45_000 });
    fake.currentPosition.mockResolvedValueOnce({ latitude: 0.5, longitude: 1.5, accuracy: 20 });
    expect("fixAgeMs" in (await g.getPunchPosition(PUNCH))).toBe(false);
    // getPosition carries it too (an optional field; nothing else in the result changes).
    fake.currentPosition.mockResolvedValueOnce({ latitude: 0.5, longitude: 1.5, accuracy: 20, timestamp: now - 2_000 });
    expect(await g.getPosition()).toMatchObject({ status: "ok", fixAgeMs: 2_000 });
  });
  it("a WebView fix never carries fixAgeMs, whatever position.timestamp holds (the browser enforces maximumAge)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T16:00:00Z"));
    const now = Date.now();
    shell.on = false;
    const g = await load();
    for (const timestamp of [now - 60_000, now - 2_000, now + 90_000, 1, undefined]) {
      webGet.mockImplementationOnce((ok: (p: unknown) => void) => ok({ coords: { latitude: 0.5, longitude: 1.5, accuracy: 30 }, timestamp }));
      const r = await g.getPunchPosition(PUNCH);
      expect(r.status).toBe("ok");
      expect("fixAgeMs" in r).toBe(false);
      webGet.mockImplementationOnce((ok: (p: unknown) => void) => ok({ coords: { latitude: 0.5, longitude: 1.5, accuracy: 30 }, timestamp }));
      expect("fixAgeMs" in (await g.getPosition(PUNCH))).toBe(false);
    }
  });
  it("getPosition itself is unchanged: Best unless the caller says false", async () => {
    const g = await load();
    await g.getPosition(PUNCH);
    expect(fake.currentPosition).toHaveBeenLastCalledWith({ timeout: 10_000, highAccuracy: true });
  });
  it("shellAuthorization names the phone's word, null off the shell or on anything else", async () => {
    const g = await load();
    expect(await g.shellAuthorization()).toBe("always");
    fake.status.mockResolvedValueOnce({ authorization: "somethingElse" });
    expect(await g.shellAuthorization()).toBeNull();
    fake.status.mockRejectedValueOnce(new Error("gone"));
    expect(await g.shellAuthorization()).toBeNull();
    shell.on = false;
    expect(await g.shellAuthorization()).toBeNull();
  });
});

/**
 * THE FENCE'S LIVE WATCH READS THROUGH THE PHONE (cn-v1208, "when it refreshed it asked me to allow my
 * location again"). In a shell that reads natively, watchPosition() is fed by the phone's own
 * hundred-metre read: the first WATCH_FIRST_MS after the call, then one WATCH_EVERY_MS after each read
 * ends, each only while the page is visible, never the WebView; every fix is marked rough, a fix that
 * is not a position is dropped, and a throwing callback is warned in fixed words and never ends the
 * watch. A browser, an older shell, and a shell whose native read is Best only keep the WebView's own
 * watch. Positions here are plainly fake.
 */
describe("watchPosition: the phone feeds it in the shell, the WebView elsewhere", () => {
  const OPTS = { enableHighAccuracy: true, maximumAge: 30_000, timeout: 60_000 }; // the fence's own options
  // Today's shell: the native read AND the 2026-11-16 build's mark (it honors a hundred metres).
  beforeEach(() => withHeaders(["arm", "disarm", "readPendingExit", "status", "currentPosition", "openSettings"]));
  const flush = () => vi.advanceTimersByTimeAsync(0);
  /** The first read is due WATCH_FIRST_MS (2 s) after the call; this runs the clock to it and lets it answer. */
  const first = () => vi.advanceTimersByTimeAsync(2_000);
  const fix = (timestamp?: number) => ({ latitude: 0.5, longitude: 1.5, accuracy: 20, ...(timestamp === undefined ? {} : { timestamp }) });
  const noWeb = () => {
    expect(webWatch).not.toHaveBeenCalled();
    expect(webGet).not.toHaveBeenCalled();
  };

  it("R1/R6: in the shell the phone is read, a cleanup comes back, and the WebView's watch and read are never called", async () => {
    vi.useFakeTimers();
    const g = await load();
    const onFix = vi.fn();
    const onErr = vi.fn();
    const stop = g.watchPosition(onFix, onErr, OPTS);
    expect(typeof stop).toBe("function");
    await first();
    expect(onFix).toHaveBeenCalledWith({ coords: { lat: 39.3, lng: -120.2 }, accuracy: 15, ts: expect.any(Number), rough: true });
    expect(Object.keys(onFix.mock.calls[0][0]).sort()).toEqual(["accuracy", "coords", "rough", "ts"]);
    // errors, a not-asked phone and many intervals later: still never the WebView
    fake.currentPosition.mockRejectedValueOnce({ code: "timeout", message: "timeout" });
    await vi.advanceTimersByTimeAsync(g.WATCH_EVERY_MS * 3);
    fake.currentPosition.mockRejectedValueOnce({ code: "not-determined", message: "not-determined" });
    await vi.advanceTimersByTimeAsync(g.WATCH_EVERY_MS * 3);
    stop();
    expect(onErr).toHaveBeenCalledWith("timeout");
    expect(onErr).toHaveBeenLastCalledWith("unavailable");
    noWeb();
    expect(webClear).not.toHaveBeenCalled();
  });

  it("hasCoarseRead: the native read AND the 2026-11-16 build's mark, never one alone, never off the shell", async () => {
    const g = await load();
    expect(g.hasCoarseRead()).toBe(true);
    withHeaders(["arm", "disarm", "readPendingExit", "status", "currentPosition"]);
    expect(g.hasNativeRead()).toBe(true);
    expect(g.hasCoarseRead()).toBe(false);
    withHeaders(["arm", "status", "openSettings"]);
    expect(g.hasCoarseRead()).toBe(false);
    withHeaders(["arm", "disarm", "readPendingExit", "status", "currentPosition", "openSettings"]);
    shell.on = false;
    expect(g.hasCoarseRead()).toBe(false);
  });

  it("R1: the browser path is untouched — Safari, an older shell, and a shell whose native read is Best only keep the WebView's own watch with the caller's options, and no rough mark", async () => {
    for (const where of ["safari", "older shell", "best-only shell"]) {
      webWatch.mockClear();
      webClear.mockClear();
      fake.currentPosition.mockClear();
      if (where === "safari") shell.on = false;
      else {
        shell.on = true;
        // "best-only": the builds of 2026-11-04 to 11-16 read natively but ignore highAccuracy false.
        withHeaders(where === "older shell" ? ["arm", "status"] : ["arm", "disarm", "readPendingExit", "status", "currentPosition"]);
      }
      const g = await load();
      const onFix = vi.fn();
      const onErr = vi.fn();
      const stop = g.watchPosition(onFix, onErr, OPTS);
      expect(webWatch).toHaveBeenCalledTimes(1);
      expect(webWatch.mock.calls[0][2]).toBe(OPTS);
      const [ok, bad] = webWatch.mock.calls[0] as [(p: unknown) => void, (e: unknown) => void];
      ok({ coords: { latitude: 0.5, longitude: 1.5, accuracy: 30 }, timestamp: 1 });
      expect(onFix).toHaveBeenCalledWith({ coords: { lat: 0.5, lng: 1.5 }, accuracy: 30, ts: expect.any(Number) });
      expect("rough" in onFix.mock.calls[0][0]).toBe(false);
      bad({ code: 1, PERMISSION_DENIED: 1, TIMEOUT: 3 });
      bad({ code: 3, PERMISSION_DENIED: 1, TIMEOUT: 3 });
      bad({ code: 2, PERMISSION_DENIED: 1, TIMEOUT: 3 });
      expect(onErr.mock.calls.map((c) => c[0])).toEqual(["denied", "timeout", "unavailable"]);
      stop();
      expect(webClear).toHaveBeenCalledWith(7);
      expect(fake.currentPosition).not.toHaveBeenCalled();
    }
  });

  it("R2/F3: the first read is due WATCH_FIRST_MS (2 s) after the call, not at once; then WATCH_EVERY_MS (15 s) after the last one ends", async () => {
    vi.useFakeTimers();
    const g = await load();
    expect(g.WATCH_FIRST_MS).toBe(2_000);
    expect(g.WATCH_EVERY_MS).toBe(15_000);
    const onFix = vi.fn();
    const stop = g.watchPosition(onFix, vi.fn(), OPTS);
    expect(fake.currentPosition).not.toHaveBeenCalled(); // not at once: the wake check's sharp read goes first
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fake.currentPosition).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.currentPosition).toHaveBeenCalledTimes(1);
    expect(onFix).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fake.currentPosition).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.currentPosition).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.currentPosition).toHaveBeenCalledTimes(3);
    expect(onFix).toHaveBeenCalledTimes(3);
    stop();
    noWeb();
  });

  it("F3: the first read obeys the hidden rule too — skipped while hidden, asked one interval later", async () => {
    vi.useFakeTimers();
    visibility = "hidden";
    const g = await load();
    const stop = g.watchPosition(vi.fn(), vi.fn(), OPTS);
    await vi.advanceTimersByTimeAsync(2_000 + 15_000 * 3);
    expect(fake.currentPosition).not.toHaveBeenCalled();
    visibility = "visible";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.currentPosition).toHaveBeenCalledTimes(1);
    stop();
  });

  it("R2: reads never overlap — a slow read holds the next one until it ends", async () => {
    vi.useFakeTimers();
    let answer: (v: unknown) => void = () => {};
    fake.currentPosition.mockImplementationOnce(() => new Promise((res) => (answer = res)));
    const g = await load();
    const onFix = vi.fn();
    const stop = g.watchPosition(onFix, vi.fn(), OPTS);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.currentPosition).toHaveBeenCalledTimes(1);
    answer(fix(Date.now()));
    await flush();
    expect(onFix).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fake.currentPosition).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.currentPosition).toHaveBeenCalledTimes(2);
    stop();
  });

  it("R2: hidden skips — a read due while the page is hidden is skipped and asked again one interval later", async () => {
    vi.useFakeTimers();
    const g = await load();
    const stop = g.watchPosition(vi.fn(), vi.fn(), OPTS);
    await first();
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(15_000 * 4);
    expect(fake.currentPosition).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fake.currentPosition).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.currentPosition).toHaveBeenCalledTimes(2);
    stop();
  });

  it("R2: the cleanup stops the timer, and cleanup silences a late answer", async () => {
    vi.useFakeTimers();
    const g = await load();
    const onFix = vi.fn();
    const onErr = vi.fn();
    const before = g.watchPosition(vi.fn(), vi.fn(), OPTS);
    expect(vi.getTimerCount()).toBe(1); // the first read waits on its timer
    before();
    expect(vi.getTimerCount()).toBe(0); // a cleanup before the first read stops it
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.currentPosition).not.toHaveBeenCalled();
    const stop = g.watchPosition(onFix, onErr, OPTS);
    await first();
    expect(vi.getTimerCount()).toBe(1); // the next read waits on its timer
    stop();
    expect(vi.getTimerCount()).toBe(0); // the cleanup stopped it
    await vi.advanceTimersByTimeAsync(15_000 * 4);
    expect(fake.currentPosition).toHaveBeenCalledTimes(1);
    for (const late of [{ ok: fix(Date.now()) }, { err: { code: "denied", message: "denied" } }, { err: { code: "timeout", message: "timeout" } }]) {
      let answer: (v: unknown) => void = () => {};
      let refuse: (e: unknown) => void = () => {};
      fake.currentPosition.mockImplementationOnce(() => new Promise((res, rej) => ((answer = res), (refuse = rej))));
      const f = vi.fn();
      const e = vi.fn();
      const s = g.watchPosition(f, e, OPTS);
      await first(); // the read is out
      s();
      if ("ok" in late) answer(late.ok);
      else refuse(late.err);
      await vi.advanceTimersByTimeAsync(15_000 * 2);
      expect(f).not.toHaveBeenCalled();
      expect(e).not.toHaveBeenCalled();
    }
    expect(onFix).toHaveBeenCalledTimes(1);
    expect(onErr).not.toHaveBeenCalled();
    expect(fake.currentPosition).toHaveBeenCalledTimes(4); // one per watch that reached its first read, none after a cleanup
  });

  it("R3: every read asks the phone for a hundred metres, whatever enableHighAccuracy says", async () => {
    vi.useFakeTimers();
    const g = await load();
    for (const o of [OPTS, { enableHighAccuracy: true }, undefined, { enableHighAccuracy: false }]) {
      fake.currentPosition.mockClear();
      const stop = g.watchPosition(vi.fn(), vi.fn(), o);
      await vi.advanceTimersByTimeAsync(2_000 + 15_000);
      expect(fake.currentPosition).toHaveBeenCalledTimes(2);
      for (const c of fake.currentPosition.mock.calls) expect(c[0]).toEqual({ timeout: 10_000, highAccuracy: false });
      stop();
    }
  });

  it("R4: a stale fix is dropped (older than a finite maximumAge); exactly the limit and no age pass", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T16:00:00Z"));
    const g = await load();
    const onFix = vi.fn();
    const onErr = vi.fn();
    fake.currentPosition
      .mockImplementationOnce(async () => fix(Date.now() - 30_001))
      .mockImplementationOnce(async () => fix(Date.now() - 30_000))
      .mockImplementationOnce(async () => fix());
    const stop = g.watchPosition(onFix, onErr, OPTS);
    await first();
    expect(onFix).not.toHaveBeenCalled();
    expect(onErr).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onFix).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onFix).toHaveBeenCalledTimes(2);
    expect(onErr).not.toHaveBeenCalled();
    stop();
    // no finite maximumAge: an hour-old fix is passed on
    for (const o of [undefined, { maximumAge: Infinity }]) {
      fake.currentPosition.mockImplementationOnce(async () => fix(Date.now() - 3_600_000));
      const f = vi.fn();
      const s = g.watchPosition(f, vi.fn(), o);
      await first();
      expect(f).toHaveBeenCalledTimes(1);
      s();
    }
  });

  it("F2: a fix that is not a position is dropped silently — accuracy negative or not finite, a coordinate not finite — and the watch goes on", async () => {
    vi.useFakeTimers();
    const g = await load();
    const bad = [
      { latitude: 0.5, longitude: 1.5, accuracy: -1 },
      { latitude: 0.5, longitude: 1.5, accuracy: NaN },
      { latitude: 0.5, longitude: 1.5, accuracy: Infinity },
      { latitude: NaN, longitude: 1.5, accuracy: 20 },
      { latitude: 0.5, longitude: Infinity, accuracy: 20 },
    ];
    for (const b of bad) fake.currentPosition.mockImplementationOnce(async () => b);
    fake.currentPosition.mockImplementationOnce(async () => ({ latitude: 0.5, longitude: 1.5, accuracy: 0 })); // zero is a position
    const onFix = vi.fn();
    const onErr = vi.fn();
    const stop = g.watchPosition(onFix, onErr, OPTS);
    await first();
    await vi.advanceTimersByTimeAsync(15_000 * bad.length);
    expect(fake.currentPosition).toHaveBeenCalledTimes(bad.length + 1);
    expect(onErr).not.toHaveBeenCalled();
    expect(onFix.mock.calls).toEqual([[{ coords: { lat: 0.5, lng: 1.5 }, accuracy: 0, ts: expect.any(Number), rough: true }]]);
    stop();
  });

  it("F4: a callback that throws does not end the watch and is warned in fixed words only, never the error", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = await load();
    const onFix = vi.fn(() => {
      throw new Error("a position could be in here");
    });
    const onErr = vi.fn(() => {
      throw new Error("a position could be in here");
    });
    fake.currentPosition.mockImplementationOnce(async () => fix()).mockRejectedValueOnce({ code: "timeout", message: "timeout" });
    const stop = g.watchPosition(onFix, onErr, OPTS);
    await first();
    await vi.advanceTimersByTimeAsync(15_000 * 2);
    expect(onFix).toHaveBeenCalledTimes(2); // the read after the throw came
    expect(onErr).toHaveBeenCalledTimes(1);
    expect(fake.currentPosition).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls).toEqual([["[geo] a live-watch callback threw"], ["[geo] a live-watch callback threw"], ["[geo] a live-watch callback threw"]]);
    stop();
    warn.mockRestore();
  });

  it("R5: denied stops it — said once, and no read after it", async () => {
    vi.useFakeTimers();
    fake.currentPosition.mockRejectedValueOnce({ code: "denied", message: "denied" });
    const g = await load();
    const onErr = vi.fn();
    g.watchPosition(vi.fn(), onErr, OPTS);
    await vi.advanceTimersByTimeAsync(15_000 * 10);
    expect(onErr.mock.calls).toEqual([["denied"]]);
    expect(fake.currentPosition).toHaveBeenCalledTimes(1);
    noWeb();
  });

  it("R5: a timeout and an unavailable read are said and the watch goes on", async () => {
    vi.useFakeTimers();
    fake.currentPosition
      .mockRejectedValueOnce({ code: "timeout", message: "timeout" })
      .mockImplementationOnce(async () => ({})) // no position: unavailable
      .mockRejectedValueOnce(new Error("something else"));
    const g = await load();
    const onFix = vi.fn();
    const onErr = vi.fn();
    const stop = g.watchPosition(onFix, onErr, OPTS);
    await vi.advanceTimersByTimeAsync(2_000 + 15_000 * 3);
    expect(onErr.mock.calls.map((c) => c[0])).toEqual(["timeout", "unavailable", "unavailable"]);
    expect(fake.currentPosition).toHaveBeenCalledTimes(4);
    expect(onFix).toHaveBeenCalledTimes(1);
    stop();
    noWeb();
  });

  it("R5: a phone not asked yet, or a plugin without the method → 'unavailable' once and STOP, never the WebView", async () => {
    vi.useFakeTimers();
    const g = await load();
    for (const code of ["not-determined", "UNIMPLEMENTED"]) {
      fake.currentPosition.mockClear();
      fake.currentPosition.mockRejectedValueOnce({ code, message: code });
      const onErr = vi.fn();
      g.watchPosition(vi.fn(), onErr, OPTS);
      await vi.advanceTimersByTimeAsync(15_000 * 10);
      expect(onErr.mock.calls).toEqual([["unavailable"]]);
      expect(fake.currentPosition).toHaveBeenCalledTimes(1);
    }
    noWeb();
  });
});
