/**
 * SCAN IN 3D (LiDAR rung 2, the picture). Erik 2026-10-16, after Polycam: "collect all of the
 * pixels for all surfaces and render an image … i want that." Apple's capture view takes the photos,
 * the phone builds the textured model, the file comes over the bridge in pieces, lands on the task
 * as a 3D file, and the tile (and the portal's 3D Scan slot) opens it in the in-app viewer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { bytesOf, CHUNK_BYTES, discardScan, MODEL_MAX_BYTES, pullFile, scan3dNative, scanDoors, USDZ_MIME } from "@/lib/native-scan";
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
    expect(await scan3dNative()).toEqual({ ok: false, refused: "Scan In 3D needs the North app on an iPhone with a LiDAR sensor." });
    const f = fakeFile(5000);
    const off = shell({ Scan: { ...f.plugin, isSupported: async () => ({ site: true, room: true, model: true }) } });
    try {
      expect(await scanDoors()).toEqual({ site: true, room: true, model: true });
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
    const off3 = shell({ Scan: { ...f.plugin, scan3d: async () => { throw new Error("Scan In 3D needs iOS 17 or newer on an iPhone with a LiDAR sensor. Update the iPhone, or Scan The Room."); } } });
    try {
      expect(await scan3dNative()).toEqual({ ok: false, refused: "Scan In 3D needs iOS 17 or newer on an iPhone with a LiDAR sensor. Update the iPhone, or Scan The Room." });
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

describe("the wiring, pinned", () => {
  it("the Swift door: Object Capture + photogrammetry on the phone, area masking off, the file served only from its own folder, in pieces", () => {
    const swift = read("ios/App/App/ScanPlugin.swift");
    for (const m of ["scan3d", "readChunk", "discard"]) expect(swift).toContain(`CAPPluginMethod(name: "${m}", returnType: CAPPluginReturnPromise)`);
    expect(swift).toContain("ObjectCaptureSession.isSupported && PhotogrammetrySession.isSupported");
    expect(swift).toContain("session.start(imagesDirectory: imagesDir, configuration: config)");
    expect(swift).toContain("config.isObjectMaskingEnabled = false");
    // Skeptic #18: an AREA capture starts straight from ready (no detection step, iOS 18); Finish
    // waits for ten photos; the phone must not lock; Cancel with work done asks; a failure before
    // the screen is up is said once it is; the build's errors are plain sentences; stale scans sweep.
    expect(swift).toContain('Button("Start Capture") { session.startCapturing() }');
    expect(swift).not.toContain("startDetecting()");
    expect(swift).toContain("static let minShots = 10");
    expect(swift).toContain("if case .capturing = state, shots >= Self.minShots {");
    expect(swift).toContain("UIApplication.shared.isIdleTimerDisabled = true");
    expect(swift).toContain("UIApplication.shared.isIdleTimerDisabled = false");
    expect(swift).toContain('UIAlertAction(title: "Drop It", style: .destructive)');
    expect(swift).toContain("if let pendingFailure { finish(.failed(pendingFailure)) }");
    expect(swift).toContain("static func buildSentence(_ error: Error) -> String");
    expect(swift).toContain("static func sweepOldScans()");
    expect(swift).toContain('"path": output.path');
    expect(swift).toContain("config.isOverCaptureEnabled = false");
    expect(swift).toContain('"Scan In 3D needs iOS 18 or newer');
    expect(swift).toContain("try photo.process(requests: [.modelFile(url: output, detail: .reduced)])");
    expect(swift).toContain('guard url.path.hasPrefix(folder + "/"), url.pathExtension.lowercased() == "usdz" else { return nil }');
    expect(swift).toContain('"mime": "model/vnd.usdz+zip", "shots": shots');
    expect(swift).toContain("let length = min(max(1, call.getInt(\"length\") ?? 2_000_000), 4_000_000)");
    expect(swift).toContain("ObjectCaptureView(session: session)");
    expect(swift).toContain("if processing { photo?.cancel() } else { session.cancel() }");
    expect(swift).not.toMatch(/URLSession|URLRequest/);
    expect(read("package.json")).toContain('"three": "^0.186.1"');
  });
  it("the Inspector: the button, the landing (the model uploaded, filed on the job), the tiles open the viewer, drops take a 3D file; the portal spins it", () => {
    const insp = read("src/app/(app)/appointments/[id]/inspector.tsx");
    expect(insp).toContain('onClick={() => void scan3dInto(taskId)}');
    expect(insp).toContain("Scan In 3D\n");
    expect(insp).toContain("!readOnly && (canMeasure || scanOn.site || scanOn.room || scanOn.model) ? (");
    const fn = insp.slice(insp.indexOf("async function scan3dInto("), insp.indexOf("/** A COPY of the visit's file"));
    expect(fn).toContain("const r = await scan3dNative();");
    expect(fn).toContain('const stored = await upload([model], { caption: "3D model", about: "Scan In 3D" });');
    // A failed upload keeps the model (and the shell's copy) for one more tap; the shell's copy goes
    // only after the upload landed; upload()'s own reason is kept, not overwritten.
    expect(fn).toContain("unsentModelRef.current = { model, path };");
    expect(fn).toContain("tap Scan In 3D again to send it without scanning.");
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
    expect(viewer).toContain('<a rel="ar" href={url}');
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
