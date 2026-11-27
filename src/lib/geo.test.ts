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
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("navigator", {
    userAgent: "test",
    geolocation: { getCurrentPosition: webGet },
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
