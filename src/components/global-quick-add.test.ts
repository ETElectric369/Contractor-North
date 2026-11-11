import { beforeEach, describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/planner" }));
vi.mock("@/components/snap-or-note", () => ({ SnapOrNoteProvider: () => null, openSnapOrNote: vi.fn(), snapStillSending: () => 0 }));
// MEASURE FROM THE + (cn-v1160). The phone: the two bridges' presence checks, switched on by the cases
// that need a phone with the plugin (everything else here is a browser, as it always was). The sheet
// and the saves are the sheet's own lane and have their own tests: here the sheet is a mark that says
// it was mounted and what it was handed, and the context is asked through a stand-in.
const phone = vi.hoisted(() => ({ measure: false, scan: false, model: false }));
vi.mock("@/lib/native-measure", async (actual) => ({ ...(await actual<typeof import("@/lib/native-measure")>()), measurePluginPresent: () => phone.measure }));
vi.mock("@/lib/native-scan", async (actual) => ({
  ...(await actual<typeof import("@/lib/native-scan")>()),
  scanPluginPresent: () => phone.scan,
  scanDoors: async () => ({ model: phone.model }),
}));
vi.mock("@/components/quick-measure-sheet", () => ({
  QuickMeasureSheet: ({ features }: { features?: FeatureMap | null }) => createElement("i", { "data-x": `measure-sheet leads=${features?.leads ?? "none"}` }),
}));
vi.mock("@/lib/quick-measure-save", () => ({ discardModel: vi.fn() }));

import { ACTIONS, GlobalQuickAdd, QuickAddMenu, STUCK_MS, askWho, plusMeasures, plusOpens, quickAddActions, quickAddGo, type WhoAsk } from "./global-quick-add";
import { QuickMeasureRows, NO_LIDAR_DOORS, type LidarDoors } from "./quick-measure-rows";
import { ALL_ON, type FeatureMap } from "@/lib/features";
import { LangProvider } from "@/components/lang-provider";
import { dict, translator } from "@/lib/i18n";
import { heldModel, keepModelInPlus, measureAppLeft, measureHeld, measureStore, resetMeasureStoreForTest, setMeasureOwner, type MeasureContext } from "@/lib/quick-measure";
import { esTitleCase } from "../../tests/title-case-words";

/**
 * THE + (W1-11: eight rows to six) AND THE SWITCH BOARD (0352). The office: Snap or Note first, then
 * New Lead, New Job, New Appointment, New Estimate, New Invoice; a switched-off feature's row goes.
 * The crew: the + is Snap or Note itself, and no typed verb is his.
 */
const off = (...keys: (keyof FeatureMap)[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;
const labels = (isStaff: boolean, f?: FeatureMap) => quickAddActions(isStaff, f).map((a) => a.label);
const words = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const rows = (html: string) => Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)).map((m) => words(m[1]));

describe("quickAddActions", () => {
  it("the office, everything on (or no map): the six typed verbs, New Customer and New Reminder cut", () => {
    // New Inspection (Erik, 2026-10-15: "Add new inspection to plus menu") rides Leads, like New Lead.
    const six = ["New Lead", "New Job", "New Appointment", "New Inspection", "New Estimate", "New Invoice"];
    expect(labels(true, ALL_ON)).toEqual(six);
    expect(labels(true)).toEqual(six);
    expect(labels(true)).not.toContain("New Customer");
    expect(labels(true)).not.toContain("New Reminder");
  });

  it("a tech gets no typed verb at all: his + is Snap or Note", () => {
    expect(labels(false)).toEqual([]);
    expect(labels(false, off("leads", "estimates"))).toEqual([]);
    expect(plusOpens(false)).toBe("snap-or-note");
    expect(plusOpens(true)).toBe("menu");
  });

  it("Leads off: no New Lead and no New Inspection; Estimates off: no New Estimate; the rest stay", () => {
    expect(labels(true, off("leads"))).toEqual(["New Job", "New Appointment", "New Estimate", "New Invoice"]);
    expect(labels(true, off("estimates"))).toEqual(["New Lead", "New Job", "New Appointment", "New Inspection", "New Invoice"]);
  });
});

describe("the + on screen", () => {
  it("the office's menu: Snap or Note is the first row, then the verbs, every row 44px", () => {
    const html = renderToStaticMarkup(createElement(QuickAddMenu, { isStaff: true, onSnap: () => {}, onGo: () => {} }));
    expect(rows(html)).toEqual(["Snap or Note", "New Lead", "New Job", "New Appointment", "New Inspection", "New Estimate", "New Invoice"]);
    for (const b of html.match(/<button[^>]*>/g) ?? []) expect(b).toContain("min-h-11");
    // A switch that is off removes only its own row.
    const leadsOff = renderToStaticMarkup(createElement(QuickAddMenu, { isStaff: true, features: off("leads"), onSnap: () => {}, onGo: () => {} }));
    expect(rows(leadsOff)).toEqual(["Snap or Note", "New Job", "New Appointment", "New Estimate", "New Invoice"]);
  });

  it("a tech's + opens the paper door itself (no one-row menu), and names it; the office's + is Quick Add; both 44px", () => {
    const tech = renderToStaticMarkup(createElement(GlobalQuickAdd, { isStaff: false }));
    expect(tech).toMatch(/<button[^>]*aria-label="Snap or Note"/);
    expect(tech).not.toContain('aria-haspopup="menu"');
    const office = renderToStaticMarkup(createElement(GlobalQuickAdd, { isStaff: true, placement: "topbar" }));
    expect(office).toMatch(/<button[^>]*aria-label="Quick Add"[^>]*aria-haspopup="menu"/);
    for (const html of [tech, office]) expect(html).toMatch(/<button[^>]*class="[^"]*\bh-11 w-11\b/);
  });

  it("a Spanish-speaking tech (cn-v1138): his + is Foto o Nota; the office's menu keeps Snap or Note in its words; English byte for byte as before", () => {
    const es = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LangProvider, { lang: "es" } as Parameters<typeof LangProvider>[0], el));
    const tech = es(createElement(GlobalQuickAdd, { isStaff: false }));
    expect(tech).toMatch(/<button[^>]*aria-label="Foto o Nota"[^>]*title="Foto o Nota"/);
    expect(tech).not.toContain("Snap or Note");
    expect(rows(es(createElement(QuickAddMenu, { isStaff: true, onSnap: () => {}, onGo: () => {} })))[0]).toBe("Foto o Nota");
    expect(es(createElement(GlobalQuickAdd, { isStaff: true, placement: "topbar" }))).toMatch(/<button[^>]*aria-label="Agregar Rápido"/);
    const en = renderToStaticMarkup(createElement(LangProvider, { lang: "en" } as Parameters<typeof LangProvider>[0], createElement(GlobalQuickAdd, { isStaff: false })));
    expect(en).toBe(renderToStaticMarkup(createElement(GlobalQuickAdd, { isStaff: false })));
  });

  it("the office's verbs in Spanish (cn-v1139): every row Title Case, through the nav catalog by key; English byte for byte", () => {
    const es = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LangProvider, { lang: "es" } as Parameters<typeof LangProvider>[0], el));
    const menu = rows(es(createElement(QuickAddMenu, { isStaff: true, onSnap: () => {}, onGo: () => {} })));
    expect(menu).toEqual(["Foto o Nota", "Nuevo Prospecto", "Nuevo Trabajo", "Nueva Cita", "Nueva Inspección", "Nuevo Presupuesto", "Nueva Factura"]);
    for (const r of menu) expect(esTitleCase(r), r).toBe(true); // the significant words (cn-v1147)
    expect(quickAddActions(true, ALL_ON, translator("es")).map((a) => a.label)).toEqual(menu.slice(1));
    expect(quickAddActions(true, ALL_ON, translator("en")).map((a) => a.label)).toEqual(quickAddActions(true, ALL_ON).map((a) => a.label));
    // Each row carries its key, and the key's English is the row's old literal.
    expect(ACTIONS.map((a) => a.key)).toEqual(["nv_add_newLead", "nv_add_newJob", "nv_add_newAppointment", "nv_add_newInspection", "nv_add_newEstimate", "nv_add_newInvoice"]);
    expect(ACTIONS.map((a) => dict("en")[a.key])).toEqual(["New Lead", "New Job", "New Appointment", "New Inspection", "New Estimate", "New Invoice"]);
    // No English literal is left in the file: the leak scan reads it (tests/tech-words-in-the-catalog.test.ts).
    const src = readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8");
    expect(src).not.toContain('label: "New');
  });

  it("the two sentences a tap says carry the row's own Spanish word (cn-v1139)", () => {
    const t = translator("es");
    expect(quickAddGo({ online: false, lastFailed: false, stuck: false, label: "Nuevo Trabajo" }, t)).toEqual({
      way: "offline",
      said: "No hay señal ahora, así que Nuevo Trabajo no puede abrir. Vuelve a tocar Nuevo Trabajo cuando tengas una o dos barras.",
    });
    expect(quickAddGo({ online: true, lastFailed: true, stuck: false, label: "Nuevo Trabajo", sending: 6 }, t)).toEqual({
      way: "wait",
      said: "Foto o Nota todavía está enviando 6 archivos, y recargar ahora los detendría. Toca Nuevo Trabajo de nuevo cuando ya estén.",
    });
    expect(quickAddGo({ online: true, lastFailed: false, stuck: true, label: "Nuevo Trabajo", sending: 1 }, t)).toEqual({
      way: "wait",
      said: "Foto o Nota todavía está enviando 1 archivo, y recargar ahora lo detendría. Toca Nuevo Trabajo de nuevo cuando ya esté.",
    });
    // The component hands its own translator in, with the row's translated label.
    const src = readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8");
    expect(src).toMatch(/const next = quickAddGo\(\s*\{[\s\S]*?label: a\.label,[\s\S]*?\},\s*t,\s*\);/);
  });

  it("lapsed (skeptic #43, S1): the + is not drawn at all — every verb of it is a closed door", () => {
    expect(renderToStaticMarkup(createElement(GlobalQuickAdd, { isStaff: true, placement: "topbar", lapsed: true }))).toBe("");
    expect(renderToStaticMarkup(createElement(GlobalQuickAdd, { isStaff: false, lapsed: true }))).toBe("");
    // The hooks run before the early return, so the mount is one shape either way.
    const src = readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8");
    expect(src.indexOf("if (lapsed) return null;")).toBeGreaterThan(src.lastIndexOf("useEffect("));
  });

  it("the floating button is gone: no drag, no saved position", () => {
    const src = readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8");
    for (const gone of ["cn_quickadd_pos", "localStorage", "onPointerDown", "setPointerCapture", '"fab"']) expect(src).not.toContain(gone);
    // The top bar still compiles unchanged: placement is accepted (and ignored).
    expect(src).toContain('placement?: "topbar";');
  });
});

describe("the tap that did nothing, twice (triage 2026-09-27)", () => {
  it("no signal: the tap says so in words and doesn't try", () => {
    expect(quickAddGo({ online: false, lastFailed: false, stuck: false, label: "New Job" })).toEqual({
      way: "offline",
      said: "No signal right now, so New Job can't open. Tap it again once you have a bar or two.",
    });
    // Even right after a failure: no signal is said first.
    expect(quickAddGo({ online: false, lastFailed: true, stuck: false, label: "New Job" }).way).toBe("offline");
  });

  it("a page that failed to load is really retried on the next tap: a full load", () => {
    expect(quickAddGo({ online: true, lastFailed: true, stuck: false, label: "New Job" })).toEqual({ way: "full" });
    expect(quickAddGo({ online: true, lastFailed: false, stuck: true, label: "New Job" })).toEqual({ way: "full" });
    expect(quickAddGo({ online: true, lastFailed: false, stuck: false, label: "New Job" })).toEqual({ way: "soft" });
    expect(STUCK_MS).toBeGreaterThanOrEqual(5000);
  });

  it("never a full reload while Snap or Note is still sending files: the tap says so and waits", () => {
    expect(quickAddGo({ online: true, lastFailed: true, stuck: false, label: "New Job", sending: 6 })).toEqual({
      way: "wait",
      said: "Snap or Note is still sending 6 files, and reloading now would stop them. Tap New Job again once they're in.",
    });
    expect(quickAddGo({ online: true, lastFailed: false, stuck: true, label: "New Job", sending: 1 })).toEqual({
      way: "wait",
      said: "Snap or Note is still sending 1 file, and reloading now would stop it. Tap New Job again once it's in.",
    });
    // Nothing sending: the full load that really retries. An ordinary tap is soft either way.
    expect(quickAddGo({ online: true, lastFailed: true, stuck: false, label: "New Job", sending: 0 })).toEqual({ way: "full" });
    expect(quickAddGo({ online: true, lastFailed: false, stuck: false, label: "New Job", sending: 6 })).toEqual({ way: "soft" });
    const src = readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8");
    expect(src).toContain("sending: snapStillSending(),");
    expect(src).toContain('if (next.way === "offline" || next.way === "wait") {');
  });

  it("a failed navigation is forgotten once a later one lands (one offline tap hours ago never makes every + tap a reload)", () => {
    const src = readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8");
    expect(src).toContain("const pathname = usePathname();");
    expect(src).toMatch(/landedOn\.current = pathname;\s*failed\.current = false;/);
  });

  it("the + hears the shell's failed navigation, and a full load is window.location.assign", () => {
    const src = readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8");
    expect(src).toContain('window.addEventListener("cn:navigation-failed", onFail);');
    expect(src).toContain("window.location.assign(a.href);");
    expect(src).toContain("navigator.onLine !== false");
  });

  it("the sentence is said in the menu, where the tap was", () => {
    const html = renderToStaticMarkup(
      createElement(QuickAddMenu, { isStaff: true, onSnap: () => {}, onGo: () => {}, said: "No signal right now, so New Job can't open. Tap it again once you have a bar or two." }),
    );
    expect(html).toMatch(/role="status"[^>]*>No signal right now, so New Job can(&#x27;|')t open/);
  });
});

describe("Measure from the + (cn-v1160): the Lidar group in the office's menu", () => {
  const ALL: LidarDoors = { measure: true, scan: true };
  const noop = () => {};
  const group = (doors: LidarDoors, held = false) => createElement(QuickMeasureRows, { doors, held, onPick: noop, onReopen: noop, onDiscard: noop });
  const menu = (lidar?: Parameters<typeof QuickAddMenu>[0]["lidar"], lang?: "es") => {
    const el = createElement(QuickAddMenu, { isStaff: true, onSnap: noop, onGo: noop, lidar });
    return renderToStaticMarkup(lang ? createElement(LangProvider, { lang } as Parameters<typeof LangProvider>[0], el) : el);
  };

  it("with no slot, or a slot with nothing in it, the menu is byte for byte what it was (a browser, the server's render)", () => {
    const was = renderToStaticMarkup(createElement(QuickAddMenu, { isStaff: true, onSnap: noop, onGo: noop }));
    expect(menu()).toBe(was);
    expect(menu(null)).toBe(was);
    expect(menu(false)).toBe(was);
    // The group itself, on a phone with no plugin and nothing held: nothing, not an empty title.
    expect(menu(group(NO_LIDAR_DOORS))).toBe(was);
    expect(rows(was)).toEqual(["Snap or Note", "New Lead", "New Job", "New Appointment", "New Inspection", "New Estimate", "New Invoice"]);
  });

  it("the group sits right under Snap or Note, before the typed creates, and changes nothing around it", () => {
    const was = menu();
    const html = menu(group(ALL));
    expect(rows(html)).toEqual(["Snap or Note", "Measure", "Measure Area", "3D Scan", "New Lead", "New Job", "New Appointment", "New Inspection", "New Estimate", "New Invoice"]);
    // The rest of the menu is the same bytes, with the group set in after the first row.
    const afterSnap = was.indexOf("</button>") + "</button>".length;
    expect(html).toBe(was.slice(0, afterSnap) + renderToStaticMarkup(group(ALL)) + was.slice(afterSnap));
    // Every row of the menu is still 44px, and a Lidar row wears the menu's own row class (plus the look of a row that waits).
    const all = html.match(/<button[^>]*>/g) ?? [];
    expect(all).toHaveLength(10);
    for (const b of all) expect(b).toContain("min-h-11");
    const menuRow = all[0]!.match(/class="([^"]*)"/)![1];
    for (const b of all.slice(1, 4)) expect(b).toContain(`class="${menuRow} disabled:opacity-50"`);
    for (const b of all.slice(4)) expect(b).toContain(`class="${menuRow}"`);
    // A switch that is off still removes only its own row.
    const leadsOff = renderToStaticMarkup(createElement(QuickAddMenu, { isStaff: true, features: off("leads"), onSnap: noop, onGo: noop, lidar: group(ALL) }));
    expect(rows(leadsOff)).toEqual(["Snap or Note", "Measure", "Measure Area", "3D Scan", "New Job", "New Appointment", "New Estimate", "New Invoice"]);
  });

  it("a held model's two rows take 3D Scan's place in the same spot; the sentence a tap says still stands under everything", () => {
    expect(rows(menu(group(ALL, true))).slice(0, 6)).toEqual(["Snap or Note", "Measure", "Measure Area", "3D Model · Not Saved", "Discard Kept 3D Model", "New Lead"]);
    const said = renderToStaticMarkup(createElement(QuickAddMenu, { isStaff: true, onSnap: noop, onGo: noop, lidar: group(ALL), said: "No signal right now." }));
    expect(said).toMatch(/New Invoice<\/button><p [^>]*role="status"[^>]*>No signal right now\.<\/p>$/);
  });

  it("the Spanish menu: the group in Spanish between Foto o Nota and Nuevo Prospecto", () => {
    const html = menu(group(ALL), "es");
    expect(rows(html)).toEqual(["Foto o Nota", "Medir", "Medir Área", "Escaneo 3D", "Nuevo Prospecto", "Nuevo Trabajo", "Nueva Cita", "Nueva Inspección", "Nuevo Presupuesto", "Nueva Factura"]);
    for (const r of rows(html)) expect(esTitleCase(r), r).toBe(true);
  });

  it("the + hands the group its doors, the store and its taps; a tap closes the menu FIRST and then opens the screen", () => {
    const src = readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8");
    // The doors are read once after mount, only for a person whose + has the group; the store is subscribed to.
    expect(src).toContain("const measures = plusMeasures(isStaff, lapsed);");
    expect(src).toContain("const doors = useLidarDoors(measures);");
    expect(src).toContain("const store = useSyncExternalStore(subscribeMeasure, measureStore, measureStore);");
    // The rows wait while the phone's screen is up AND while a discard is on its way out. That second
    // wait is the +'s own state, never the rows': the menu unmounts its rows when it closes, and a menu
    // opened again mid-discard must not offer the sheet on a model whose file is being taken back down.
    expect(src).toMatch(/<QuickMeasureRows\s+doors=\{doors\}\s+busy=\{store\.busy !== null \|\| letting\}\s+held=\{held !== null\}/);
    expect(src).toContain("const [letting, setLetting] = useState(false);");
    expect(src).toContain("onPick={pick}");
    // A discard goes through the save lane's one door (it also takes back a file that already went up),
    // leaves the menu open, lets the rows go again whatever happened, and only once the model has gone
    // takes away a sentence that named it.
    const discard = src.slice(src.indexOf("onDiscard={async () => {"), src.indexOf("onSnap={() => {"));
    expect(discard).toMatch(
      /^onDiscard=\{async \(\) => \{\s+setLetting\(true\);\s+try \{\s+await discardModel\(\);\s+\} finally \{\s+setLetting\(false\);\s+\}\s+setSaid\(null\);\s+\}\}/,
    );
    expect(discard).not.toContain("setOpen(");
    // The menu must never sit open over the phone's own measuring screen: closed, then the camera.
    const pick = src.slice(src.indexOf("function pick(kind: MeasureKind) {"), src.indexOf("function go(a: QuickAddAction) {"));
    expect(pick).toContain("void runQuickMeasure(kind, { lang, words: t });");
    expect(pick.indexOf("setOpen(false);")).toBeGreaterThan(0);
    expect(pick.indexOf("setOpen(false);")).toBeLessThan(pick.indexOf("void runQuickMeasure("));
    // And the sheet never opens under an open menu either.
    const reopen = src.slice(src.indexOf("onReopen={() => {"), src.indexOf("onDiscard={async () => {"));
    expect(reopen.indexOf("setOpen(false);")).toBeGreaterThan(0);
    expect(reopen.indexOf("setOpen(false);")).toBeLessThan(reopen.indexOf("reopenHeldModel();"));
    // Nothing in the file calls the plugin itself: where a result goes is the store's to say.
    expect(src).not.toMatch(/measureNative\(|scan3dNative\(/);
  });
});

describe("Measure from the + (cn-v1160): the mark, the sheet, the reload guard, and whose it is", () => {
  const usdz = () => new File([new Uint8Array([1, 2, 3])], "scan-3d-1.usdz", { type: "model/vnd.usdz+zip" });
  const PATH = "/tmp/north-scans/scan-a.usdz";
  const SAM = "user-sam:org-larkspur";
  const office = (lang?: "es", features?: FeatureMap) => {
    const el = createElement(GlobalQuickAdd, { isStaff: true, placement: "topbar", features });
    return renderToStaticMarkup(lang ? createElement(LangProvider, { lang } as Parameters<typeof LangProvider>[0], el) : el);
  };
  const tech = () => renderToStaticMarkup(createElement(GlobalQuickAdd, { isStaff: false }));
  const src = readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8");

  beforeEach(() => {
    resetMeasureStoreForTest();
    Object.assign(phone, { measure: false, scan: false, model: false });
    vi.unstubAllGlobals();
  });

  it("quickAddGo with a held model: the +'s own full reload WAITS and says the two ways out", () => {
    const said = "+ is holding a 3D model you haven't saved, and reloading now would lose it. Save it or discard it, then tap New Job again.";
    expect(quickAddGo({ online: true, lastFailed: true, stuck: false, label: "New Job", holding: true })).toEqual({ way: "wait", said });
    expect(quickAddGo({ online: true, lastFailed: false, stuck: true, label: "New Job", holding: true })).toEqual({ way: "wait", said });
    // An ordinary tap is a soft navigation, which keeps the page's memory: nothing to wait for.
    expect(quickAddGo({ online: true, lastFailed: false, stuck: false, label: "New Job", holding: true })).toEqual({ way: "soft" });
    // Nothing held: the full load that really retries, as before.
    expect(quickAddGo({ online: true, lastFailed: true, stuck: false, label: "New Job", holding: false })).toEqual({ way: "full" });
    // No signal is still said first; files still sending are said before the model (they finish on their own).
    expect(quickAddGo({ online: false, lastFailed: true, stuck: false, label: "New Job", holding: true }).way).toBe("offline");
    expect(quickAddGo({ online: true, lastFailed: true, stuck: false, label: "New Job", sending: 2, holding: true })).toEqual({
      way: "wait",
      said: "Snap or Note is still sending 2 files, and reloading now would stop them. Tap New Job again once they're in.",
    });
    expect(quickAddGo({ online: true, lastFailed: true, stuck: false, label: "Nuevo Trabajo", holding: true }, translator("es"))).toEqual({
      way: "wait",
      said: "El + tiene un modelo 3D sin guardar, y recargar ahora lo perdería. Guárdalo o descártalo, y toca Nuevo Trabajo de nuevo.",
    });
    for (const lang of ["en", "es"] as const) expect(dict(lang).sh_measure_holdingModel).toContain("{label}");
    // The + asks the store at the moment of the tap: a model in page memory, whoever's it is.
    expect(src).toContain("holding: measureHeld(),");
    expect(measureHeld()).toBe(false);
    expect(keepModelInPlus({ model: usdz(), path: PATH })).toBe(true);
    expect(measureHeld()).toBe(true);
  });

  it("a tech's + is still Snap or Note itself in one tap with the plugin present, and nothing of the Lidar group mounts for him", () => {
    const plain = tech();
    Object.assign(phone, { measure: true, scan: true, model: true });
    expect(keepModelInPlus({ model: usdz(), path: PATH })).toBe(true);
    const withPlugin = tech();
    // Byte for byte the + he had: the paper door itself, no menu, no sheet, no mark.
    expect(withPlugin).toBe(plain);
    expect(withPlugin).toMatch(/<button[^>]*aria-label="Snap or Note"/);
    expect(withPlugin).not.toContain('aria-haspopup="menu"');
    expect(withPlugin).not.toContain("measure-sheet");
    expect(withPlugin).not.toContain('role="img"');
    expect(plusOpens(false)).toBe("snap-or-note");
    // Whose + carries the group: the office's, on a company in good standing.
    expect(plusMeasures(true)).toBe(true);
    expect(plusMeasures(true, false)).toBe(true);
    expect(plusMeasures(true, true)).toBe(false);
    expect(plusMeasures(false)).toBe(false);
    expect(plusMeasures(false, true)).toBe(false);
    // Every piece hangs on that one answer: the bridge is not asked, no model is his to see, no sheet.
    expect(src).toContain("const doors = useLidarDoors(measures);");
    expect(src).toContain("const held = measures ? heldModelOf(store) : null;");
    expect(src).toContain("{measures && <QuickMeasureSheet features={features} />}");
    // And the menu, where the rows live, is the office's alone.
    expect(src).toContain("{open && !crew && (");
  });

  it("the office: the ONE result sheet is mounted once beside Snap or Note's, handed the switch map, and never keyed", () => {
    const html = office();
    expect(html.split("measure-sheet").length - 1).toBe(1);
    expect(html).toContain('data-x="measure-sheet leads=none"');
    expect(office(undefined, off("leads"))).toContain('data-x="measure-sheet leads=false"');
    // Mounted once, after the paper door's, outside the menu (closing the menu never takes an open sheet with it).
    expect(src.split("<QuickMeasureSheet").length - 1).toBe(1);
    expect(src.indexOf("<QuickMeasureSheet")).toBeGreaterThan(src.indexOf("<SnapOrNoteProvider"));
    expect(src.indexOf("<QuickMeasureSheet")).toBeGreaterThan(src.lastIndexOf("<QuickAddMenu"));
    // A key around an open Modal makes the new one close itself (the cn-v1156 law).
    expect(src).not.toMatch(/<QuickMeasureSheet\b[^>]*\bkey=/);
    expect(src).not.toMatch(/<QuickMeasureRows\b[^>]*\bkey=/);
    // A lapsed company's + is not drawn, sheet and all (pinned above); a browser's office + has no mark.
    expect(html).not.toContain('role="img"');
  });

  it("while a 3D model is held the + wears a dot with its name: a mark, never a count", () => {
    expect(office()).not.toContain('role="img"');
    expect(keepModelInPlus({ model: usdz(), path: PATH })).toBe(true);
    const html = office();
    const dot = html.match(/<span role="img"[^>]*><\/span>/g) ?? [];
    expect(dot).toHaveLength(1); // one mark, with nothing written in it
    expect(dot[0]).toContain('aria-label="3D Model · Not Saved"');
    expect(dot[0]).toContain("pointer-events-none"); // it takes no tap: the row in the menu is the door
    expect(dot[0]).toContain("rounded-full");
    // Beside the button, never inside it (the button clips to its circle) and never the marked control itself.
    expect(html).toMatch(/<\/button><span role="img"/);
    expect(dot[0]).not.toContain("data-upright");
    expect(office("es")).toContain('aria-label="Modelo 3D · Sin Guardar"');
    expect(src).toContain('aria-label={t("sh_btn_measureHeldModel")}');
    // The + itself is the button it was.
    expect(html).toMatch(/<button[^>]*aria-label="Quick Add"[^>]*aria-haspopup="menu"/);
  });

  it("the app was left: the mark goes with the model's row until the same person is named again", () => {
    setMeasureOwner(SAM);
    expect(keepModelInPlus({ model: usdz(), path: PATH })).toBe(true);
    expect(office()).toContain('role="img"');
    measureAppLeft();
    expect(office()).not.toContain('role="img"');
    // Still in page memory, so the reload guard still waits.
    expect(measureHeld()).toBe(true);
    setMeasureOwner(SAM);
    expect(office()).toContain('role="img"');
    // The unmounting of the + IS the app being left.
    expect(src).toMatch(/return \(\) => \{\s*a\.live = false;\s*measureAppLeft\(\);\s*\};\s*\}, \[hasDoors\]\);/);
  });

  it("who is on the phone: the context names the store's owner, one ask at a time", async () => {
    const a: WhoAsk = { live: true, out: false };
    const sam: MeasureContext = { ok: true, userId: "user-sam", orgId: "org-larkspur", punchJob: null };
    let answer!: (c: MeasureContext) => void;
    const ask = vi.fn(() => new Promise<MeasureContext>((r) => (answer = r)));
    const first = askWho(a, ask);
    expect(a.out).toBe(true);
    // The menu opened again before the answer: no second ask stands in the queue.
    await askWho(a, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    answer(sam);
    await first;
    expect(measureStore().owner).toBe(SAM);
    expect(a.out).toBe(false);
    // The + asks through the one staff read, a route (never a server action, which would queue in
    // front of his saves), when it is handed no other.
    const asked = vi.fn(async () => new Response(JSON.stringify(sam), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", asked);
    await askWho(a);
    expect(asked).toHaveBeenCalledTimes(1);
    expect((asked.mock.calls[0] as unknown as [string])[0]).toBe("/api/measure/context");
    vi.unstubAllGlobals();
  });

  it("a context that says no, or a dropped connection, names nobody, and the next ask is free to go", async () => {
    const a: WhoAsk = { live: true, out: false };
    await askWho(a, async () => ({ ok: false, error: "Not signed in." }));
    expect(measureStore().owner).toBeNull();
    expect(a.out).toBe(false);
    await askWho(a, async () => {
      throw new Error("Failed to fetch");
    });
    expect(measureStore().owner).toBeNull();
    expect(a.out).toBe(false);
  });

  it("an answer that comes back after the + unmounted is dropped: it may be about somebody who has gone", async () => {
    setMeasureOwner(SAM);
    expect(keepModelInPlus({ model: usdz(), path: PATH })).toBe(true);
    const a: WhoAsk = { live: true, out: false };
    let answer!: (c: MeasureContext) => void;
    const asked = askWho(a, () => new Promise<MeasureContext>((r) => (answer = r)));
    // The + unmounts while the ask is out (the effect's cleanup).
    a.live = false;
    measureAppLeft();
    answer({ ok: true, userId: "user-dana", orgId: "org-larkspur", punchJob: null });
    await asked;
    // Nobody was named by it: Sam's model is still hidden and still his.
    expect(measureStore()).toMatchObject({ owner: SAM, left: true });
    expect(measureHeld()).toBe(true);
    // A dead mount asks nothing at all.
    const ask = vi.fn(async (): Promise<MeasureContext> => ({ ok: false, error: "Not signed in." }));
    await askWho(a, ask);
    expect(ask).not.toHaveBeenCalled();
  });

  it("the next mount asks for itself: the same person gets the model back, anybody else starts with nothing held", async () => {
    setMeasureOwner(SAM);
    expect(keepModelInPlus({ model: usdz(), path: PATH })).toBe(true);
    measureAppLeft();
    await askWho({ live: true, out: false }, async () => ({ ok: true, userId: "user-sam", orgId: "org-larkspur", punchJob: null }));
    expect(heldModel()?.path).toBe(PATH);

    measureAppLeft();
    await askWho({ live: true, out: false }, async () => ({ ok: true, userId: "user-dana", orgId: "org-larkspur", punchJob: null }));
    expect(heldModel()).toBeNull();
    expect(measureHeld()).toBe(false);
    expect(measureStore().owner).toBe("user-dana:org-larkspur");
  });

  it("every mount asks once for itself; after that the asking is wired to the moments that cost nothing, and only while nobody is named", () => {
    // The mount's own ask goes out as soon as the doors are there, whatever the store already says: a
    // name in it answers a question an earlier mount asked, and who is here now is this one's to find out.
    expect(src).toMatch(/const a: WhoAsk = \{ live: true, out: false \};\s*who\.current = a;\s*(?:\/\/[^\n]*\s*)*void askWho\(a\);\s*return \(\) => \{\s*a\.live = false;/);
    // Asked again on the menu, a model coming to be held, the signal coming back.
    expect(src).toContain("const unnamed = hasDoors && (store.owner === null || store.left);");
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!unnamed\) return;\s*const ask = \(\) => void askWho\(who\.current\);\s*ask\(\);\s*window\.addEventListener\("online", ask\);\s*return \(\) => window\.removeEventListener\("online", ask\);\s*\}, \[unnamed, holding, open\]\);/);
    // Never on a timer: the app sends its saves one at a time, and a repeating read would stand in front of his own.
    expect(src).not.toMatch(/setInterval|setTimeout/);
    // The answer goes through the store's own rule, and only from a mount that is still there.
    const who = src.slice(src.indexOf("export async function askWho("), src.indexOf("const ROW ="));
    expect(who).toContain("if (!a.live || a.out) return;");
    expect(who).toContain("if (a.live) setMeasureOwner(measureOwnerKey(c));");
  });
});
