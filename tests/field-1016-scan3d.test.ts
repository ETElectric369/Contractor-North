/**
 * 3D SCAN (Lidar, the picture). Erik 2026-10-16, after Polycam: "collect all of the pixels for all
 * surfaces and render an image … i want that", and after Apple's own capture showed no coverage:
 * OUR OWN capture takes the photos as the walker moves (the mesh shows blue until a photo has it),
 * the phone builds the textured model, the file comes over the bridge in pieces, lands on the task
 * as a 3D file, and the tile (and the portal's 3D Scan slot) opens it in the in-app viewer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { arPreviewPresent, base64Of, bytesOf, CHUNK_BYTES, discardScan, MODEL_MAX_BYTES, openInAr, pullFile, scan3dNative, scanDoors, USDZ_MIME } from "@/lib/native-scan";
import { modelKind } from "@/components/model-viewer";

const read = (p: string) => readFileSync(p, "utf8");

let shellOn = false;
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => shellOn }));

function shell(plugins: Record<string, unknown>) {
  const g = globalThis as unknown as { window?: unknown; atob?: unknown };
  const prev = { window: g.window, atob: g.atob };
  shellOn = true;
  g.window = { Capacitor: { Plugins: plugins } };
  if (!g.atob) g.atob = (b: string) => Buffer.from(b, "base64").toString("binary");
  return () => {
    shellOn = false;
    g.window = prev.window;
    g.atob = prev.atob;
  };
}

/** A fake file in the shell: readChunk hands back slices as base64; discard is counted. */
function fakeFile(total: number) {
  const bytes = new Uint8Array(total);
  for (let i = 0; i < total; i++) bytes[i] = i % 251;
  const calls: Array<{ offset: number; length: number }> = [];
  let discarded = 0;
  const plugin = {
    scan3d: async () => ({ ok: true, kind: "model", path: "/tmp/north-scans/model-x.usdz", bytes: total, mime: USDZ_MIME, shots: 42 }),
    readChunk: async ({ offset, length }: { path: string; offset: number; length: number }) => {
      calls.push({ offset, length });
      const slice = bytes.slice(offset, Math.min(total, offset + length));
      return { data: Buffer.from(slice).toString("base64"), bytes: slice.length, total };
    },
    discard: async () => {
      discarded += 1;
    },
  };
  return { bytes, plugin, calls, discarded: () => discarded };
}

describe("the file comes over in pieces; the shell's copy goes only once the upload has landed", () => {
  afterEach(() => {
    shellOn = false;
  });
  it("base64 → bytes; junk → null", () => {
    expect(Array.from(bytesOf(Buffer.from([1, 2, 3]).toString("base64")) ?? [])).toEqual([1, 2, 3]);
    expect(bytesOf(7)).toBeNull();
  });
  it("pullFile asks 2 MB at a time and assembles the whole file byte for byte; it never discards (the page does, after the upload)", async () => {
    const off = shell({});
    try {
      const f = fakeFile(CHUNK_BYTES * 2 + 123);
      const file = await pullFile(f.plugin, "/tmp/north-scans/model-x.usdz", f.bytes.length, "scan-3d-1.usdz", USDZ_MIME);
      expect(file?.name).toBe("scan-3d-1.usdz");
      expect(file?.type).toBe(USDZ_MIME);
      expect(file?.size).toBe(f.bytes.length);
      expect(f.calls).toEqual([
        { offset: 0, length: CHUNK_BYTES },
        { offset: CHUNK_BYTES, length: CHUNK_BYTES },
        { offset: CHUNK_BYTES * 2, length: CHUNK_BYTES },
      ]);
      expect(f.discarded()).toBe(0);
      // Byte for byte (a Buffer compare: a deep-equal diff of 4 MB would time the test out).
      expect(Buffer.from(await file!.arrayBuffer()).equals(Buffer.from(f.bytes))).toBe(true);
    } finally {
      off();
    }
  });
  it("a piece that throws is asked once more; a short read, a bad size, a monster or a total that lies low is null", async () => {
    const f = fakeFile(10);
    let flaky = true;
    const onceFlaky = { ...f.plugin, readChunk: async (o: { path: string; offset: number; length: number }) => { if (flaky) { flaky = false; throw new Error("bridge hiccup"); } return f.plugin.readChunk(o); } };
    expect((await pullFile(onceFlaky, "/p", 10, "a.usdz", USDZ_MIME))?.size).toBe(10);
    const broken = { ...f.plugin, readChunk: async () => ({ data: "", bytes: 0, total: 10 }) };
    expect(await pullFile(broken, "/p", 10, "a.usdz", USDZ_MIME)).toBeNull();
    expect(await pullFile(f.plugin, "/p", 0, "a.usdz", USDZ_MIME)).toBeNull();
    expect(await pullFile(f.plugin, "/p", MODEL_MAX_BYTES + 1, "a.usdz", USDZ_MIME)).toBeNull();
    // Ten real bytes, eleven claimed: not whole. Four claimed when ten come: not whole either.
    expect(await pullFile(f.plugin, "/p", 11, "a.usdz", USDZ_MIME)).toBeNull();
    expect(await pullFile(f.plugin, "/p", 4, "a.usdz", USDZ_MIME)).toBeNull();
    expect(f.discarded()).toBe(0);
  });
  it("discardScan asks the shell to drop its copy; without the shell it is a no-op", async () => {
    await discardScan("/p");
    const f = fakeFile(1);
    const off = shell({ Scan: f.plugin });
    try {
      await discardScan("/tmp/north-scans/model-x.usdz");
      expect(f.discarded()).toBe(1);
      await discardScan("");
      expect(f.discarded()).toBe(1);
    } finally {
      off();
    }
  });
  it("scan3dNative: no door without the plugin; cancelled; a rejection's sentence; the model as a File; empty refused", async () => {
    expect(await scan3dNative()).toEqual({ ok: false, refused: "3D Scan needs the North app on an iPhone with a LiDAR sensor." });
    const f = fakeFile(5000);
    const off = shell({ Scan: { ...f.plugin, isSupported: async () => ({ model: true }) } });
    try {
      expect(await scanDoors()).toEqual({ model: true });
      const r = await scan3dNative(9);
      expect(r.ok && r.kind === "model" && r.model.name === "scan-3d-9.usdz" && r.model.size === 5000 && r.shots === 42 && r.path === "/tmp/north-scans/model-x.usdz").toBe(true);
      expect(f.discarded()).toBe(0);
    } finally {
      off();
    }
    const off2 = shell({ Scan: { ...f.plugin, scan3d: async () => ({ ok: false, cancelled: true }) } });
    try {
      expect(await scan3dNative()).toEqual({ ok: false, cancelled: true });
    } finally {
      off2();
    }
    const off3 = shell({ Scan: { ...f.plugin, scan3d: async () => { throw new Error("3D Scan needs iOS 17 or newer on an iPhone with a LiDAR sensor. Update the iPhone."); } } });
    try {
      expect(await scan3dNative()).toEqual({ ok: false, refused: "3D Scan needs iOS 17 or newer on an iPhone with a LiDAR sensor. Update the iPhone." });
    } finally {
      off3();
    }
    // An empty or a monster model is refused in words, and the shell's useless copy is dropped.
    const off4 = shell({ Scan: { ...f.plugin, scan3d: async () => ({ ok: true, kind: "model", path: "/p", bytes: 0 }) } });
    try {
      expect(await scan3dNative()).toEqual({ ok: false, refused: "The model came back empty. Try again with more light and a slower walk." });
      expect(f.discarded()).toBe(1);
    } finally {
      off4();
    }
    const off5 = shell({ Scan: { ...f.plugin, scan3d: async () => ({ ok: true, kind: "model", path: "/p", bytes: 250_000_000 }) } });
    try {
      expect(await scan3dNative()).toEqual({ ok: false, refused: "The model is too big to send (250 MB). Scan a smaller area." });
      expect(f.discarded()).toBe(2);
    } finally {
      off5();
    }
  });
  it("the viewer knows a 3D file by its name: usdz, glb, gltf; a query string ignored", () => {
    expect(modelKind("a/b/scan-3d-1.usdz?token=x")).toBe("usdz");
    expect(modelKind("deck.GLB")).toBe("gltf");
    expect(modelKind("room.gltf")).toBe("gltf");
    expect(modelKind("plan.png")).toBeNull();
    expect(modelKind(null)).toBeNull();
  });
});

describe("Open In AR: the page stages the bytes it drew and the shell opens Quick Look", () => {
  afterEach(() => {
    shellOn = false;
  });
  function staging() {
    const chunks: string[] = [];
    let previewed = "";
    let discarded = 0;
    const plugin = {
      scan3d: async () => ({}),
      stageFile: async ({ name }: { name: string }) => ({ path: `/tmp/north-scans/stage-${name}.usdz` }),
      stageChunk: async ({ data }: { path: string; data: string }) => {
        chunks.push(data);
        return { bytes: chunks.reduce((n, c) => n + Buffer.from(c, "base64").length, 0) };
      },
      previewFile: async ({ path }: { path: string }) => {
        previewed = path;
      },
      discard: async () => {
        discarded += 1;
      },
    };
    return { plugin, chunks, previewed: () => previewed, discarded: () => discarded };
  }
  it("base64Of round-trips, big arrays included", () => {
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    expect(Buffer.from(base64Of(bytes), "base64").equals(Buffer.from(bytes))).toBe(true);
  });
  it("no shell, no door; with the staging doors the bytes go over in 2 MB pieces, then Quick Look opens the staged file", async () => {
    expect(arPreviewPresent()).toBe(false);
    expect(await openInAr(new Uint8Array(10), "a.usdz")).toEqual({ ok: false, refused: "Open In AR needs the North app on an iPhone." });
    const st = staging();
    const off = shell({ Scan: st.plugin });
    try {
      expect(arPreviewPresent()).toBe(true);
      const bytes = new Uint8Array(CHUNK_BYTES + 5);
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 253;
      expect(await openInAr(bytes, "scan-3d-1.usdz")).toEqual({ ok: true });
      expect(st.chunks).toHaveLength(2);
      expect(Buffer.concat(st.chunks.map((c) => Buffer.from(c, "base64"))).equals(Buffer.from(bytes))).toBe(true);
      expect(st.previewed()).toBe("/tmp/north-scans/stage-scan-3d-1.usdz.usdz");
      expect(st.discarded()).toBe(0);
    } finally {
      off();
    }
  });
  it("a piece that fails drops the staged file and says why; an empty or monster model is refused", async () => {
    const st = staging();
    const off = shell({ Scan: { ...st.plugin, stageChunk: async () => { throw new Error("Couldn't write the model on this phone (disk full)."); } } });
    try {
      expect(await openInAr(new Uint8Array(10), "a.usdz")).toEqual({ ok: false, refused: "Couldn't write the model on this phone (disk full)." });
      expect(st.discarded()).toBe(1);
      expect(await openInAr(new Uint8Array(0), "a.usdz")).toEqual({ ok: false, refused: "This model is too big to open in AR here." });
    } finally {
      off();
    }
  });
});

describe("the wiring, pinned", () => {
  it("the Swift door: our own ARKit capture with visible coverage, then photogrammetry on the phone (depth + gravity per photo, masking off), the file served only from its own folder, in pieces", () => {
    const swift = read("ios/App/App/ScanPlugin.swift");
    for (const m of ["isSupported", "scan3d", "readChunk", "discard"]) expect(swift).toContain(`CAPPluginMethod(name: "${m}", returnType: CAPPluginReturnPromise)`);
    // Erik 2026-10-16: the site and room doors are gone; one door, one plugin.
    for (const gone of ["scanSite", "scanRoom", "RoomPlan", "ObjectCaptureSession", "ObjectCaptureView", "SiteScanViewController", "RoomScanViewController"]) expect(swift).not.toContain(gone);
    expect(swift).toContain("if #available(iOS 17.0, *) { return lidarPresent && PhotogrammetrySession.isSupported }");
    expect(swift).toContain('"3D Scan needs iOS 17 or newer on an iPhone with a LiDAR sensor. Update the iPhone."');
    // The capture: the mesh drawn blue, a 12 MP still by itself every 0.35 m / 15° (and on the shutter),
    // the faces a photo saw (in front, within reach, facing, not behind something per the depth map)
    // left out of the drawing — that is the clear; the coverage judged off the main thread.
    expect(swift).toContain("config.sceneReconstruction = .mesh");
    expect(swift).toContain("ARWorldTrackingConfiguration.recommendedVideoFormatForHighResolutionFrameCapturing");
    expect(swift).toContain("sceneView.session.captureHighResolutionFrame { [weak self] hi, _ in");
    expect(swift).toContain("DispatchQueue.main.async { self?.landShot(hi ?? frame, pose: frame) }");
    expect(swift).toContain("static let moveStep: Float = 0.35");
    expect(swift).toContain("static let turnStep: Float = 15 * .pi / 180");
    expect(swift).toContain("guard moved >= Self.moveStep || turned >= Self.turnStep else { return }");
    expect(swift).toContain('shutter.accessibilityLabel = "Take A Photo"');
    expect(swift).toContain("if z > reading + 0.08 + 0.06 * z { continue }");
    expect(swift).toContain("if normal != .zero, simd_dot(normal, eye - centre) <= 0 { continue }");
    expect(swift).toContain("guard p.x.isFinite, p.y.isFinite, p.z.isFinite else { return .min }");
    expect(swift).toContain("if !covered.contains(Self.key((a + b + c) / 3)) { idx.append(contentsOf: snap.faces[i..<i + 3]) }");
    expect(swift).toContain('private let work = DispatchQueue(label: "north.scan3d.coverage", qos: .userInitiated)');
    expect(swift).toContain("m.diffuse.contents = UIColor(red: 0.25, green: 0.55, blue: 1, alpha: 0.5)");
    expect(swift).toContain("Blue is what the scan still needs; it clears as photos land.");
    expect(swift).toContain("haptic.impactOccurred()");
    // The build: Finish waits for ten photos AND for every photo to be on disk; the photos go to the
    // session one at a time with their depth map (real size) and gravity (upright), in walking order.
    expect(swift).toContain("static let minShots = 10");
    expect(swift).toContain("guard finishWaiting, !processing, !finished, !shotInFlight, pendingWrites == 0 else { return }");
    expect(swift).toContain("struct ShotSamples: Sequence, IteratorProtocol");
    expect(swift).toContain("s.depthDataMap = map");
    expect(swift).toContain("s.gravity = r.gravity");
    expect(swift).toContain("config.isObjectMaskingEnabled = false");
    expect(swift).toContain("config.sampleOrdering = .sequential");
    expect(swift).toContain("try photo.process(requests: [.modelFile(url: output, detail: .reduced)])");
    expect(swift).toContain("PhotogrammetrySession(input: ShotSamples(dir: folder, records: records.sorted { $0.id < $1.id }), configuration: config)");
    // Kept from the first cut (skeptic #18): the phone must not lock; Cancel with work done asks;
    // a failure before the screen is up is said once it is; the build's errors are plain
    // sentences; stale scans sweep; the file is served only from the scan folder, in pieces.
    expect(swift).toContain("UIApplication.shared.isIdleTimerDisabled = true");
    expect(swift).toContain("UIApplication.shared.isIdleTimerDisabled = false");
    expect(swift).toContain('UIAlertAction(title: "Drop It", style: .destructive)');
    // Skeptic #19: an outcome before the screen is up waits for viewDidAppear; the presenter
    // dismisses (an alert on top goes with it); a build that ends with nothing is said, never hung;
    // photo ids never repeat; a failed capture drops its photos; the photo's own camera judges coverage.
    expect(swift).toContain("guard appeared else {\n            if pendingOutcome == nil { pendingOutcome = outcome }\n            return\n        }");
    expect(swift).toContain("(presentingViewController ?? self).dismiss(animated: true) { [done] in done(outcome) }");
    expect(swift).toContain('finish(.failed("The model didn\'t finish building. Try again."))');
    expect(swift).toContain("await MainActor.run { self?.buildEnded() }");
    expect(swift).toContain("nextId += 1\n        let id = nextId");
    expect(swift).toContain("let cam = frame.camera\n        let gravity = Self.gravity(in: cam.transform)");
    expect(swift).toContain("static let maxShots: Int = {");
    expect(swift).not.toContain("AudioServicesPlaySystemSound");
    expect(swift).toContain("static func buildSentence(_ error: Error) -> String");
    expect(swift).toContain("static func sweepOldScans()");
    expect(swift).toContain('"path": output.path');
    expect(swift).toContain('guard url.path.hasPrefix(folder + "/"), url.pathExtension.lowercased() == "usdz" else { return nil }');
    expect(swift).toContain('"mime": "model/vnd.usdz+zip", "shots": shots');
    expect(swift).toContain("let length = min(max(1, call.getInt(\"length\") ?? 2_000_000), 4_000_000)");
    expect(swift).toContain("if processing { photo?.cancel() }");
    // Open In AR: staging doors + Quick Look (the AR tab is Apple's); the staged file goes on dismiss.
    for (const m of ["stageFile", "stageChunk", "previewFile"]) expect(swift).toContain(`CAPPluginMethod(name: "${m}", returnType: CAPPluginReturnPromise)`);
    expect(swift).toContain("final class ModelPreview: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate");
    expect(swift).toContain("guard let url = Self.ownFile(call.getString(\"path\")) else {\n            call.reject(\"That file isn't a staged model of this app's.\")");
    expect(swift).toContain("try? FileManager.default.removeItem(at: url)\n                call.resolve()");
    expect(swift).not.toMatch(/URLSession|URLRequest/);
    expect(read("ios/App/App/Info.plist")).toContain("3D Scan uses it with the LiDAR sensor to photograph every surface and build a 3D model.");
    expect(read("package.json")).toContain('"three": "^0.186.1"');
  });
  it("the Inspector: the button, the landing (the model uploaded, filed on the job), the tiles open the viewer, drops take a 3D file; the portal spins it", () => {
    const insp = read("src/app/(app)/appointments/[id]/inspector.tsx");
    expect(insp).toContain('onClick={() => void scan3dInto(taskId)}');
    expect(insp).toContain('<Box className="h-4 w-4" /> 3D Scan\n');
    expect(insp).toContain("!readOnly && (canMeasure || scanOn.model) ? (");
    // The old doors are gone from the page too (Erik 2026-10-16); no plan drawing, no site rows.
    for (const gone of ["scanInto(", "scanNative", "scanLanding", "planImageFile", "Scan The Site", "Scan The Room", "Scan In 3D"]) expect(insp).not.toContain(gone);
    const fn = insp.slice(insp.indexOf("async function scan3dInto("), insp.indexOf("/** A COPY of the visit's file"));
    expect(fn).toContain("const r = await scan3dNative();");
    expect(fn).toContain('const stored = await upload([model], { caption: "3D model", about: "3D Scan" });');
    // A failed upload keeps the model (and the shell's copy) for one more tap; the shell's copy goes
    // only after the upload landed; upload()'s own reason is kept, not overwritten.
    expect(fn).toContain("unsentModelRef.current = { model, path };");
    expect(fn).toContain("tap 3D Scan again to send it without scanning.");
    expect(fn).toContain("unsentModelRef.current = null;\n      await discardScan(path);");
    expect(fn).toContain("const filed = await fileOnJob(jobId, stored[0], model.name, model.size);");
    expect(insp).toContain("const is3d = (p: string) => /\\.(usdz|glb|gltf)($|\\?)/i.test(p);");
    expect((insp.match(/onClick=\{\(\) => p\.url && setViewing3d\(p\)\}/g) ?? []).length).toBe(2);
    expect(insp).toContain("{viewing3d?.url && <ModelViewer url={viewing3d.url} name={fileLabel(viewing3d.path)} onClose={() => setViewing3d(null)} />}");
    expect((insp.match(/accept="image\/\*,application\/pdf,\.usdz,\.glb"/g) ?? []).length).toBe(2);
    const portal = read("src/components/portal/portal-documents.tsx");
    expect(portal).toContain("<span>View In 3D</span>");
    expect(portal).toContain('const spins = d.format === "model" && modelKind(d.url) !== null;');
    expect(portal).toContain("{spinning && spins && <ModelViewer url={d.url} name={d.title} onClose={() => setSpinning(false)} />}");
    expect(read("src/app/(app)/jobs/[id]/job-portal-papers.tsx")).toContain('export const PLAN_ACCEPT = "image/*,application/pdf,.usdz,.glb";');
    const viewer = read("src/components/model-viewer.tsx");
    expect(viewer).toContain('await import("three/examples/jsm/loaders/USDLoader.js")');
    expect(viewer).toContain('await import("three/examples/jsm/loaders/GLTFLoader.js")');
    // In the shell, Open In AR is the Quick Look door; in Safari on an iPhone the rel="ar" link; nowhere else.
    expect(viewer).toContain('{kind === "usdz" && inShell ? (');
    expect(viewer).toContain('onClick={() => void openAr()}');
    expect(viewer).toContain('<a rel="ar" href={url}');
    expect(viewer).toContain("const inShell = arPreviewPresent();");
    expect(viewer).toContain("z-[120]");
    // Portaled onto <body> (a fixed box inside the portal's blurred card is clipped to the card);
    // the bar clears the notch; disposal is armed as soon as the context exists and frees it all.
    expect(viewer).toContain("return createPortal(");
    expect(viewer).toContain("document.body,");
    expect(viewer).toContain("pt-[max(0.5rem,var(--sat,0px))]");
    expect(viewer).toContain("renderer.forceContextLoss();");
    expect(viewer.indexOf("dispose = () => {")).toBeLessThan(viewer.indexOf('if (kind === "usdz")'));
    // three.js never in the page's bundle: no static import anywhere, dynamic only in the viewer.
    for (const f of ["src/components/model-viewer.tsx", "src/app/(app)/appointments/[id]/inspector.tsx", "src/components/portal/portal-documents.tsx"]) {
      expect(read(f)).not.toMatch(/^import .* from "three/m);
    }
  });
});
