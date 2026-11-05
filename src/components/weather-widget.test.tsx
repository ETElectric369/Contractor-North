import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FOLLOW_KEY, WeatherRow, kmBetween, shouldRefetch, weatherFollower, type WeatherGeo } from "./weather-widget";

vi.mock("@/app/report-client-error", () => ({ reportClientError: vi.fn() }));

/**
 * THE WEATHER FOLLOWS THE PHONE (2026-11-04, "stuck on home"). The follower is the widget's whole
 * decision; a fake geo module stands in for the phone. Stand-in places only.
 */

const LARKSPUR = { lat: 39.33, lng: -120.18 };
const SNOWBELL_SHOP = { lat: 39.8, lng: -120.0 };
// ~6 km north of Larkspur.
const SIX_KM_ON = { lat: LARKSPUR.lat + 6 / 111, lng: LARKSPUR.lng };
const ONE_KM_ON = { lat: LARKSPUR.lat + 1 / 111, lng: LARKSPUR.lng };

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

function fakeGeo(o: { may: boolean; perm?: "granted" | "denied" | "prompt" | "unknown"; at?: { lat: number; lng: number } }) {
  let resume: (() => void) | null = null;
  const state = { at: o.at ?? LARKSPUR };
  const g = {
    mayReadLocation: vi.fn(async () => o.may),
    geoPermission: vi.fn(async () => o.perm ?? (o.may ? "granted" : "prompt")),
    getPosition: vi.fn(async () => ({ status: "ok" as const, coords: state.at, accuracy: 20, ts: Date.now() })),
    lastFix: vi.fn(() => null),
    onResume: vi.fn((fn: () => void) => {
      resume = fn;
      return () => {
        resume = null;
      };
    }),
  };
  return { g: g as unknown as WeatherGeo & typeof g, state, resume: () => resume?.() };
}

function follower(geo: WeatherGeo, inShell = true) {
  const fetchFor = vi.fn(async () => true);
  const places: { device: boolean; coords: { lat: number; lng: number } }[] = [];
  const denied: boolean[] = [];
  const f = weatherFollower({
    geo,
    source: "device",
    fetchFor,
    shopCoords: async () => SNOWBELL_SHOP,
    onPlace: (p) => places.push(p),
    onDenied: (d) => denied.push(d),
    onFail: () => {},
    inShell: () => inShell,
    standalone: () => false,
  });
  return { f, fetchFor, places, denied };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("weatherFollower", () => {
  it("shell + the phone allows → reads the phone and follows it", async () => {
    const { g } = fakeGeo({ may: true });
    const { f, fetchFor, places } = follower(g);
    f.start();
    await flush();
    expect(g.getPosition).toHaveBeenCalledTimes(1);
    expect(fetchFor).toHaveBeenCalledWith(LARKSPUR);
    expect(places.at(-1)).toEqual({ device: true, coords: LARKSPUR });
  });

  it("shell + not allowed → never reads; the shop's weather", async () => {
    const { g } = fakeGeo({ may: false, perm: "prompt" });
    store.set(FOLLOW_KEY, "true"); // a kept tap never opens the shell's gate: the phone's answer decides
    const { f, fetchFor, places } = follower(g);
    f.start();
    await flush();
    expect(g.getPosition).not.toHaveBeenCalled();
    expect(fetchFor).toHaveBeenCalledWith(SNOWBELL_SHOP);
    expect(places.at(-1)?.device).toBe(false);
  });

  it("a resume runs it again", async () => {
    const geo = fakeGeo({ may: true });
    const { f } = follower(geo.g);
    f.start();
    await flush();
    geo.resume();
    await flush();
    expect(geo.g.mayReadLocation).toHaveBeenCalledTimes(2);
    expect(geo.g.getPosition).toHaveBeenCalledTimes(2);
  });

  it("moved 6 km → fetched again; moved 1 km → the reading stands", async () => {
    const geo = fakeGeo({ may: true });
    const { f, fetchFor } = follower(geo.g);
    f.start();
    await flush();
    geo.state.at = ONE_KM_ON;
    geo.resume();
    await flush();
    expect(fetchFor).toHaveBeenCalledTimes(1);
    geo.state.at = SIX_KM_ON;
    geo.resume();
    await flush();
    expect(fetchFor).toHaveBeenCalledTimes(2);
    expect(fetchFor).toHaveBeenLastCalledWith(SIX_KM_ON);
  });

  it("a Turn On Location tap that works is kept: the next open (Safari, a standing grant) follows without a tap", async () => {
    const first = fakeGeo({ may: false, perm: "prompt" });
    const a = follower(first.g, false);
    a.f.start();
    await flush();
    expect(first.g.getPosition).not.toHaveBeenCalled();
    expect(await a.f.locate()).toBe("ok");
    expect(store.get(FOLLOW_KEY)).toBe("true");
    const next = fakeGeo({ may: false, perm: "granted" });
    const b = follower(next.g, false);
    b.f.start();
    await flush();
    expect(next.g.getPosition).toHaveBeenCalledTimes(1);
    expect(b.places.at(-1)?.device).toBe(true);
  });

  it("an 'Allow Once' (back at prompt) never asks unasked: the shop, and the tap beside it", async () => {
    store.set(FOLLOW_KEY, "true");
    const geo = fakeGeo({ may: false, perm: "prompt" });
    const { f, fetchFor, places } = follower(geo.g, false);
    f.start();
    await flush();
    expect(geo.g.getPosition).not.toHaveBeenCalled();
    expect(fetchFor).toHaveBeenCalledWith(SNOWBELL_SHOP);
    expect(places.at(-1)?.device).toBe(false);
    expect(store.get(FOLLOW_KEY)).toBe("true"); // the tap is still kept for a later standing grant
  });

  it("a denial clears the kept tap (the read refused)", async () => {
    store.set(FOLLOW_KEY, "true");
    const geo = fakeGeo({ may: false, perm: "granted" });
    geo.g.getPosition.mockResolvedValueOnce({ status: "denied" } as never);
    const { f, denied } = follower(geo.g, false);
    f.start();
    await flush();
    expect(denied).toContain(true);
    expect(store.has(FOLLOW_KEY)).toBe(false);
  });

  it("a denial clears the kept tap (the browser says denied)", async () => {
    store.set(FOLLOW_KEY, "true");
    const geo = fakeGeo({ may: false, perm: "denied" });
    const { f, denied } = follower(geo.g, false);
    f.start();
    await flush();
    expect(geo.g.getPosition).not.toHaveBeenCalled();
    expect(denied).toContain(true);
    expect(store.has(FOLLOW_KEY)).toBe(false);
  });
});

describe("the rules", () => {
  it("kmBetween and shouldRefetch: > 5 km, 30 minutes, or the other kind of place", () => {
    expect(kmBetween(LARKSPUR, SIX_KM_ON)).toBeGreaterThan(5.5);
    const prev = { ...LARKSPUR, at: 0, device: true };
    expect(shouldRefetch(null, LARKSPUR, true, 0)).toBe(true);
    expect(shouldRefetch(prev, ONE_KM_ON, true, 60_000)).toBe(false);
    expect(shouldRefetch(prev, SIX_KM_ON, true, 60_000)).toBe(true);
    expect(shouldRefetch(prev, LARKSPUR, true, 31 * 60_000)).toBe(true);
    expect(shouldRefetch(prev, LARKSPUR, false, 60_000)).toBe(true);
  });
});

describe("the compact row says which place it shows", () => {
  const data = { tempF: 41, feelsF: 38, description: "Cloudy", iconUri: "" };
  const base = { data, status: "ok" as const, source: "device" as const, denied: false, hint: false, onLocate: () => {}, onToggleHint: () => {} };
  it("on the shop's weather: one line with the tap", () => {
    const html = renderToStaticMarkup(<WeatherRow {...base} usingDevice={false} town={null} label="Snowbell" />);
    expect(html).toContain("Weather for Snowbell —");
    expect(html).toContain("Turn On Location</button>");
    expect(html).toContain("to follow you.");
  });
  it("following the phone: the town, and no shop line", () => {
    const html = renderToStaticMarkup(<WeatherRow {...base} usingDevice town="Bayberry" label="Snowbell" />);
    expect(html).toContain("Bayberry");
    expect(html).not.toContain("Weather for");
  });
});
