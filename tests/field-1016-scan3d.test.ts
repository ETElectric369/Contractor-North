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
  it("the Swift door: our own ARKit capture with visible coverage, then the mesh PAINTED from the frames it kept (no photogrammetry), the file served only from its own folder, in pieces", () => {
    const swift = read("ios/App/App/ScanPlugin.swift");
    for (const m of ["isSupported", "scan3d", "readChunk", "discard"]) expect(swift).toContain(`CAPPluginMethod(name: "${m}", returnType: CAPPluginReturnPromise)`);
    // Erik 2026-10-16: the site and room doors are gone; photogrammetry is gone (13 photos gave
    // nothing; Apple's constructor trapped on a sample feed); one door, one plugin, our own painter.
    for (const gone of ["scanSite", "scanRoom", "RoomPlan", "ObjectCaptureSession", "ObjectCaptureView", "SiteScanViewController", "RoomScanViewController", "Photogrammetry", "captureHighResolutionFrame", "AudioServicesPlaySystemSound"]) expect(swift).not.toContain(gone);
    expect(swift).toContain("if #available(iOS 17.0, *) { return lidarPresent }");
    expect(swift).toContain('"3D Scan needs iOS 17 or newer on an iPhone with a LiDAR sensor. Update the iPhone."');
    // The walk: the mesh drawn blue, a frame of the feed kept every 0.3 m / 10° (and on the button),
    // the faces a frame saw (in front, within reach, inside the picture, not behind something per
    // the depth map, else facing the lens by ARKit's normals) left out of the drawing — the clear.
    expect(swift).toContain("config.sceneReconstruction = .mesh");
    expect(swift).toContain("static let moveStep: Float = 0.3");
    expect(swift).toContain("static let turnStep: Float = 10 * .pi / 180");
    expect(swift).toContain("static let maxFrames = 1000");
    expect(swift).toContain('"That\'s the most frames for one scan (\\(Self.maxFrames)) — Finish."');
    expect(swift).toContain('return "Keep going until the blue is gone, then Finish — \\(left) frame\\(left == 1 ? "" : "s") left."');
    expect(swift).toContain("guard moved >= Self.moveStep || turned >= Self.turnStep else { return }");
    expect(swift).toContain('shutter.accessibilityLabel = "Keep This View"');
    // ONE RULE for "this frame saw this face" (skeptic #20): the blue and the painter ask the same
    // function, so the blue never clears where the painter would leave grey.
    expect(swift).toContain("static func score(_ a: simd_float3, _ b: simd_float3, _ c: simd_float3, normal: simd_float3, toCamera: simd_float4x4, eye: simd_float3, k: simd_float3x3, width: Float, height: Float, depth: UnsafeBufferPointer<Float>?, depthWidth: Int, depthHeight: Int) -> Float");
    expect(swift).toContain("if Painter.score(a, b, c, normal: n / len, toCamera: toCamera, eye: eye, k: v.intrinsics, width: v.width, height: v.height, depth: depth, depthWidth: v.depthWidth, depthHeight: v.depthHeight) > 0 {");
    expect(swift).toContain("let v = score(f.a, f.b, f.c, normal: f.normal, toCamera: toCamera, eye: eye, k: kf.intrinsics, width: kf.width, height: kf.height, depth: dp, depthWidth: kf.depthWidth, depthHeight: kf.depthHeight)");
    expect(swift).toContain("guard (frame.smoothedSceneDepth ?? frame.sceneDepth) != nil else { return }");
    expect(swift).toContain("guard p.x.isFinite, p.y.isFinite, p.z.isFinite else { return .min }");
    expect(swift).toContain('private let work = DispatchQueue(label: "north.scan3d.coverage", qos: .userInitiated)');
    expect(swift).toContain("m.diffuse.contents = UIColor(red: 0.25, green: 0.55, blue: 1, alpha: 0.5)");
    expect(swift).toContain("Blue is what the scan still needs; it clears as the camera sees it.");
    expect(swift).toContain("haptic.impactOccurred()");
    // The paint: Finish waits for ten frames AND for every frame to be on disk; each face is given
    // to the frame that saw it best (facing, near, whole face inside, depth-unoccluded) and its
    // atlas cell painted from that frame; the mesh is set down on the floor; the atlas goes in as
    // an image (a file handed to SceneKit's writer on iOS is left out) and the USDZ is read back for it.
    expect(swift).toContain("static let minFrames = 10");
    expect(swift).toContain("guard finishWaiting, !processing, !finished, pendingWrites == 0 else { return }");
    expect(swift).toContain("static func assign(_ faces: [Face], keyframes: [Keyframe], dir: URL, cancelled: Flag, progress: (Double) -> Void) -> Assignment");
    // The best TWO frames per face, the second blended in by its weight (seams fade); each texel the
    // average of the camera pixels under it (no speckle) — Erik 10-16: "distorted on a fine scale".
    expect(swift).toContain("blend[i] = ramp * secondScore[i] / (bestScore[i] + secondScore[i])");
    // Only neighbouring frames blend (drift between far-apart frames paints a doubled edge), ramped
    // by how close the second came; one decode per frame, each frame ADDING its share into a cell
    // that starts black; a 5 × 5 lattice spread over the texel's footprint (skeptic #23).
    expect(swift).toContain("guard apart <= 0.75 else { continue }");
    expect(swift).toContain("let ramp = max(0, min(1, (ratio - 0.5) / 0.3))");
    expect(swift).toContain("guard let img = autoreleasepool(invoking: { rgba(of: dir.appendingPathComponent(kf.image)) }) else {");
    expect(swift).toContain("let share: Float = part == 0 ? 1 - assigned.blend[face] : assigned.blend[face]");
    expect(swift).toContain("let step = perTexel.isFinite ? max(1, Int(perTexel / 5)) : 1");
    expect(swift).toContain("pp[di] = UInt8(min(255, Float(pp[di]) + Float(sr) / count * share).rounded())");
    expect(swift).toContain("@_optimize(speed)\n    static func assign(");
    expect(swift).toContain("@_optimize(speed)\n    static func paint(");
    expect(swift).toContain("return facing / (d + 0.3)");
    expect(swift).toContain("if reading.isFinite, reading > 0, pm.z > reading + 0.08 + 0.06 * pm.z { return 0 }");
    expect(swift).toContain("DispatchQueue.concurrentPerform(iterations: chunks)");
    // SHEETS (Erik 10-16: "the pixels are slightly more distorted than the last one" — one 4096 sheet
    // had shrunk its cells from 12 texels to 8 on a 217-frame scan): a bigger scan gets more sheets,
    // never smaller cells; each sheet its own node + image; the file is read back for them all.
    expect(swift).toContain("static let sheetSize = 4096");
    expect(swift).toContain("static let cellSize = 16");
    expect(swift).toContain("static let inset = 2");
    expect(swift).toContain("return Atlas(size: sheetSize, cell: cellSize, sheets: (Swift.max(1, n) + perSheet - 1) / perSheet)");
    expect(swift).toContain("func slot(_ i: Int) -> (sheet: Int, x: Int, y: Int)");
    // The last sheet is only as tall as its rows; v runs over that height; the sheet's number sits
    // in its last texel so no two sheets are byte-identical (the writer packs each — Mac check,
    // three nodes, two identical pictures → three PNGs); 24-bit; four sheets at most, and a model
    // over the page's cap is refused on the phone in words (skeptic #22).
    expect(swift).toContain("func height(of sheet: Int, cells count: Int) -> Int");
    expect(swift).toContain("uv.append(simd_float2((cx + o) / a, (cy + o) / h))");
    // PAIRS (Erik 10-16 on the blended model: faint lines along the walls; and 425,654 faces on a
    // "little more area", 94% of the cap): two faces that share an edge take ONE cell of sixteen,
    // the shared edge on the diagonal, each face's triangle two texels in — the viewer's 2 × 2 and
    // 4 × 4 blocks tile a cell of sixteen exactly, so they never mix the next cell into an edge;
    // the vertices are turned, never mirrored; a pair wound the same way round stays two cells; the
    // faces come in cell order; the last column of texels stays free for the sheet's stamp.
    expect(swift).toContain("static func lay(_ faces: [Face], tri: [simd_uint3], from cell: Int) -> (faces: [Face], next: Int)");
    expect(swift).toContain("var perRow: Int { (size - 1) / cell }");
    expect(swift).toContain("static func atlas(forCells n: Int) -> Atlas");
    expect(swift).toContain("func faces(on sheet: Int, of faces: [Face]) -> Range<Int>");
    expect(swift).toContain("let je = u.x == q && u.y == p ? 0 : u.y == q && u.z == p ? 1 : u.z == q && u.x == p ? 2 : -1");
    expect(swift).toContain("guard je >= 0 else { return false }");
    expect(swift).toContain("case 0: return (f.c, f.a, f.b, f.nc, f.na, f.nb)");
    expect(swift).toContain("default: return (f.b, f.c, f.a, f.nb, f.nc, f.na)");
    expect(swift).toContain("if half == 1 { if tx + ty >= cell { continue } } else if half == 2 { if tx + ty < cell { continue } }");
    expect(swift).toContain("if half == 2 { b1 = 1 - b1; b2 = 1 - b2 }");
    expect(swift).toContain("let span = Float(max(1, cell - 2 * inset))");
    expect(swift).toContain("let from = f.half == 2 ? cell - ty : 0");
    expect(swift).toContain("let to = f.half == 1 ? cell - ty : cell");
    expect(swift).toContain("uv.append(simd_float2((cx + n - o) / a, (cy + n - o) / h))");
    expect(swift).toContain("let laid = Painter.lay(raw, tri: tri, from: cells)");
    expect(swift).toContain("let atlas = Painter.atlas(forCells: cells)");
    expect(swift).toContain("tri.append(simd_uint3(ia, jb, jc))");
    expect(swift).not.toContain("atlas(forFaces");
    // Skeptic #24: the sheets stay bounded however the faces paired; a face can't be its own mate;
    // a face with a repeated vertex (no area) is dropped where the faces are read.
    expect(swift).toContain("static let maxSheets = 4");
    expect(swift).toContain("guard atlas.sheets <= Painter.maxSheets else {");
    expect(swift).toContain("guard j >= 0, j != i, mate[j] < 0 else { return false }");
    expect(swift).toContain("guard ia != ib, ib != ic, ic != ia, len > 0, simd_length(a).isFinite");
    expect(swift).toContain("bytes[count - 4] = UInt8(truncatingIfNeeded: index + 1)");
    expect(swift).toContain("CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue");
    expect(swift).toContain("static let maxFaces = 450_000");
    expect(swift).toContain("static let maxModelBytes = 200_000_000");
    expect(MODEL_MAX_BYTES).toBe(200_000_000);
    expect(swift).toContain("guard bytes <= Painter.maxModelBytes else {");
    expect(swift).toContain("let bases = sheets.map { $0.bytes }");
    expect(swift).toContain("static func paint(_ faces: [Face], assigned: Assignment, keyframes: [Keyframe], dir: URL, atlas: Atlas, cancelled: Flag, progress: (Double) -> Void) -> [Sheet]");
    expect(swift).toContain("let data = Data(bytesNoCopy: UnsafeMutableRawPointer(bytes), count: width * height * 4, deallocator: .custom { p, _ in p.deallocate() })");
    expect(swift).toContain("deinit { if !handed { bytes.deallocate() } }");
    expect(swift).toContain("static func geometry(_ faces: [Face], atlas: Atlas, sheet: Int, texture: Any) -> SCNGeometry");
    expect(swift).toContain("scene.rootNode.addChildNode(SCNNode(geometry: Painter.geometry(faces, atlas: atlas, sheet: sheet, texture: image)))");
    expect(swift).toContain('fail("This scan is too big to paint on this phone. Scan a smaller area.")');
    expect(swift).toContain("let floor = ys.isEmpty ? lo.y : ys[min(ys.count - 1, ys.count / 100)]");
    expect(swift).toContain("if simd_dot(simd_cross(b - a, c - a), n) < 0 { swap(&b, &c); swap(&jb, &jc); swap(&nb, &nc) }");
    // SMOOTH NORMALS + LEVELLING (Erik 10-16 on the paired model: fine vertical stripes on the walls
    // = the mesh grid shaded flat face by face; a quilt of lighter and darker patches = the camera's
    // exposure drifting between frames). Each vertex keeps ARKit's own normal; every face two frames
    // saw measures how the frames differ, one gain per frame and channel is solved from all of them
    // (log space, relaxation, mean held at 1, within a half and double) and each face's texels are
    // scaled by its frames' gains mixed as its colours were.
    expect(swift).toContain("nor.append(f.na); nor.append(f.nb); nor.append(f.nc)");
    expect(swift).toContain("static func level(assigned: Assignment, frames: Int, meanBest: [simd_float3], meanSecond: [simd_float3]) -> (gains: [simd_float3], ties: Int, before: Float, after: Float)?");
    expect(swift).toContain("static func apply(_ gains: [simd_float3], to faces: [Face], assigned: Assignment, atlas: Atlas, bases: [UnsafeMutablePointer<UInt8>])");
    expect(swift).toContain("sum[bi] += L[si] + d[i]");
    expect(swift).toContain("sum[si] += L[bi] - d[i]");
    expect(swift).toContain("let measureOnly = share <= 0");
    expect(swift).toContain("if second >= 0 { bySecond[Int(second)].append(face) }");
    expect(swift).toContain("if part == 0 { mb[face] = mean } else { ms[face] = mean }");
    expect(swift).toContain("if second >= 0, blend > 0 { g = g * (1 - blend) + gains[Int(second)] * blend }");
    expect(swift).toContain('NSLog("[Scan3D] levelled %d frames from %d faces seen twice: gains %.2f to %.2f, mismatch %.3f to %.3f"');
    expect(swift).toContain('NSLog("[Scan3D] frames left alone: %d faces seen twice, mismatch %.3f to %.3f"');
    // Skeptic #25: both frames measured on the same texels; observations too dark, too bright or
    // further apart than double are left out; the solve must close the gaps by a fifth or the frames stay.
    expect(swift).toContain("if tx % 4 == 0, ty % 4 == 0 { tr += Float(sr) / count; tg += Float(sg) / count; tb += Float(sb) / count; tn += 1 }");
    expect(swift).toContain("guard min(mb.x, mb.y, mb.z, ms.x, ms.y, ms.z) >= 20, max(mb.x, mb.y, mb.z, ms.x, ms.y, ms.z) <= 250 else { continue }");
    expect(swift).toContain("guard max(abs(di.x), abs(di.y), abs(di.z)) <= log(Float(2)) else { continue }");
    expect(swift).toContain("if levelled.after <= levelled.before * 0.8 {");
    expect(swift).toContain("guard seen * 20 >= faces.count else {");
    // SceneKit's texture space is top-down (checked on the Mac, 10-16: v 0.2/0.8 in → USD 0.8/0.2
    // out); the atlas rows are top-down too, so v = y / A — the first painted model wore every
    // other face's patch with "1 -".
    expect(swift).not.toContain("1 - (cy + 1) / a");
    // An interruption starts the scan over for real: the session, the mesh, the frames.
    expect(swift).toContain("meshes.removeAll()\n        snaps.removeAll()\n        dirty.removeAll()\n        meshSeen = false\n        keyframes.removeAll()");
    expect(swift).not.toContain("jpegData(compressionQuality: 0.95)");
    // The texture goes in as an image (the file form never carried) and the USDZ is read back for it.
    expect(swift).toContain("guard let image = sheet.image() else {");
    expect(swift).not.toContain("textureURL");
    expect(swift).toContain("let wrote = scene.write(to: output, options: nil, delegate: nil, progressHandler: nil)");
    expect(swift).toContain("static func images(in url: URL) -> Int");
    expect(swift).toContain("guard Painter.images(in: output) >= atlas.sheets else {");
    expect(swift).toContain('"shots": frames.count, "faces": faces.count, "sheets": atlas.sheets]');
    expect(swift).toContain('fail("The model was written without its picture. Try again.")');
    // v3.1 (Erik: the counter stopped at 99 and "i dont think it was capturing anymore"): the camera's
    // picture is copied out of ARKit's pool at once; a frame visits only the anchors in its reach and
    // only the anchors whose blue changed are redrawn; the Debug build on the phone is optimized.
    expect(swift).toContain("guard let image = Self.clone(frame.capturedImage) else {");
    expect(swift).toContain("static func clone(_ src: CVPixelBuffer) -> CVPixelBuffer?");
    expect(swift).toContain("private func mark(_ v: ShotView, over snaps: [MeshSnap]) -> [UUID]");
    expect(swift).toContain("if simd_length(toward) - snap.radius > Painter.reach { continue }");
    expect(swift).toContain("if simd_dot(toward, ahead) < -snap.radius { continue }");
    // A pass that cleared any cell redraws every anchor it visited (a face's cell may have been
    // cleared by another anchor's face, now or earlier — skeptic #21); one reach for blue and paint.
    expect(swift).toContain("return cleared ? visited : []");
    expect(swift).toContain("static let reach: Float = 6");
    expect(swift).toContain("guard d > 0.15, d < reach else { return 0 }");
    expect(swift).toContain("DispatchQueue.main.async { self.redraw(changed) }");
    expect(swift).not.toContain("redrawAll");
    // The copied picture keeps ARKit's colour tags and an IOSurface (skeptic #21); a camera that
    // goes quiet for two seconds is said on the screen and in the log — never silent.
    expect(swift).toContain("CVBufferPropagateAttachments(src, dst)");
    expect(swift).toContain("kCVPixelBufferIOSurfacePropertiesKey");
    expect(swift).toContain('NSLog("[Scan3D] no camera frame for %.1f s at %d frames", quiet, self.keyframes.count)');
    expect(swift).toContain('say("The camera stopped sending pictures — hold on; if it stays stopped, Cancel and scan again")');
    expect(swift).toContain("lastFrameSeen = CACurrentMediaTime()\n        if stalled {");
    const pbx = read("ios/App/App.xcodeproj/project.pbxproj");
    expect(pbx).toContain('SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;\n\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-O";');
    expect(pbx).not.toContain("-Onone");
    expect(swift).toContain("m.lightingModel = .physicallyBased");
    expect(swift).toContain("@_optimize(speed)");
    // Kept from the earlier cuts (skeptics #18/#19): the phone must not lock; Cancel with work
    // done asks; an outcome before the screen is up waits for it; the presenter dismisses; a
    // failed capture drops its frames; stale scans sweep; the file is served only from the scan
    // folder, in pieces; no network.
    expect(swift).toContain("UIApplication.shared.isIdleTimerDisabled = true");
    expect(swift).toContain("UIApplication.shared.isIdleTimerDisabled = false");
    expect(swift).toContain('UIAlertAction(title: "Drop It", style: .destructive)');
    expect(swift).toContain("guard appeared else {\n            if pendingOutcome == nil { pendingOutcome = outcome }\n            return\n        }");
    expect(swift).toContain("(presentingViewController ?? self).dismiss(animated: true) { [done] in done(outcome) }");
    expect(swift).toContain("static func sweepOldScans()");
    expect(swift).toContain('"path": output.path');
    expect(swift).toContain('guard url.path.hasPrefix(folder + "/"), url.pathExtension.lowercased() == "usdz" else { return nil }');
    expect(swift).toContain('"mime": "model/vnd.usdz+zip", "shots": frames.count');
    expect(swift).toContain("let length = min(max(1, call.getInt(\"length\") ?? 2_000_000), 4_000_000)");
    expect(swift).toContain("paintCancelled.set()");
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
