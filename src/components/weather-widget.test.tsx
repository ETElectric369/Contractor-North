import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "@/components/lang-provider";
import { FOLLOW_KEY, WeatherCard, WeatherRow, kmBetween, shouldRefetch, weatherFollower, type WeatherGeo } from "./weather-widget";
import { dict } from "@/lib/i18n";
import { esTitleCase, titleCaseIn } from "../../tests/title-case-words";

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
  const noAnswer: boolean[] = [];
  const f = weatherFollower({
    geo,
    source: "device",
    fetchFor,
    shopCoords: async () => SNOWBELL_SHOP,
    onPlace: (p) => places.push(p),
    onDenied: (d) => denied.push(d),
    onNoAnswer: (n) => noAnswer.push(n),
    onFail: () => {},
    inShell: () => inShell,
    standalone: () => false,
  });
  return { f, fetchFor, places, denied, noAnswer };
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
  it("the town is on its own line under the figures, not inline with them", () => {
    const html = renderToStaticMarkup(<WeatherRow {...base} usingDevice town="Bayberry" label="Snowbell" />);
    const line = html.match(/<div[^>]*data-weather-town[^>]*>.*?<\/div>/)?.[0] ?? "";
    expect(line).toContain("Bayberry");
    expect(line).toContain("text-[11px]");
    expect(html.indexOf("data-weather-town")).toBeGreaterThan(html.indexOf("41°F"));
    // the inline row (the first flex row) no longer holds the town
    const inlineRow = html.slice(0, html.indexOf("data-weather-town"));
    expect(inlineRow.match(/Bayberry/g) ?? []).toHaveLength(0);
  });
  it("no town: the bare pin stays inline", () => {
    const html = renderToStaticMarkup(<WeatherRow {...base} usingDevice town={null} label="Snowbell" />);
    expect(html).not.toContain("data-weather-town");
    expect(html).toContain('aria-label="Your location"');
  });
  it("the Spanish render carries no English word", () => {
    const shop = renderToStaticMarkup(<LangProvider lang="es"><WeatherRow {...base} usingDevice={false} town={null} label="Snowbell" /></LangProvider>);
    expect(shop).toContain("Clima de Snowbell —");
    expect(shop).toContain("Activar Ubicación");
    const near = renderToStaticMarkup(<LangProvider lang="es"><WeatherRow {...base} usingDevice town="Bayberry" label="Snowbell" /></LangProvider>);
    const bare = renderToStaticMarkup(<LangProvider lang="es"><WeatherRow {...base} usingDevice town={null} label="Snowbell" /></LangProvider>);
    for (const html of [shop, near, bare]) {
      expect(html).not.toMatch(/Weather for|Turn On Location|to follow you|Following your location|Your location|unavailable/);
    }
    expect(near).toContain("Siguiendo tu ubicación");
    expect(bare).toContain("Tu ubicación");
  });
});

/**
 * A READ WITH NO ANSWER IS NOT LOCATION OFF (2026-11-16: "Location is acting up again, not turning
 * on"). The shell answers "timeout" only with location allowed; the row must not then say Turn On
 * Location as if it were off, and the tap must say it is reading. Stand-in places only.
 */
describe("a read the phone did not answer", () => {
  it("keeps the phone's place already on screen: nothing changes, the shop is not fetched", async () => {
    const geo = fakeGeo({ may: true });
    const { f, fetchFor, places, noAnswer } = follower(geo.g);
    f.start();
    await flush();
    expect(places.at(-1)).toEqual({ device: true, coords: LARKSPUR });
    geo.g.getPosition.mockResolvedValueOnce({ status: "timeout" } as never);
    geo.resume();
    await flush();
    expect(geo.g.getPosition).toHaveBeenCalledTimes(2);
    expect(fetchFor).toHaveBeenCalledTimes(1);
    expect(fetchFor).not.toHaveBeenCalledWith(SNOWBELL_SHOP);
    expect(places).toHaveLength(1);
    expect(noAnswer).not.toContain(true);
  });

  it("a kept place whose reading is too old fetches its weather again, once, for the same place; a failed refetch keeps the screen", async () => {
    let clock = 1_000_000;
    const geo = fakeGeo({ may: true });
    const fetchFor = vi.fn(async () => true);
    const places: { device: boolean }[] = [];
    const noAnswer: boolean[] = [];
    const f = weatherFollower({
      geo: geo.g, source: "device", fetchFor, shopCoords: async () => SNOWBELL_SHOP,
      onPlace: (p) => places.push(p), onDenied: () => {}, onNoAnswer: (n) => noAnswer.push(n), onFail: () => {},
      inShell: () => true, standalone: () => false, now: () => clock,
    });
    f.start();
    await flush();
    expect(fetchFor).toHaveBeenCalledTimes(1);
    // Fresh reading, no answer: nothing fetched.
    geo.g.getPosition.mockResolvedValueOnce({ status: "timeout" } as never);
    clock += 60_000;
    geo.resume();
    await flush();
    expect(fetchFor).toHaveBeenCalledTimes(1);
    // Stale reading, no answer: the same place's weather, fetched once.
    geo.g.getPosition.mockResolvedValueOnce({ status: "timeout" } as never);
    clock += 31 * 60_000;
    geo.resume();
    await flush();
    expect(fetchFor).toHaveBeenCalledTimes(2);
    expect(fetchFor).toHaveBeenLastCalledWith({ lat: LARKSPUR.lat, lng: LARKSPUR.lng });
    expect(places.every((p) => p.device)).toBe(true);
    // Stale again and the refetch fails: the screen stays, no shop, no no-answer.
    fetchFor.mockResolvedValueOnce(false);
    geo.g.getPosition.mockResolvedValueOnce({ status: "unavailable" } as never);
    clock += 31 * 60_000;
    geo.resume();
    await flush();
    expect(fetchFor).toHaveBeenCalledTimes(3);
    expect(fetchFor).not.toHaveBeenCalledWith(SNOWBELL_SHOP);
    expect(places.every((p) => p.device)).toBe(true);
    expect(noAnswer).not.toContain(true);
  });

  it("a gate that closes without a denial clears a standing no-answer (Ask Next Time, an Allow Once that lapsed)", async () => {
    let may = true;
    const geo = fakeGeo({ may: true });
    geo.g.mayReadLocation.mockImplementation(async () => may);
    geo.g.geoPermission.mockImplementation(async () => (may ? "granted" : "prompt"));
    geo.g.getPosition.mockResolvedValueOnce({ status: "timeout" } as never);
    const { f, denied, noAnswer } = follower(geo.g);
    f.start();
    await flush();
    expect(noAnswer).toEqual([true]);
    may = false;
    geo.resume();
    await flush();
    expect(geo.g.getPosition).toHaveBeenCalledTimes(1);
    expect(noAnswer).toEqual([true, false]);
    expect(denied).not.toContain(true);
  });

  it("with no place of the phone's shown yet: the shop, and onNoAnswer(true) (timeout and unavailable alike)", async () => {
    for (const status of ["timeout", "unavailable"] as const) {
      const geo = fakeGeo({ may: true });
      geo.g.getPosition.mockResolvedValueOnce({ status } as never);
      const { f, fetchFor, places, denied, noAnswer } = follower(geo.g);
      f.start();
      await flush();
      expect(fetchFor).toHaveBeenCalledWith(SNOWBELL_SHOP);
      expect(places.at(-1)?.device).toBe(false);
      expect(noAnswer).toEqual([true]);
      expect(denied).not.toContain(true);
    }
  });

  it("a later ok read clears it and follows the phone", async () => {
    const geo = fakeGeo({ may: true });
    geo.g.getPosition.mockResolvedValueOnce({ status: "timeout" } as never);
    const { f, places, noAnswer } = follower(geo.g);
    f.start();
    await flush();
    geo.resume();
    await flush();
    expect(noAnswer).toEqual([true, false]);
    expect(places.at(-1)).toEqual({ device: true, coords: LARKSPUR });
  });

  it("a denial is still a denial, and clears the no-answer", async () => {
    const geo = fakeGeo({ may: true });
    geo.g.getPosition.mockResolvedValueOnce({ status: "timeout" } as never).mockResolvedValueOnce({ status: "denied" } as never);
    const { f, denied, noAnswer } = follower(geo.g);
    f.start();
    await flush();
    geo.resume();
    await flush();
    expect(denied.at(-1)).toBe(true);
    expect(noAnswer.at(-1)).toBe(false);
  });

  it("the tap: 'failed' sets it, a later ok clears it, a denial clears it", async () => {
    const geo = fakeGeo({ may: false, perm: "prompt" });
    const { f, noAnswer } = follower(geo.g);
    f.start();
    await flush();
    expect(noAnswer).toEqual([false]); // the gate is closed: no read ran, nothing to say
    geo.g.getPosition.mockResolvedValueOnce({ status: "timeout" } as never);
    expect(await f.locate()).toBe("failed");
    expect(noAnswer).toEqual([false, true]);
    expect(await f.locate()).toBe("ok");
    expect(noAnswer).toEqual([false, true, false]);
    geo.g.getPosition.mockResolvedValueOnce({ status: "denied" } as never);
    expect(await f.locate()).toBe("denied");
    expect(noAnswer).toEqual([false, true, false, false]);
  });

  it("one read at a time: a second tap while the first is out joins it, never a second read", async () => {
    const geo = fakeGeo({ may: false, perm: "prompt" });
    let answer: (v: unknown) => void = () => {};
    geo.g.getPosition.mockImplementationOnce(() => new Promise((r) => (answer = r)) as never);
    const { f } = follower(geo.g);
    const a = f.locate();
    const b = f.locate();
    expect(geo.g.getPosition).toHaveBeenCalledTimes(1);
    answer({ status: "timeout" });
    expect(await a).toBe("failed");
    expect(await b).toBe("failed");
    // Once it settled, the next tap reads again.
    await f.locate();
    expect(geo.g.getPosition).toHaveBeenCalledTimes(2);
  });
});

describe("the row's words in each state, both languages", () => {
  const data = { tempF: 41, feelsF: 38, description: "Cloudy", iconUri: "" };
  const base = { data, status: "ok" as const, source: "device" as const, usingDevice: false, town: null, label: "Snowbell", denied: false, hint: false, onLocate: () => {}, onToggleHint: () => {} };
  const row = (lang: "en" | "es", over: Partial<Parameters<typeof WeatherRow>[0]> = {}) =>
    renderToStaticMarkup(<LangProvider lang={lang}><WeatherRow {...base} {...over} /></LangProvider>);
  const card = (lang: "en" | "es", over: Partial<Parameters<typeof WeatherCard>[0]> = {}) =>
    renderToStaticMarkup(<LangProvider lang={lang}><WeatherCard {...base} {...over} /></LangProvider>);

  it("no location: the sentence says so in words true on any device, and the tap is Try Again", () => {
    const en = row("en", { noAnswer: true });
    expect(en).toContain("Weather for Snowbell. Couldn&#x27;t get your location just now.");
    expect(en).toMatch(/Try Again<\/button>/);
    expect(en).not.toContain("Turn On Location");
    expect(en).not.toContain("to follow you");
    const es = row("es", { noAnswer: true });
    expect(es).toContain("Clima de Snowbell. No se pudo obtener tu ubicación por ahora.");
    expect(es).toMatch(/Intentar de Nuevo<\/button>/);
    expect(es).not.toMatch(/Weather for|Try Again|Couldn/);
    // The card: the same sentence and the same door.
    expect(card("en", { noAnswer: true })).toContain("Snowbell · Couldn&#x27;t get your location just now. ");
    expect(card("en", { noAnswer: true })).toMatch(/Try Again<\/button>/);
    expect(card("es", { noAnswer: true })).toContain("No se pudo obtener tu ubicación por ahora.");
    expect(card("es", { noAnswer: true })).toMatch(/Intentar de Nuevo<\/button>/);
  });

  it("busy: the tap is disabled and says Finding You…, in the row and the card", () => {
    for (const html of [row("en", { busy: true }), card("en", { busy: true }), row("en", { busy: true, noAnswer: true })]) {
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Finding You…<\/button>/);
      expect(html).not.toContain("Turn On Location</button>");
    }
    for (const html of [row("es", { busy: true }), card("es", { busy: true })]) {
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Buscándote…<\/button>/);
    }
    expect(row("en")).not.toContain('disabled=""');
  });

  it("denied is unchanged: Turn On Location opens the hint, never Try Again", () => {
    const html = row("en", { denied: true, noAnswer: true });
    expect(html).toContain("Weather for Snowbell —");
    expect(html).toContain("Turn On Location</button>");
    expect(html).not.toContain("Try Again");
    expect(card("en", { denied: true, noAnswer: true })).toContain("Location Blocked</button>");
  });

  it("Open Settings is beside the denied hint only when the shell has the door", () => {
    const open = { denied: true, hint: true, onOpenSettings: () => {} };
    expect(row("en", { ...open, canOpenSettings: true })).toMatch(/Open Settings<\/button>/);
    expect(card("en", { ...open, canOpenSettings: true })).toMatch(/Open Settings<\/button>/);
    expect(row("es", { ...open, canOpenSettings: true })).toMatch(/Abrir Configuración<\/button>/);
    expect(card("es", { ...open, canOpenSettings: true })).toMatch(/Abrir Configuración<\/button>/);
    for (const html of [row("en", open), card("en", open), row("en", { ...open, canOpenSettings: true, hint: false })]) {
      expect(html).not.toContain("Open Settings");
    }
    // Not on a line that is not a denial.
    expect(row("en", { canOpenSettings: true, onOpenSettings: () => {}, noAnswer: true })).not.toContain("Open Settings");
  });

  it("the new words: every key in both languages, the doors Title Case", () => {
    const en = dict("en");
    const es = dict("es");
    for (const k of ["sh_wx_forPlace", "sh_wx_noAnswer", "sh_btn_findingYou", "sh_btn_openSettings", "sh_tryAgain"]) {
      expect(en[k], k).toBeTruthy();
      expect(es[k], k).toBeTruthy();
      expect(es[k]).not.toBe(en[k]);
    }
    for (const k of ["sh_btn_findingYou", "sh_btn_openSettings", "sh_tryAgain"]) {
      expect(titleCaseIn(en[k].replace(/…/g, ""), "en"), en[k]).toBe(true);
      expect(esTitleCase(es[k].replace(/…/g, "")), es[k]).toBe(true);
    }
    // The iPhone's Settings app, as the catalogs already name it in Spanish (sh_phonePathShell, gf_).
    expect(es.sh_phonePathShell.startsWith("Configuración")).toBe(true);
    expect(es.sh_btn_openSettings).toBe("Abrir Configuración");
    // One word for the iPhone's Settings app in Spanish: the denied hint says it too (it said Ajustes).
    expect(es.sh_wx_denied).toContain("— Configuración → North → Ubicación");
    expect(es.sh_wx_denied).not.toContain("Ajustes");
  });
});

describe("native-geofence: the Open Settings door", () => {
  const withShell = (methods: string[], openSettings?: () => Promise<unknown>) => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 CNShell/1 (iOS)" });
    vi.stubGlobal("window", {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => "ios",
        Plugins: { Geofence: { arm: async () => ({}), openSettings } },
        PluginHeaders: [{ name: "Geofence", methods: methods.map((name) => ({ name })) }],
      },
    });
  };
  it("is there only when the shell published openSettings; the call says whether it opened, never throws", async () => {
    const { canOpenLocationSettings, openLocationSettings } = await import("@/lib/native-geofence");
    vi.stubGlobal("window", undefined);
    expect(canOpenLocationSettings()).toBe(false);
    expect(await openLocationSettings()).toBe(false);
    const open = vi.fn(async () => ({ ok: true }));
    withShell(["arm", "status", "currentPosition"], open);
    expect(canOpenLocationSettings()).toBe(false); // an older shell: the proxy answers any name, the headers do not
    expect(await openLocationSettings()).toBe(false);
    expect(open).not.toHaveBeenCalled();
    withShell(["arm", "status", "currentPosition", "openSettings"], open);
    expect(canOpenLocationSettings()).toBe(true);
    expect(await openLocationSettings()).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    withShell(["openSettings"], async () => {
      throw { code: "unavailable" };
    });
    expect(await openLocationSettings()).toBe(false);
  });
});
