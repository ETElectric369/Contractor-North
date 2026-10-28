import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE GEOFENCE SPEAKS THE PERSON'S LANGUAGE, INCLUDING THE ALERT COMPILED INTO THE SHELL
 * (cn-v1138, builder T2). The page arms iOS's region with the alert's title and body already in the
 * person's language (fenceArmOptions, the one builder), GeofencePlugin.swift stores them beside the
 * label and posts them on exit with today's English as its only fallback; the idle line, the sheet,
 * the spoken and lock-screen confirmations come through the gf_ catalog; "the job site" is said in
 * the reader's language wherever a job has no label; and the sheet syncs on the server's `ended`
 * rather than on English words. No network from the plugin, as before.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/planner" }));
vi.mock("@/app/(app)/timeclock/actions", () => ({ adoptGeofenceAnchor: vi.fn(), geoClockOut: vi.fn(), notifyGeofenceExit: vi.fn() }));

import { dict, fillText, translator } from "@/lib/i18n";
import { JOB_SITE_LABEL, fenceArmOptions, parsePendingExit } from "@/lib/native-geofence";
import { GeofenceIdleLine } from "@/components/geofence-monitor";
import { LangProvider } from "@/components/lang-provider";
import { codeOnly } from "@/lib/migration-body.test-util";

const en = dict("en");
const es = dict("es");
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("fenceArmOptions: the arm carries the alert's words in the person's language", () => {
  const fence = { entryId: "e1", lat: 39.33, lng: -120.17, radiusM: 150, label: "41 Larkspur", notify: true };
  it("English: today's words, byte for byte what the Swift fallback says", () => {
    const o = fenceArmOptions(fence, translator("en"));
    expect(o).toEqual({ ...fence, title: "Still on the clock?", body: "Looks like you left 41 Larkspur. Open North to clock out or keep going." });
  });
  it("Spanish: the same slots, in Spanish", () => {
    const o = fenceArmOptions(fence, translator("es"));
    expect(o.title).toBe(es.gf_stillOnTheClock);
    expect(o.body).toBe(fillText(es.gf_looksLikeYouLeft, { label: "41 Larkspur" }));
    expect(o.body).toContain("41 Larkspur");
    expect(o).toMatchObject(fence); // the circle is untouched
  });
  it("the label the page hands is what the body names, even the job-site fallback in Spanish", () => {
    const o = fenceArmOptions({ ...fence, label: es.gf_theJobSite }, translator("es"));
    expect(o.body).toBe("Parece que saliste de el sitio de trabajo. Abre North para marcar salida o seguir trabajando.");
  });
});

describe("parsePendingExit: the fallback label is the reader's", () => {
  const raw = { entryId: "t1", exitedAt: "2026-10-14T23:10:00Z", label: "" };
  it("English by default, as before; Spanish when the page says so", () => {
    expect(JOB_SITE_LABEL).toBe("the job site");
    expect(parsePendingExit(raw)!.label).toBe("the job site");
    expect(parsePendingExit(raw, es.gf_theJobSite)!.label).toBe("el sitio de trabajo");
    expect(parsePendingExit({ ...raw, label: "7 Snowbell" }, es.gf_theJobSite)!.label).toBe("7 Snowbell");
  });
});

describe("GeofenceIdleLine: the idle line in the person's language", () => {
  const idle = (lang: "en" | "es", over: Partial<Parameters<typeof GeofenceIdleLine>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(
        LangProvider,
        { lang, children: null },
        createElement(GeofenceIdleLine, { watchOff: false, waitingGrant: false, fenceDark: null, anchorLost: false, anchorKnown: false, jobLabel: "41 Larkspur", onTurnOn: () => {}, ...over }),
      ),
    );
  it("Spanish: the ask, its Title Case door, the dark fence and the lost anchor", () => {
    expect(idle("es", { waitingGrant: true })).toContain("La ubicación todavía no está activada para North, así que no puedo notar cuando salgas de 41 Larkspur.");
    expect(idle("es", { waitingGrant: true })).toMatch(/<button[^>]*>\s*Activar Ubicación<\/button>/);
    expect(idle("es", { watchOff: true })).toContain(es.gf_locationOffForApp);
    expect(idle("es", { fenceDark: "denied" })).toContain(es.gf_locationOffForNorth);
    expect(idle("es", { fenceDark: "whenInUse" })).toContain(es.gf_locationWhileUsing);
    expect(idle("es", { fenceDark: "unavailable" })).toContain(es.gf_phoneCantWatchScreenOff);
    expect(idle("es", { anchorLost: true })).toContain("No pude obtener una ubicación en 41 Larkspur");
    expect(idle("es", { waitingGrant: true })).not.toContain("Turn On Location");
  });
  it("English, and outside a provider: what it said before", () => {
    expect(idle("en", { waitingGrant: true })).toContain("Location isn’t on yet for North, so I can’t notice when you leave 41 Larkspur.");
    expect(idle("en", { waitingGrant: true })).toMatch(/<button[^>]*>\s*Turn On Location<\/button>/);
    expect(idle("en", { fenceDark: "whenInUse" })).toContain("Set it to Always in Settings, under Location Services, North.");
    const bare = renderToStaticMarkup(createElement(GeofenceIdleLine, { watchOff: true, waitingGrant: false, fenceDark: null, anchorLost: false, anchorKnown: false, jobLabel: "x", onTurnOn: () => {} }));
    expect(bare).toContain(en.gf_locationOffForApp);
  });
});

describe("the catalog: Title Case on every door, and the English is the shell's own fallback", () => {
  it("the buttons are Title Case in both languages", () => {
    for (const k of ["gf_turnOnLocation", "gf_finishYourTimecard", "gf_back", "gf_stillWorking", "gf_clockOutNow", "gf_pickTheTime"]) {
      for (const v of [en[k], es[k]]) for (const w of v.replace(/[…→]/g, "").trim().split(/\s+/)) expect(w[0], `${k}: ${v}`).toBe(w[0].toUpperCase());
    }
  });
  it("the Swift fallback is the English catalog, so an old page and a new one post the same alert", () => {
    const swift = read("ios/App/App/GeofencePlugin.swift");
    expect(swift).toContain(`content.title = armed["title"] as? String ?? "${en.gf_stillOnTheClock}"`);
    expect(swift).toContain(`content.body = armed["body"] as? String ?? "${en.gf_looksLikeYouLeft.replace("{label}", '\\(pending["label"] as? String ?? "the job site")')}"`);
  });
});

describe("source pins: the plugin, the bridge and the monitor", () => {
  it("GeofencePlugin.swift: arm takes optional title/body, stores them beside the label, posts them, and still never touches the network", () => {
    const swift = read("ios/App/App/GeofencePlugin.swift");
    expect(swift).toContain("func arm(entryId: String, lat: Double, lng: Double, radiusM: Double, label: String, notify: Bool, title: String? = nil, body: String? = nil) -> Bool {");
    expect(swift).toContain('if let title, !title.isEmpty { armed["title"] = title }');
    expect(swift).toContain('if let body, !body.isEmpty { armed["body"] = body }');
    expect(swift).toContain("UserDefaults.standard.set(armed, forKey: GeofenceCore.armedKey)");
    expect(swift).toContain('let title = call.getString("title")');
    expect(swift).toContain('let body = call.getString("body")');
    expect(swift).toContain("GeofenceCore.shared.arm(entryId: entryId, lat: lat, lng: lng, radiusM: radius, label: label, notify: notify, title: title, body: body)");
    expect(swift).not.toMatch(/URLSession|URLRequest/);
  });
  it("native-geofence.ts: the arm type carries the words, the exit readers take the reader's fallback label", () => {
    const n = read("src/lib/native-geofence.ts");
    expect(n).toContain("export type FenceArmOptions = { entryId: string; lat: number; lng: number; radiusM: number; label: string; notify: boolean; title: string; body: string };");
    expect(n).toContain("arm(o: FenceArmOptions): Promise<{ ok: boolean; authorization: string; monitorable?: boolean }>;");
    expect(n).toContain("export function parsePendingExit(raw: unknown, fallbackLabel: string = JOB_SITE_LABEL): PendingExit | null {");
    expect(n).toContain("export async function takePendingExit(fallbackLabel: string = JOB_SITE_LABEL): Promise<PendingExit | null> {");
    expect(n).toContain("export async function onFenceExit(cb: (p: PendingExit) => void, fallbackLabel: string = JOB_SITE_LABEL): Promise<() => void> {");
  });
  it("geofence-monitor.tsx: reads the language, arms with the words, names the job site in it, and syncs on `ended`", () => {
    const g = read("src/components/geofence-monitor.tsx");
    expect(g).toContain("const lang = useLang();\n  const t = translator(lang);\n  const jobLabel = jobLabelProp ?? t(\"gf_theJobSite\");");
    expect(g).toContain("void armFence(fenceArmOptions({ entryId, lat: anchorLat, lng: anchorLng, radiusM, label: jobLabel, notify }, t)).then(dark);");
    expect(g).toContain('void takePendingExit(t("gf_theJobSite")).then((e) => { if (e) takeExit(e); });');
    expect(g).toContain('void onFenceExit(takeExit, t("gf_theJobSite")).then((s) => { if (cancelled) s(); else stop = s; });');
    expect(g).toContain('if (res.ended || /not clocked in|already ended/i.test(res.error ?? "")) {');
    expect(g).toContain('speakSmart(t("gf_clockedOutYouLeftSpoken"));');
    expect(g).toContain('const n = new Notification(t("gf_clockedOutYouLeftTitle"), {');
    expect(g).toContain('setError(t("gf_noConnectionUntouched"));');
    expect(g).toContain("setError(pickWithinCeiling(lang));");
    expect(g).toContain('{t("tc_clockOutAtThatTime")}');
    expect(g).toContain('{t("tc_clockingOut")}');
    expect(g).toContain('fieldLabel="Stop"'); // ClockStartPicker's typed discriminator, which it names in the language itself
    // The server's push gets the label as given (undefined for a job with none): it says "the job site" per reader.
    expect(g).toContain("exitPushCtxRef.current = { entryId, jobLabel: jobLabelProp };");
    expect(codeOnly(g)).not.toMatch(/"the job site"/);
  });
});
