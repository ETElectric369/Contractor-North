import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

/**
 * The Inspector's carried findings, group A (audit v1120, 2026-10-17):
 *   1, 6  a picked or located address was marked saved BEFORE the write, and a failed write was
 *         never said and never retried;
 *   10    every photo upload sent this phone's whole page-open photo_meta map, which put back the
 *         office's older captions and placements;
 *   9, 32 a view-only reader saw 3D / task-photo tiles that were disabled buttons and a task sheet
 *         with no way to close.
 */

const h = vi.hoisted(() => ({
  setAppointmentPlace: vi.fn(),
  refresh: vi.fn(),
  resolved: null as null | ((parts: unknown) => void),
}));
// The server renderer refuses startTransition; a click in the browser would run the callback at once.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useTransition: () => [false, (cb: () => unknown) => void cb()],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }) }));
vi.mock("@/app/(app)/appointments/actions", () => ({
  addInspectionPhotos: vi.fn(),
  removeInspectionPhoto: vi.fn(),
  saveInspectionAnswers: vi.fn(),
  saveInspectionCapture: vi.fn(),
  setAppointmentPlace: h.setAppointmentPlace,
  linkAppointmentTo: vi.fn(),
  searchLinkTargets: vi.fn(async () => []),
}));
vi.mock("@/app/(app)/appointments/hear-actions", () => ({ hearIntoPlaybook: vi.fn() }));
vi.mock("@/app/(app)/forms/actions", () => ({ createStarterInspectionSheet: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
// The address box is a Places widget; here it only hands over the callback a pick would fire.
vi.mock("@/components/address-autocomplete", () => ({
  AddressAutocomplete: (props: { onResolved?: (parts: unknown) => void }) => {
    h.resolved = props.onResolved ?? null;
    return createElement("input", { "data-address-box": "yes" });
  },
}));

import { Inspector, TapTile, mergeCapturePatches } from "@/app/(app)/appointments/[id]/inspector";
import type { InspectionAccess } from "@/lib/inspection/inspection-access";

const SRC = readFileSync("src/app/(app)/appointments/[id]/inspector.tsx", "utf8");

const SHEET = {
  id: "sheet-1",
  name: "Site walk",
  schema: [],
  playbook: {
    needs: [
      { key: "work", label: "Work", ask: "What kind of work is this?", slot: { type: "select", options: ["Deck", "Remodel"], other: true } },
      { key: "tasks", label: "Tasks", ask: "What are the tasks?", slot: { type: "tasks" } },
    ],
  },
};
const ANSWERS = {
  work: "Remodel",
  tasks: [{ id: "t1", name: "Hood outlet", hours: 2, units: null, kit_id: null, materials: [] }],
};
const BASE = "org-1/appointments/appt-1";
const JPG = `${BASE}/1700000000000-panel.jpg`;
const GLB = `${BASE}/1700000000001-room.glb`;
const TASK_JPG = `${BASE}/1700000000002-hood.jpg`;
const TASK_USDZ = `${BASE}/1700000000003-kitchen.usdz`;
const url = (p: string) => `https://example.invalid/${p.split("/").pop()}`;
const PATHS = [JPG, GLB, TASK_JPG, TASK_USDZ];

const render = (access: InspectionAccess, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(Inspector, {
      appointmentId: "appt-1",
      orgId: "org-1",
      userId: "u-1",
      templates: [SHEET],
      priceBook: [],
      initialTemplateId: "sheet-1",
      initialAnswers: ANSWERS as never,
      initialCapture: {
        photos: PATHS,
        photo_meta: { [TASK_JPG]: { task_id: "t1" }, [TASK_USDZ]: { task_id: "t1" } },
      },
      initialPhotos: PATHS.map((path) => ({ path, url: url(path) })),
      initialLocation: "",
      linked: { kind: "lead", name: "Sara Dale" },
      estimateHref: null,
      access,
      initialOpenTaskId: "t1",
      ...over,
    }),
  );

const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/\s+/g, " ").trim();
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ markup: m[0], text: textOf(m[0]) }));
/** The div-shaped buttons: the only kind a read-only fieldset leaves alive. */
const tapTiles = (html: string) =>
  [...html.matchAll(/<div[^>]*role="button"[^>]*>[\s\S]*?<\/div>/g)].map((m) => ({ markup: m[0], text: textOf(m[0]) }));

const LINE = "12 Bayberry Ln, Thistlewood, CA 96100";
const PICK = { formatted: LINE, line1: "12 Bayberry Ln", city: "Thistlewood", state: "CA", zip: "96100" };
const settle = () => new Promise((r) => setTimeout(r, 0));

async function pick() {
  render("office");
  expect(h.resolved).toBeTypeOf("function");
  h.resolved!(PICK);
  await settle();
  await settle();
}

beforeEach(() => {
  h.setAppointmentPlace.mockReset();
  h.refresh.mockReset();
  h.resolved = null;
});

describe("A picked or located visit address is written without reading the result, and marked saved so the autosave never retries", () => {
  it("a pick writes the line WITH its parts, and the page refreshes only when the write says ok", async () => {
    h.setAppointmentPlace.mockResolvedValue({ ok: true, id: "appt-1" });
    await pick();
    expect(h.setAppointmentPlace).toHaveBeenCalledTimes(1);
    expect(h.setAppointmentPlace).toHaveBeenCalledWith("appt-1", LINE, { city: "Thistlewood", state: "CA", zip: "96100" });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("an {ok:false} answer does not refresh the page as if it landed", async () => {
    h.setAppointmentPlace.mockResolvedValue({ ok: false, error: "You are not on this visit." });
    await pick();
    expect(h.setAppointmentPlace).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("a request that rejects (a dead zone) is caught, not left to take the page down", async () => {
    const seen: unknown[] = [];
    const onRejection = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onRejection);
    h.setAppointmentPlace.mockRejectedValue(new Error("Failed to fetch"));
    await pick();
    await settle();
    process.off("unhandledRejection", onRejection);
    expect(seen).toEqual([]);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("the line is marked saved only AFTER the write's result, in the one place both doors use", () => {
    const fn = SRC.slice(SRC.indexOf("function savePick("), SRC.indexOf("const initialLocationRef"));
    expect(fn.indexOf("await setAppointmentPlace(appointmentId, line, parts)")).toBeGreaterThan(-1);
    expect(fn.indexOf("if (!w.ok) {")).toBeGreaterThan(fn.indexOf("await setAppointmentPlace"));
    expect(fn.indexOf("savedPlaceRef.current = line;")).toBeGreaterThan(fn.indexOf("if (!w.ok) {"));
    // a refusal and a dead zone are both said in words, and the green tick comes down
    expect(fn).toContain('setError(w.error ?? "Couldn\'t save the address — still trying.");');
    expect(fn).toContain("No signal — the address is held on this phone and will save when you're back in range.");
    expect(fn.match(/setSavedAt\(null\)/g)?.length).toBe(2);
    // and the autosave is left to try it again
    expect(fn).toContain("if (!w.refused) schedule();");
  });

  it("Use My Location hands its line to savePick and never marks it saved itself", () => {
    const fn = SRC.slice(SRC.indexOf("async function locateHere()"), SRC.indexOf("function queueCapture("));
    expect(fn).toContain("savePick(line, { city: found.city ?? null, state: found.state ?? null, zip: found.zip ?? null });");
    expect(fn).not.toContain("savedPlaceRef");
    expect(fn).not.toContain("start(async");
  });

  it("the retry (the autosave and the leave-page flush) writes the line with its town, and marks it only on ok", () => {
    expect(SRC).toContain("const r = await setAppointmentPlace(appointmentId, latestPlace, partsForLine(latestPlace));");
    const flushOk = SRC.slice(SRC.indexOf("const r = await setAppointmentPlace(appointmentId, latestPlace"), SRC.indexOf("if (wantAnswers) {\n          const r"));
    expect(flushOk.indexOf("if (!r.ok) return restore(")).toBeLessThan(flushOk.indexOf("savedPlaceRef.current = latestPlace;"));
    const send = SRC.slice(SRC.indexOf("const send = () => {"), SRC.indexOf("// pagehide covers the iOS case"));
    expect(send).toContain("void setAppointmentPlace(appointmentId, line, partsForLine(line))");
    expect(send).toContain(".then((r) => { if (r.ok) savedPlaceRef.current = line; })");
    expect(send).not.toMatch(/savedPlaceRef\.current = placeRef\.current/);
  });
});

describe("Use My Location and an address pick mark the line 'already saved' before the write; a failed write is never retried, and onResolved ignores ok:false", () => {
  it("onResolved no longer marks the line saved before the write and no longer drops the result", () => {
    const at = SRC.indexOf("onResolved={(parts) => {");
    const fn = SRC.slice(at, SRC.indexOf("/>", at));
    expect(fn).toContain("savePick(line, { city: parts.city, state: parts.state, zip: parts.zip });");
    expect(fn).not.toContain("await setAppointmentPlace");
    expect(fn).not.toContain("router.refresh()");
    // the only mark left is the one with NOTHING to write (an empty line, or the stored one)
    expect(fn.match(/savedPlaceRef\.current = line;/g)?.length).toBe(1);
    expect(fn.indexOf("else savedPlaceRef.current = line;")).toBeGreaterThan(fn.indexOf("savePick("));
  });

  it("a located or picked line that failed to write stays pending with its parts for the retry", () => {
    expect(SRC).toContain("const unsavedPickRef = useRef<{ line: string; parts: PickedParts } | null>(null);");
    const fn = SRC.slice(SRC.indexOf("function savePick("), SRC.indexOf("const initialLocationRef"));
    expect(fn.indexOf("unsavedPickRef.current = { line, parts };")).toBeLessThan(fn.indexOf("await setAppointmentPlace"));
    expect(fn).toContain("if (unsavedPickRef.current?.line === line) unsavedPickRef.current = null;");
  });
});

describe("Photo placement 'merge' is defeated: every upload sends the phone's whole stale photo_meta map, so its older captions and placements overwrite the office's newer ones", () => {
  it("the upload queues only the photos IT added", () => {
    const fn = SRC.slice(SRC.indexOf("async function upload("), SRC.indexOf("function removePhoto("));
    expect(fn).toContain("const mine: Record<string, CapturePhotoMeta> = {};");
    expect(fn).toContain("mine[a.path] = meta[a.path];");
    expect(fn).toContain("queueCapture({ photo_meta: mine });");
    expect(fn).not.toContain("queueCapture({ photo_meta: meta });");
    // the page's own map still grows (the tile shows the caption at once)
    expect(fn).toContain("setPhotoMeta(meta);");
  });

  it("two patches that have not landed keep EACH other's photos, and the newer keeps its own key", () => {
    const first = { photo_meta: { a: { task_id: "t1" } }, notes: "old" };
    const second = { photo_meta: { b: { caption: "meter" }, a: { task_id: "t2" } }, notes: "new" };
    const merged = mergeCapturePatches(first, second);
    expect(merged.photo_meta).toEqual({ a: { task_id: "t2" }, b: { caption: "meter" } });
    // every other section is still the newer one's, whole
    expect(merged.notes).toBe("new");
    // neither input is changed
    expect(first.photo_meta).toEqual({ a: { task_id: "t1" } });
  });

  it("a patch with no photo_meta, or only one side with it, merges as it always did", () => {
    expect(mergeCapturePatches({ notes: "a" }, { measures: [] })).toEqual({ notes: "a", measures: [] });
    expect(mergeCapturePatches({ photo_meta: { a: { caption: "x" } } }, { notes: "n" })).toEqual({ photo_meta: { a: { caption: "x" } }, notes: "n" });
    expect(mergeCapturePatches({ notes: "n" }, { photo_meta: { a: { caption: "x" } } })).toEqual({ notes: "n", photo_meta: { a: { caption: "x" } } });
  });

  it("the queue and a failed save's restore both go through the merge, not a shallow spread", () => {
    expect(SRC).toContain("capturePatchRef.current = mergeCapturePatches(capturePatchRef.current, patch);");
    expect(SRC).toContain("capturePatchRef.current = mergeCapturePatches(patch, capturePatchRef.current);");
    expect(SRC).not.toContain("capturePatchRef.current = { ...capturePatchRef.current, ...patch };");
    expect(SRC).not.toContain("capturePatchRef.current = { ...patch, ...capturePatchRef.current };");
  });
});

describe("View-only tech sees 3D tiles and task-sheet photo tiles that are disabled buttons: tapping does nothing", () => {
  const view = render("view");
  const office = render("office");

  it("a view-only reader's 3D tiles (the visit's grid and the task sheet's) are not buttons the fieldset kills", () => {
    expect(view).toMatch(/<fieldset[^>]*disabled/);
    expect(buttons(view).filter((b) => b.text.includes("3D"))).toEqual([]);
    const tiles = tapTiles(view).filter((t) => t.text.includes("3D"));
    // the model on the visit and the one placed on the task: two in the grid, one in the sheet
    expect(tiles.length).toBeGreaterThanOrEqual(3);
    for (const t of tiles) expect(t.markup).toContain('tabindex="0"');
    expect(tiles.map((t) => t.text).join(" ")).toContain("room.glb");
    expect(tiles.map((t) => t.text).join(" ")).toContain("kitchen.usdz");
  });

  it("the photo placed on a task is a tile a view-only reader can open, not a disabled button", () => {
    expect(view).not.toMatch(/<button[^>]*disabled=""[^>]*>\s*<img/);
    const sheet = view.slice(view.indexOf('id="task-t1"'));
    const open = tapTiles(sheet).filter((t) => t.markup.includes("hood.jpg"));
    expect(open.length).toBeGreaterThanOrEqual(1);
  });

  it("the office and a crew lead still get the real buttons", () => {
    expect(buttons(office).filter((b) => b.text.includes("3D")).length).toBeGreaterThanOrEqual(3);
    expect(tapTiles(office).filter((t) => t.text.includes("3D"))).toEqual([]);
    expect(buttons(render("crewLead")).filter((b) => b.text.includes("3D")).length).toBeGreaterThanOrEqual(3);
  });

  it("the tile opens with the tap and with Enter or Space, and ignores other keys", () => {
    const onClick = vi.fn();
    const el = TapTile({ readOnly: true, onClick, className: "x", children: "3D" });
    expect(isValidElement(el)).toBe(true);
    const props = (el as { props: { onClick: () => void; onKeyDown: (e: unknown) => void; role: string; tabIndex: number } }).props;
    expect(props.role).toBe("button");
    expect(props.tabIndex).toBe(0);
    props.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
    const prevent = vi.fn();
    props.onKeyDown({ key: "Enter", preventDefault: prevent });
    props.onKeyDown({ key: " ", preventDefault: prevent });
    expect(onClick).toHaveBeenCalledTimes(3);
    expect(prevent).toHaveBeenCalledTimes(2);
    props.onKeyDown({ key: "a", preventDefault: prevent });
    expect(onClick).toHaveBeenCalledTimes(3);
    // not read-only: a plain button
    const live = TapTile({ readOnly: false, onClick, children: "3D" }) as { type: string };
    expect(live.type).toBe("button");
  });
});

describe("A read-only viewer can open a task sheet but has no control to close it, and its photos are disabled", () => {
  it("a view-only reader gets a Done that closes the sheet, drawn as a tile (a Button would be disabled)", () => {
    const view = render("view");
    expect(view.indexOf('aria-expanded="false"')).toBe(-1); // t1's sheet is the open one
    expect(buttons(view).map((b) => b.text)).not.toContain("Done");
    const done = tapTiles(view).filter((t) => t.text === "Done");
    expect(done.length).toBe(1);
    expect(done[0].markup).toContain('tabindex="0"');
    expect(done[0].markup).toMatch(/h-11/); // 44px, like every door
    expect(SRC).toMatch(/<TapTile readOnly onClick=\{\(\) => openTask\(null\)\}/);
  });

  it("the office still has its Done Button, once", () => {
    const office = render("office");
    expect(buttons(office).filter((b) => b.text === "Done").length).toBe(1);
    expect(tapTiles(office).filter((t) => t.text === "Done")).toEqual([]);
  });
});
