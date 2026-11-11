import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

/**
 * MEASURE FROM THE +: THE INSPECTOR'S SIDE (cn-v1160). On a visit whose Inspector he can write, the +
 * runs the Inspector's OWN measureInto / scan3dInto (a server-side append would be erased by the
 * sheet's next autosave, which sends its whole measures section). Pinned here: the one provider,
 * registered once; a reader offers nothing; a model the + holds is taken only when nothing is kept;
 * the 51st measurement is refused in words before the camera opens (F1); a model that never went up
 * goes to the + when the office leaves the visit (F2); and no Swift.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(app)/appointments/actions", () => ({
  addInspectionPhotos: vi.fn(),
  removeInspectionPhoto: vi.fn(),
  saveInspectionAnswers: vi.fn(),
  saveInspectionCapture: vi.fn(),
  setAppointmentPlace: vi.fn(),
  linkAppointmentTo: vi.fn(),
  searchLinkTargets: vi.fn(async () => []),
}));
vi.mock("@/app/(app)/appointments/hear-actions", () => ({ hearIntoPlaybook: vi.fn() }));
vi.mock("@/app/(app)/forms/actions", () => ({ createStarterInspectionSheet: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));

import { canAdoptModel, measuresFull, modelForThePlus } from "@/app/(app)/appointments/[id]/inspector";
import { MAX_MEASURES } from "@/lib/inspection/capture";
import type { KeptModel } from "@/lib/native-scan";
import { translator } from "@/lib/i18n";

const ROOT = join(__dirname, "..");
const insp = readFileSync(join(ROOT, "src/app/(app)/appointments/[id]/inspector.tsx"), "utf8");
const hostBlock = insp.slice(insp.indexOf("// ── MEASURE FROM THE + (cn-v1160) ──"), insp.indexOf("// ── THE PRELIMINARY REPORT'S ANSWERS"));
const measureFn = insp.slice(insp.indexOf("async function measureInto("), insp.indexOf("// ── 3D SCAN: the textured model"));

const model = (over: Partial<KeptModel> = {}): KeptModel => ({
  model: new File([new Uint8Array([1])], "scan-3d-1.usdz", { type: "model/vnd.usdz+zip" }),
  path: "/tmp/north-scans/scan-3d-1.usdz",
  taskId: null,
  landed: null,
  ...over,
});

describe("the decisions, as pure functions", () => {
  it("the cap: 49 takes one more, 50 is full", () => {
    expect(MAX_MEASURES).toBe(50);
    expect(measuresFull(0)).toBe(false);
    expect(measuresFull(MAX_MEASURES - 1)).toBe(false);
    expect(measuresFull(MAX_MEASURES)).toBe(true);
    expect(measuresFull(MAX_MEASURES + 3)).toBe(true);
  });

  it("a held model is adopted only when nothing is kept and nothing is measuring", () => {
    expect(canAdoptModel(null, false)).toBe(true);
    expect(canAdoptModel(model(), false)).toBe(false);
    expect(canAdoptModel(null, true)).toBe(false);
  });

  it("leaving hands the + only the office's model whose file never landed", () => {
    const unsent = model();
    expect(modelForThePlus(unsent, true)).toBe(unsent);
    expect(modelForThePlus(unsent, false)).toBeNull(); // a crew lead: as today
    expect(modelForThePlus(model({ landed: { path: "org/appointments/v/1-scan.usdz", url: null } }), true)).toBeNull();
    expect(modelForThePlus(null, true)).toBeNull();
  });

  it("the refusal is said in both languages, with the number and one action", () => {
    expect(translator("en")("vi_measuresFull")).toBe("{n} measurements is the most a visit holds. Take one off first.");
    expect(translator("es")("vi_measuresFull")).toBe("{n} medidas es lo máximo que guarda una visita. Quita una primero.");
  });
});

describe("the wiring, pinned", () => {
  it("the Inspector registers ONE measure provider, once, reading a ref", () => {
    expect(insp.split("registerMeasureHost(").length - 1).toBe(1);
    expect(insp).toContain("useEffect(() => registerMeasureHost(() => hostRef.current), []);");
  });

  it("the host is null for a reader, and is the in-page buttons' own functions for the open place", () => {
    expect(hostBlock).toMatch(/hostRef\.current = readOnly\s*\?\s*null/);
    expect(hostBlock).toContain("measure: (mode) => measureInto(measurePlace(), mode),");
    expect(hostBlock).toContain("scan: () => scan3dInto(measurePlace()),");
    // The open task while it is still on the sheet, else the visit.
    expect(hostBlock).toContain("const id = openTaskIdRef.current;");
    expect(hostBlock).toContain("return id && tasksNow().some((x) => x.id === id) ? id : null;");
  });

  it("adoptModel refuses when a model is kept, else keeps it un-landed and sends it down scan3dInto", () => {
    const adopt = hostBlock.slice(hostBlock.indexOf("adoptModel:"), hostBlock.indexOf("useEffect(() => registerMeasureHost"));
    expect(adopt).toContain("if (!canAdoptModel(unsentModelRef.current, measuringRef.current)) return false;");
    expect(adopt).toContain("keep({ model: m.model, path: m.path, taskId: at, landed: null });");
    expect(adopt).toContain("void scan3dInto(at);");
    expect(adopt.indexOf("return false")).toBeLessThan(adopt.indexOf("keep({"));
  });

  it("the cap is checked before the camera opens, and the typed adds ask it too", () => {
    expect(measureFn).toContain("if (atMeasureCap()) return;");
    expect(measureFn.indexOf("if (atMeasureCap()) return;")).toBeLessThan(measureFn.indexOf("measureNative("));
    expect(insp).toContain('setError(fillText(t("vi_measuresFull"), { n: String(MAX_MEASURES) }));');
    // The two Add a Measurement rows (a task's and the visit's).
    expect(insp.split("onClick={() => !atMeasureCap() && setMeasures([...measures,").length - 1).toBe(2);
  });

  it("leaving hands the + only an un-landed model, through keepModelInPlus, on unmount", () => {
    const leave = hostBlock.slice(hostBlock.indexOf("LEAVING WITH A MODEL"));
    expect(leave).toContain("const k = modelForThePlus(unsentModelRef.current, officeAccessRef.current);");
    expect(leave).toContain("if (k) keepModelInPlus({ model: k.model, path: k.path });");
    expect(leave).toMatch(/useEffect\(\(\) => \{\s*\/\/[^\n]*\n\s*pageGoneRef\.current = false;\s*return \(\) => \{\s*pageGoneRef\.current = true;/);
  });

  it("NO HAND-OFF WHILE A SEND IS OUT (the skeptic's S1): the send may land, and a + still saying Not Saved would send it twice", () => {
    const leave = hostBlock.slice(hostBlock.indexOf("LEAVING WITH A MODEL"));
    expect(leave.indexOf("if (measuringRef.current) return;")).toBeGreaterThan(-1);
    expect(leave.indexOf("if (measuringRef.current) return;")).toBeLessThan(leave.indexOf("keepModelInPlus("));
    // The page is marked gone BEFORE that return, so a send that fails afterwards knows it.
    expect(leave.indexOf("pageGoneRef.current = true;")).toBeLessThan(leave.indexOf("if (measuringRef.current) return;"));
  });

  it("A SEND THAT FAILS AFTER THE PAGE WENT hands its un-landed model to the + itself, office only, and lets go of it here only when the + took it", () => {
    // Two hand-offs, no more: the unmount's, and the failed send's.
    expect(insp.split("keepModelInPlus(").length - 1).toBe(2);
    const scan = insp.slice(insp.indexOf("async function scan3dInto("), insp.indexOf("/** Let go of the kept model whole"));
    const failed = scan.slice(scan.indexOf("keep({ model, path, taskId, landed: null });"));
    expect(failed).toMatch(
      /if \(pageGoneRef\.current\) \{\s*const k = modelForThePlus\(unsentModelRef\.current, officeAccessRef\.current\);\s*if \(k && keepModelInPlus\(\{ model: k\.model, path: k\.path \}\)\) keep\(null\);\s*\}\s*return;/,
    );
    // A model whose FILE landed is never handed over (only this visit can write its row): the
    // landed branch returns before this one.
    expect(scan.indexOf("keep({ model, path, taskId, landed: up });")).toBeLessThan(scan.indexOf("if (pageGoneRef.current)"));
  });

  it("the Measurement chip asks the cap too (the skeptic's N1): every door that adds a row asks", () => {
    expect(insp).toContain('on: () => { open1("measures"); if (!atMeasureCap()) setMeasures((m) => [...m, { id: captureId(), label: "", value: null, unit: "" }]); }');
  });

  it("nothing new under ios/ (a Swift change would force a new app build)", () => {
    let changed = "";
    try {
      changed = execSync("git status --porcelain -- ios", { cwd: ROOT, encoding: "utf8" });
    } catch {
      return; // no git here (a copied tree): the source pins above still hold
    }
    expect(changed.trim()).toBe("");
  });
});
