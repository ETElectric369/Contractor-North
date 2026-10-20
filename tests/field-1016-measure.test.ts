/**
 * MEASURE WITH THE CAMERA (LiDAR rung 1, field feedback 10-13, item 5). Erik: "in the task itself
 * is where we will be needing photos, measurements, materials and labor and Lidar." The shell's
 * MeasurePlugin opens Apple-style measuring and hands back meters and a snapshot; the page turns
 * that into a measurement row on the task (feet, or square feet) with the picture placed beside
 * it. The door exists only where the plugin is on the bridge; a refusal is the plugin's sentence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { feetInches, measureNative, measurePluginPresent, metersToFeet, photoFile, squareMetersToSquareFeet } from "@/lib/native-measure";

const read = (p: string) => readFileSync(p, "utf8");

// The shell is a user-agent question (lib/native-shell); here it is a switch, so Node's read-only
// navigator is never touched.
let shellOn = false;
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => shellOn }));

function shell(measure?: (o: { mode: string }) => Promise<unknown>) {
  const g = globalThis as unknown as { window?: unknown; atob?: unknown };
  const prev = { window: g.window, atob: g.atob };
  shellOn = true;
  g.window = { Capacitor: { Plugins: measure ? { Measure: { measure } } : {} } };
  if (!g.atob) g.atob = (b: string) => Buffer.from(b, "base64").toString("binary");
  return () => {
    shellOn = false;
    g.window = prev.window;
    g.atob = prev.atob;
  };
}

describe("the units: meters to feet (two decimals), square meters to square feet (one), feet and inches for a caption", () => {
  it("converts and rounds", () => {
    expect(metersToFeet(1)).toBe(3.28);
    expect(metersToFeet(3.6576)).toBe(12);
    expect(squareMetersToSquareFeet(1)).toBe(10.8);
    expect(squareMetersToSquareFeet(9.2903)).toBe(100);
    expect(feetInches(3.86)).toBe("3 ft 10.3 in");
    expect(feetInches(0.5)).toBe("6 in");
    expect(feetInches(12)).toBe("12 ft 0 in");
    expect(feetInches(3.9967)).toBe("4 ft 0 in"); // 11.96 in rolls up, never "3 ft 12 in"
  });
  it("a snapshot becomes a JPEG File; junk is null", () => {
    const off = shell();
    try {
      const f = photoFile(Buffer.from("x".repeat(200)).toString("base64"), "image/jpeg", "measure-1.jpg");
      expect(f?.name).toBe("measure-1.jpg");
      expect(f?.type).toBe("image/jpeg");
      expect(f?.size).toBe(200);
      expect(photoFile("short", "image/jpeg", "a.jpg")).toBeNull();
      expect(photoFile(12, "image/jpeg", "a.jpg")).toBeNull();
      expect(photoFile(Buffer.from("x".repeat(200)).toString("base64"), "text/html", "a.jpg")?.type).toBe("image/jpeg");
    } finally {
      off();
    }
  });
});

describe("the bridge: present only in the shell with the plugin; the result in feet; a cancel is a cancel; a refusal is the plugin's sentence", () => {
  let off: () => void = () => {};
  afterEach(() => off());
  it("no plugin, no door (a browser, or the App Store build)", () => {
    off = shell();
    expect(measurePluginPresent()).toBe(false);
  });
  it("a length comes back in feet with its caption, points and whether LiDAR did it, and the snapshot as a File", async () => {
    const measure = vi.fn(async () => ({ ok: true, mode: "length", meters: 3.6576, points: 2, lidar: true, photo: Buffer.from("y".repeat(300)).toString("base64"), photoMime: "image/jpeg" }));
    off = shell(measure);
    expect(measurePluginPresent()).toBe(true);
    const r = await measureNative("length");
    expect(measure).toHaveBeenCalledWith({ mode: "length" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ mode: "length", value: 12, unit: "ft", caption: "12 ft 0 in", points: 2, lidar: true, approx: false });
    expect(r.photo?.type).toBe("image/jpeg");
  });
  it("an area comes back in square feet; no photo is null, not a broken result", async () => {
    off = shell(async () => ({ ok: true, mode: "area", squareMeters: 9.2903, points: 4 }));
    const r = await measureNative("area");
    expect(r).toEqual({ ok: true, mode: "area", value: 100, unit: "sq ft", caption: "100 sq ft (approx.)", points: 4, lidar: false, approx: true, photo: null });
  });
  it("without the sensor the figure is one decimal and says approx; a zero is refused, not a row", async () => {
    off = shell(async () => ({ ok: true, mode: "length", meters: 3.7, points: 2, lidar: false }));
    expect(await measureNative("length")).toMatchObject({ value: 12.1, caption: "12 ft 1.2 in (approx.)", approx: true });
    off();
    off = shell(async () => ({ ok: true, mode: "length", meters: 0.002, points: 2, lidar: true }));
    expect(await measureNative("length")).toEqual({ ok: false, refused: "Measure came back with nothing — the points sat on the same spot. Try again." });
  });
  it("cancelled → {cancelled}; a plugin rejection → its sentence; a result with no number is refused in words", async () => {
    off = shell(async () => ({ ok: false, cancelled: true }));
    expect(await measureNative("length")).toEqual({ ok: false, cancelled: true });
    off();
    off = shell(async () => {
      throw new Error("North needs the camera to measure. Allow the camera for North in Settings → Apps → North, then try again.");
    });
    expect(await measureNative("length")).toEqual({ ok: false, refused: "North needs the camera to measure. Allow the camera for North in Settings → Apps → North, then try again." });
    off();
    off = shell(async () => ({ ok: true, mode: "length" }));
    expect(await measureNative("length")).toEqual({ ok: false, refused: "Measure came back without a number. Try again." });
    off();
    off = shell();
    expect(await measureNative("length")).toEqual({ ok: false, refused: "Measure needs the North app on an iPhone." });
  });
});

describe("the wiring, pinned", () => {
  it("the Swift plugin exists, is registered on the bridge, is in the Xcode project, and the camera words say measuring", () => {
    const swift = read("ios/App/App/MeasurePlugin.swift");
    expect(swift).toContain('public let jsName = "Measure"');
    expect(swift).toContain('CAPPluginMethod(name: "measure", returnType: CAPPluginReturnPromise)');
    expect(swift).toContain("ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)");
    expect(swift).toContain("AVCaptureDevice.requestAccess(for: .video)");
    expect(swift).toContain('call.resolve(["ok": false, "cancelled": true])');
    expect(swift).toContain("static func polygonArea(");
    // Points only while tracking is normal; an interruption clears them and says so; no tap-anywhere.
    expect(swift).toContain("guard trackingNormal else {");
    expect(swift).toContain("func sessionWasInterrupted(_ session: ARSession) {\n        trackingNormal = false\n        clearPoints()");
    expect(swift).toContain("func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { false }");
    expect(swift).not.toContain("UITapGestureRecognizer");
    expect(swift).toContain("return total >= 0.005 ? total : nil");
    expect(swift).toContain('call.reject("Measure couldn\'t open over this screen. Close what\'s open and try again.")');
    expect(swift).toContain("Self.downscaled(sceneView.snapshot(), maxSide: 1600)");
    // No network from a plugin, ever (the agent security framework).
    expect(swift).not.toMatch(/URLSession|URLRequest/);
    expect(read("ios/App/App/NorthBridgeViewController.swift")).toContain("bridge?.registerPluginInstance(MeasurePlugin())");
    expect(read("ios/App/App.xcodeproj/project.pbxproj")).toContain("MeasurePlugin.swift in Sources");
    expect(read("ios/App/App/Info.plist")).toContain("and to measure a length or an area on site with Measure.");
  });
  it("the Inspector draws Measure / Measure Area only after the plugin is seen, on the task and on the visit; a figure lands as a row with the snapshot captioned", () => {
    const insp = read("src/app/(app)/appointments/[id]/inspector.tsx");
    expect(insp).toContain("useEffect(() => setCanMeasure(measurePluginPresent()), []);");
    expect(insp).toContain("const [canMeasure, setCanMeasure] = useState(false);");
    // One helper draws both headers (the task's and the visit's) under the Lidar title, above the
    // Measurements rows (Erik 2026-10-16: "group everything with a title called Lidar").
    expect(insp).toContain("const measureButtons = (taskId: string | null) =>");
    expect(insp).toContain("!readOnly && (canMeasure || scanOn.model) ? (");
    expect(insp).toContain("<SectionLabel>Lidar</SectionLabel>");
    expect((insp.match(/<SectionLabel>Lidar<\/SectionLabel>/g) ?? []).length).toBe(1);
    expect(insp).toContain("{measureButtons(t.id)}\n                <SectionLabel>Measurements</SectionLabel>");
    expect(insp).toContain("{measureButtons(null)}\n          <SectionLabel>Measurements</SectionLabel>");
    expect(insp).toContain("{measureButtons(t.id)}");
    expect(insp).toContain("{measureButtons(null)}");
    expect(insp).toContain('onClick={() => void measureInto(taskId, "length")}');
    expect(insp).toContain('onClick={() => void measureInto(taskId, "area")}');
    const fn = insp.slice(insp.indexOf("async function measureInto("), insp.indexOf("// ── THE DOORS NORT TYPES INTO"));
    expect(fn).toContain('if ("refused" in r) setError(r.refused);');
    expect(fn).toContain("const label = `${mode === \"area\" ? \"Measured area\" : \"Measured length\"}${r.approx ? \" (approx.)\" : \"\"}`;");
    expect(fn).toContain("const row: CaptureMeasure = { id, label, value: r.value, unit: r.unit, ...(taskId ? { task_id: taskId } : {}) };");
    expect(fn).toContain("const next = [...measuresRef.current, row];\n      measuresRef.current = next;");
    expect(fn).toContain("if (measuringRef.current) return;");
    expect(fn).toContain('setError("The measurement landed, but its picture didn\'t come back.");');
    expect(fn).toContain("queueCapture({ measures: next });");
    expect(fn).toContain("await upload([r.photo], { caption: r.caption, about: label });");
    expect(fn).toContain("document.getElementById(`measure-label-${id}`)?.focus()");
    // (cn-v1123: a third argument, the files a kept 3D model already has in storage; Measure never passes it)
    expect(insp).toContain("async function upload(files: File[], extra?: Partial<CapturePhotoMeta>, landed?: CapturePhoto[]): Promise<string[]>");
    expect(insp).toContain("...(extra ?? {}), ...(forTask ? { task_id: forTask } : {})");
    // The upload writes the list as it stands when it FINISHES (refs), never a stale copy.
    expect(insp).toContain("const next = [...photosRef.current, ...added.filter((a) => !photosRef.current.some((p) => p.path === a.path))];\n      photosRef.current = next;");
    expect(insp).toContain("const meta = { ...photoMetaRef.current };");
  });
});
