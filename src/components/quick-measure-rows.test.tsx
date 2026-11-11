import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE LIDAR GROUP IN THE + (cn-v1160). Drawn only where the plugin is on the bridge, and the bridge
 * is read AFTER mount: a static render (the server's, and the phone's first paint) draws nothing even
 * on a phone that has it, so a browser's + menu is byte for byte what it was. With the plugin there:
 * the Inspector's title and verbs, 3D Scan only where the Scan plugin says this phone can, every row
 * a 44px row of the menu's own look, in both languages; a held model takes 3D Scan's place with its
 * two rows; Discard asks first, in the menu; everything waits while the screen is up.
 *
 * The phone here is a stand-in for the two bridges' presence checks (the bridges themselves are
 * pinned in tests/field-1016-measure and tests/field-1016-scan3d). There is no screen to tap in the
 * suite, so the taps are made on the rows themselves: lidarGroup hands back the elements, and a tap
 * is the row's own onClick, refused when the row is disabled as a browser would refuse it.
 */
const phone = vi.hoisted(() => ({ measure: false, scan: false, model: false, asked: 0 }));
vi.mock("@/lib/native-measure", () => ({ measurePluginPresent: () => phone.measure }));
vi.mock("@/lib/native-scan", () => ({
  scanPluginPresent: () => phone.scan,
  scanDoors: async () => {
    phone.asked += 1;
    return { model: phone.model };
  },
}));

import { LidarRowsView, NO_LIDAR_DOORS, QuickMeasureRows, discardOnce, lidarGroup, readLidarDoors, useLidarDoors, type LidarDoors } from "./quick-measure-rows";
import { LangProvider } from "@/components/lang-provider";
import { dict, translator } from "@/lib/i18n";
import { enTitleCase, esTitleCase } from "../../tests/title-case-words";

const SRC = readFileSync(join(process.cwd(), "src/components/quick-measure-rows.tsx"), "utf8");
const PLUS = readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8");

const ALL: LidarDoors = { measure: true, scan: true };
const NO_SENSOR: LidarDoors = { measure: true, scan: false };
const noop = () => {};
const handlers = { onPick: noop, onReopen: noop, onAsk: noop, onDiscard: noop, onKeep: noop };
type ViewProps = Parameters<typeof LidarRowsView>[0];

const es = (el: ReactElement) => renderToStaticMarkup(createElement(LangProvider, { lang: "es" } as Parameters<typeof LangProvider>[0], el));
const words = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const buttons = (html: string) => html.match(/<button\b[^>]*>/g) ?? [];
const rows = (html: string) => Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)).map((m) => words(m[1]));
const view = (props: Partial<ViewProps> = {}) => renderToStaticMarkup(createElement(LidarRowsView, { doors: ALL, ...handlers, ...props }));

// ── The rows themselves, to tap ──
type Row = ReactElement<{ children?: unknown; onClick?: () => void; disabled?: boolean }>;
function rowsOf(node: unknown, out: Row[] = []): Row[] {
  if (Array.isArray(node)) node.forEach((n) => rowsOf(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as Row;
    if (el.type === "button") out.push(el);
    else rowsOf(el.props.children, out);
  }
  return out;
}
const labelOf = (row: Row) =>
  (Array.isArray(row.props.children) ? row.props.children : [row.props.children])
    .filter((c): c is string => typeof c === "string")
    .join("")
    .trim();
/** Tap the row that says `label`. A disabled row takes no tap, as on a screen. */
function tap(group: ReactElement | null, label: string) {
  const row = rowsOf(group).find((r) => labelOf(r) === label);
  if (!row) throw new Error(`no row says "${label}"`);
  if (!row.props.disabled) row.props.onClick?.();
}
/** A group with every tap written down. */
function tapped(props: Partial<ViewProps> = {}) {
  const calls: string[] = [];
  const group = lidarGroup(translator("en"), {
    doors: ALL,
    onPick: (kind) => calls.push(`pick ${kind}`),
    onReopen: () => calls.push("reopen"),
    onAsk: () => calls.push("ask"),
    onDiscard: () => calls.push("discard"),
    onKeep: () => calls.push("keep"),
    ...props,
  });
  return { group, calls };
}

/** What the + runs after mount, driven here without one: every answer the bridges gave, in order. */
async function doorsRead(): Promise<LidarDoors[]> {
  const told: LidarDoors[] = [];
  await readLidarDoors((d) => told.push(d));
  return told;
}

beforeEach(() => {
  Object.assign(phone, { measure: false, scan: false, model: false, asked: 0 });
});

describe("the doors are the phone's own answer, read after mount", () => {
  it("a static render draws NOTHING, even on a phone that has the plugin", () => {
    Object.assign(phone, { measure: true, scan: true, model: true });
    // The + as it mounts: the hook's answer handed straight to the group.
    function AsThePlusMountsIt() {
      return createElement(QuickMeasureRows, { doors: useLidarDoors(), onPick: noop, onReopen: noop, onDiscard: noop });
    }
    expect(renderToStaticMarkup(createElement(AsThePlusMountsIt))).toBe("");
    // The bridge was not asked during the render: it is read in an effect, which a static render never runs.
    expect(phone.asked).toBe(0);
    expect(SRC).toMatch(/useEffect\(\(\) => \{\s*if \(!on\) return;\s*let live = true;\s*void readLidarDoors\(/);
    // And with no door and nothing held the group is nothing at all, not an empty title.
    expect(view({ doors: NO_LIDAR_DOORS })).toBe("");
    expect(lidarGroup(translator("en"), { doors: NO_LIDAR_DOORS, ...handlers })).toBeNull();
    expect(renderToStaticMarkup(createElement(QuickMeasureRows, { doors: NO_LIDAR_DOORS, onPick: noop, onReopen: noop, onDiscard: noop }))).toBe("");
  });

  it("a browser, or a build without the plugin: nothing is told, so nothing is ever drawn", async () => {
    expect(await doorsRead()).toEqual([]);
    expect(phone.asked).toBe(0);
  });

  it("the Measure plugin on the bridge: Measure at once; 3D Scan only once the Scan plugin says this phone can", async () => {
    // An iPhone with the sensor on iOS 17: Measure first (a key on the bridge is the whole answer), then 3D Scan.
    Object.assign(phone, { measure: true, scan: true, model: true });
    expect(await doorsRead()).toEqual([
      { measure: true, scan: false },
      { measure: true, scan: true },
    ]);
    // An iPhone without the sensor (or under iOS 17): the plugin is there and says no.
    Object.assign(phone, { measure: true, scan: true, model: false, asked: 0 });
    expect(await doorsRead()).toEqual([{ measure: true, scan: false }]);
    expect(phone.asked).toBe(1);
    // A build with Measure and no Scan plugin: it is never asked.
    Object.assign(phone, { measure: true, scan: false, model: true, asked: 0 });
    expect(await doorsRead()).toEqual([{ measure: true, scan: false }]);
    expect(phone.asked).toBe(0);
    // A build with Scan alone: 3D Scan on its own.
    Object.assign(phone, { measure: false, scan: true, model: true });
    expect(await doorsRead()).toEqual([{ measure: false, scan: true }]);
  });

  it("a tech's + never asks the bridge: the hook is handed `on` and answers no doors without it", () => {
    Object.assign(phone, { measure: true, scan: true, model: true });
    function ATechsPlus() {
      const doors = useLidarDoors(false);
      return createElement("i", { "data-doors": `${doors.measure} ${doors.scan}` });
    }
    expect(renderToStaticMarkup(createElement(ATechsPlus))).toBe('<i data-doors="false false"></i>');
    expect(SRC).toContain("export function useLidarDoors(on = true): LidarDoors {");
    expect(SRC).toContain("return on ? doors : NO_LIDAR_DOORS;");
    expect(SRC).toMatch(/\}, \[on\]\);/);
    expect(NO_LIDAR_DOORS).toEqual({ measure: false, scan: false });
  });
});

describe("the group on screen", () => {
  it("with the plugin: the Lidar title, then Measure, Measure Area and 3D Scan, the Inspector's own words", async () => {
    Object.assign(phone, { measure: true, scan: true, model: true });
    const doors = (await doorsRead()).at(-1)!;
    const html = renderToStaticMarkup(createElement(QuickMeasureRows, { doors, onPick: noop, onReopen: noop, onDiscard: noop }));
    expect(rows(html)).toEqual(["Measure", "Measure Area", "3D Scan"]);
    // The title is words, not a row: it sits above the rows, between two lines that set the group off.
    expect(words(html)).toBe("Lidar Measure Measure Area 3D Scan");
    expect(html).toMatch(/^<div class="[^"]*border-t[^"]*"><\/div><div class="[^"]*uppercase[^"]*">Lidar<\/div><button/);
    expect(html).toMatch(/<\/button><div class="[^"]*border-t[^"]*"><\/div>$/);
    // The words are the catalogs', by key.
    const en = dict("en");
    expect([en.vi_lidar, en.vi_btn_measure, en.vi_btn_measureArea, en.vi_btn_scan3d]).toEqual(["Lidar", "Measure", "Measure Area", "3D Scan"]);
    for (const key of ["vi_lidar", "vi_btn_measure", "vi_btn_measureArea", "vi_btn_scan3d", "sh_btn_measureHeldModel", "vi_btn_discardKept3dModel", "vi_discardKeptConfirm", "sh_btn_measureKeepModel"]) {
      expect(SRC, key).toContain(`t("${key}")`);
      expect(en[key], key).toBeTruthy();
      expect(dict("es")[key], key).toBeTruthy();
    }
  });

  it("each row asks for its own thing", () => {
    const { group, calls } = tapped();
    tap(group, "Measure");
    tap(group, "Measure Area");
    tap(group, "3D Scan");
    expect(calls).toEqual(["pick length", "pick area", "pick scan"]);
  });

  it("3D Scan only when the Scan plugin says so: an iPhone without the sensor measures and does not scan", async () => {
    Object.assign(phone, { measure: true, scan: true, model: false });
    const doors = (await doorsRead()).at(-1)!;
    expect(rows(view({ doors }))).toEqual(["Measure", "Measure Area"]);
    expect(rows(view({ doors: NO_SENSOR }))).toEqual(["Measure", "Measure Area"]);
    // A build with the Scan plugin alone draws the one row it can.
    expect(rows(view({ doors: { measure: false, scan: true } }))).toEqual(["3D Scan"]);
  });

  it("every row is a 44px row of the + menu's own look, with a 16px icon in the glass ink", () => {
    const menuRow = PLUS.match(/const ROW =\s*"([^"]+)";/)![1];
    expect(menuRow).toContain("min-h-11");
    for (const html of [view(), view({ held: true }), view({ held: true, asking: true })]) {
      const all = buttons(html);
      expect(all.length).toBeGreaterThanOrEqual(3);
      for (const b of all) {
        expect(b).toContain('type="button"');
        expect(b).toContain("min-h-11");
        expect(b).toContain("w-full");
      }
      // Every row but the red one wears the menu's row class word for word, plus the look of a row that waits.
      const plain = all.filter((b) => !b.includes("text-red-600"));
      expect(plain.length).toBeGreaterThanOrEqual(3);
      for (const b of plain) expect(b).toContain(`class="${menuRow} disabled:opacity-50"`);
      // One icon a row, 16px.
      const icons = html.match(/<svg\b[^>]*>/g) ?? [];
      expect(icons.length).toBe(all.length);
      for (const svg of icons) expect(svg).toMatch(/\bh-4 w-4 shrink-0\b/);
    }
    expect(view().match(/<svg\b[^>]*>/g)!.every((s) => s.includes("text-[rgb(var(--glass-ink))]"))).toBe(true);
  });

  it("the Spanish rows: Title Case, the significant words, through the catalogs", () => {
    const html = es(createElement(LidarRowsView, { doors: ALL, ...handlers }));
    expect(rows(html)).toEqual(["Medir", "Medir Área", "Escaneo 3D"]);
    expect(words(html)).toBe("Lidar Medir Medir Área Escaneo 3D");
    const held = es(createElement(LidarRowsView, { doors: ALL, held: true, asking: true, ...handlers }));
    expect(rows(held)).toEqual(["Medir", "Medir Área", "Modelo 3D · Sin Guardar", "Descartar el Modelo 3D Guardado", "Dejarlo"]);
    expect(held).toContain("¿Descartar el modelo 3D guardado? Habría que escanear el cuarto otra vez.");
    for (const r of [...rows(html), ...rows(held)]) expect(esTitleCase(r), r).toBe(true);
    for (const r of [...rows(view()), ...rows(view({ held: true, asking: true }))]) expect(enTitleCase(r), r).toBe(true);
    // No English is left on a Spanish reader's menu.
    expect(held).not.toMatch(/Measure|Scan|Discard|Keep|Saved/);
  });
});

describe("a 3D model is waiting in the +", () => {
  it("takes the 3D Scan row's place with its two rows, the way out LAST and red", () => {
    const html = view({ held: true });
    expect(rows(html)).toEqual(["Measure", "Measure Area", "3D Model · Not Saved", "Discard Kept 3D Model"]);
    expect(rows(html)).not.toContain("3D Scan");
    const all = buttons(html);
    expect(all.at(-1)).toContain("text-red-600");
    expect(all.slice(0, -1).some((b) => b.includes("text-red-600"))).toBe(false);
    // Resting: no question yet.
    expect(html).not.toContain("Discard the kept 3D model?");
    expect(rows(html)).not.toContain("Keep It");
  });

  it("is offered wherever it waits, even if this phone's answer about scanning never came", () => {
    expect(rows(view({ doors: NO_SENSOR, held: true }))).toEqual(["Measure", "Measure Area", "3D Model · Not Saved", "Discard Kept 3D Model"]);
    expect(rows(view({ doors: NO_LIDAR_DOORS, held: true }))).toEqual(["3D Model · Not Saved", "Discard Kept 3D Model"]);
  });

  it("its row opens the sheet on it", () => {
    const { group, calls } = tapped({ held: true });
    tap(group, "3D Model · Not Saved");
    expect(calls).toEqual(["reopen"]);
  });

  it("Discard asks first, in the menu: the first tap only asks, and nothing is let go of", () => {
    const { group, calls } = tapped({ held: true });
    tap(group, "Discard Kept 3D Model");
    expect(calls).toEqual(["ask"]);
    // Never the browser's own dialog (its buttons are the browser's words, in the browser's language).
    expect(SRC).not.toMatch(/\bconfirm\(/);
  });

  it("the asking face: the question where the row was, the deed under it in red, then Keep It", () => {
    const html = view({ held: true, asking: true });
    expect(rows(html)).toEqual(["Measure", "Measure Area", "3D Model · Not Saved", "Discard Kept 3D Model", "Keep It"]);
    // The question is a sentence, never a row that looks pressable, and it stands between the model's
    // row and the deed: a second tap on the spot the first one hit lands on words.
    expect(html).toMatch(/3D Model · Not Saved<\/button><p [^>]*role="status"[^>]*>Discard the kept 3D model\? The room would need scanning again\.<\/p><button[^>]*text-red-600/);
    const { group, calls } = tapped({ held: true, asking: true });
    tap(group, "Discard Kept 3D Model");
    expect(calls).toEqual(["discard"]);
    tap(group, "Keep It");
    expect(calls).toEqual(["discard", "keep"]);
  });

  it("the + menu's group keeps the two taps: ask, then the deed or Keep It, and a model that has gone takes its question with it", () => {
    expect(SRC).toContain("onAsk={() => setAsking(true)}");
    expect(SRC).toContain("onKeep={() => setAsking(false)}");
    expect(SRC).toContain("asking={asking && held}");
    expect(SRC).toContain("onDiscard={() => void discardOnce({ going: discarding, discard: onDiscard, setGoing: setDiscarding, done: () => setAsking(false) })}");
    // Resting when it mounts: every opening of the menu starts from the rows, never from the question.
    const html = renderToStaticMarkup(createElement(QuickMeasureRows, { doors: ALL, held: true, onPick: noop, onReopen: noop, onDiscard: noop }));
    expect(rows(html)).toEqual(["Measure", "Measure Area", "3D Model · Not Saved", "Discard Kept 3D Model"]);
  });

  it("the deed runs ONCE, the rows wait while it is on its way out, and they come back whatever happened", async () => {
    const steps: string[] = [];
    const o = (going: boolean, discard: () => void | Promise<void>) => ({ going, discard, setGoing: (g: boolean) => steps.push(`going ${g}`), done: () => steps.push("done") });
    await discardOnce(
      o(false, async () => {
        steps.push("discard");
      }),
    );
    expect(steps).toEqual(["going true", "discard", "going false", "done"]);
    // Already on its way out: a second tap does nothing at all.
    steps.length = 0;
    await discardOnce(o(true, () => void steps.push("discard")));
    expect(steps).toEqual([]);
    // A fault in the save lane is its own to say; the rows still come back.
    await discardOnce(
      o(false, async () => {
        throw new Error("the file is still up");
      }),
    );
    expect(steps).toEqual(["going true", "going false", "done"]);
    // While it is on its way out every row waits.
    for (const b of buttons(view({ held: true, asking: true, discarding: true }))) expect(b).toContain('disabled=""');
    const { group, calls } = tapped({ held: true, asking: true, discarding: true });
    tap(group, "Discard Kept 3D Model");
    tap(group, "Keep It");
    expect(calls).toEqual([]);
  });
});

describe("the rows wait", () => {
  it("while the measuring or scanning screen is up, every row is disabled (the plugin shows one screen at a time)", () => {
    for (const html of [view({ busy: true }), view({ busy: true, held: true }), view({ busy: true, held: true, asking: true })]) {
      const all = buttons(html);
      expect(all.length).toBeGreaterThanOrEqual(3);
      for (const b of all) expect(b).toContain('disabled=""');
    }
    for (const b of buttons(view())) expect(b).not.toContain("disabled=");
    for (const b of buttons(view({ held: true, asking: true }))) expect(b).not.toContain("disabled=");
    // And a tap on a waiting row asks for nothing.
    const { group, calls } = tapped({ busy: true });
    for (const label of ["Measure", "Measure Area", "3D Scan"]) tap(group, label);
    const held = tapped({ busy: true, held: true });
    for (const label of ["Measure", "3D Model · Not Saved", "Discard Kept 3D Model"]) tap(held.group, label);
    expect([...calls, ...held.calls]).toEqual([]);
  });

  it("3D Scan alone waits while a model is in the + that nobody here has been named for yet", () => {
    const [measure, measureArea, scan] = buttons(view({ scanWaits: true }));
    expect(measure).not.toContain("disabled=");
    expect(measureArea).not.toContain("disabled=");
    expect(scan).toContain('disabled=""');
    expect(rows(view({ scanWaits: true }))).toEqual(["Measure", "Measure Area", "3D Scan"]);
    const { group, calls } = tapped({ scanWaits: true });
    for (const label of ["Measure", "Measure Area", "3D Scan"]) tap(group, label);
    expect(calls).toEqual(["pick length", "pick area"]);
  });
});

describe("what this file owns", () => {
  it("the doors and the two taps of Discard, and nothing else: the store and what a tap does are the +'s", () => {
    expect(SRC).not.toContain("runQuickMeasure(");
    expect(SRC).not.toContain("useSyncExternalStore");
    expect(SRC).toContain('import type { MeasureKind } from "@/lib/quick-measure";');
  });
});
