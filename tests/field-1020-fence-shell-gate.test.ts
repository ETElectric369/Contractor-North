import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * THE SHELL'S OWN ANSWER (2026-10-20 01:15, Erik's phone, build 35 + cn-v1123). "Clock me in on 85
 * Larkspur" through Nort: the punch landed, the page re-read, the fence mounted — and in five minutes
 * of screen-on it never asked the phone for a fix, so the punch kept gps_in null and nothing armed.
 * The gate: geoPermission() answers the WebView's Permissions API, which inside the app says "prompt"
 * even after location was allowed, and the web rule never reads off-gesture in "prompt" (the
 * installed PWA silently denies such a prompt). The shell holds location permission itself — the
 * native fence reads it — so inside the shell the phone's own answer decides, and the web keeps its
 * rule. The fence now says in the console what it did (trace lines, shell only).
 */

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const shell = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => shell.on }));

type G = { Capacitor?: { Plugins?: { Geofence?: unknown } } };
const w = () => globalThis as unknown as { window?: G };
let hadWindow = false;
let fake: { status: ReturnType<typeof vi.fn>; arm: () => void };

beforeEach(() => {
  shell.on = true;
  hadWindow = typeof w().window !== "undefined";
  if (!hadWindow) w().window = {};
  fake = { status: vi.fn(async () => ({ authorization: "always", armed: null, monitorable: true })), arm: () => {} };
  (w().window as G).Capacitor = { Plugins: { Geofence: fake } };
});
afterEach(() => {
  if (!hadWindow) delete w().window;
  else delete (w().window as G).Capacitor;
});

describe("shellMayReadLocation: the phone's own answer inside the app", () => {
  it("Always or While Using → the fence may read silently", async () => {
    const { shellMayReadLocation } = await import("@/lib/native-geofence");
    expect(await shellMayReadLocation()).toBe(true);
    fake.status.mockResolvedValueOnce({ authorization: "whenInUse", armed: null, monitorable: true });
    expect(await shellMayReadLocation()).toBe(true);
  });
  it("denied, or regions unavailable → no", async () => {
    const { shellMayReadLocation } = await import("@/lib/native-geofence");
    fake.status.mockResolvedValueOnce({ authorization: "denied", armed: null, monitorable: true });
    expect(await shellMayReadLocation()).toBe(false);
    fake.status.mockResolvedValueOnce({ authorization: "always", armed: null, monitorable: false });
    expect(await shellMayReadLocation()).toBe(false);
  });
  it("not answered yet → null, so the caller falls back to the web rule and still does not read", async () => {
    const { shellMayReadLocation } = await import("@/lib/native-geofence");
    fake.status.mockResolvedValueOnce({ authorization: "notDetermined", armed: null, monitorable: true });
    expect(await shellMayReadLocation()).toBeNull();
  });
  it("off the shell → null: the web keeps geo.ts's rule", async () => {
    shell.on = false;
    const { shellMayReadLocation } = await import("@/lib/native-geofence");
    expect(await shellMayReadLocation()).toBeNull();
  });
});

describe("the monitor's two reads go through one gate, and the fence says what it did", () => {
  const m = src("src/components/geofence-monitor.tsx");
  it("one gate: the shell's answer first, then the web rule", () => {
    expect(m).toContain('return (await shellMayReadLocation()) ?? ((await geoPermission()) === "granted");');
    expect(m).not.toContain('if ((await geoPermission()) !== "granted") {');
    expect((m.match(/await mayReadLocation\(\)/g) ?? []).length).toBe(2); // the wake check + the live watch
  });
  it("trace lines for the check, the fix, the adoption, the closed window and the watch", () => {
    for (const t of ['trace("fence check"', 'trace("fence fix"', 'trace("fence adopt"', 'trace("fence window closed")', 'trace("fence watch", "armed")']) {
      expect(m).toContain(t);
    }
  });
});
