/**
 * SCAN THE SITE / SCAN THE ROOM (LiDAR rung 2). Erik 2026-10-16: "go for the scan … not being able
 * to scan outside is what my brother specifically asked for." Outdoors the shell walks the footprint
 * (tapped corners over the LiDAR mesh); indoors Apple's RoomPlan does the walk. The page turns the
 * meters into feet, draws a to-scale plan with every side labeled, lands the rows on the task and
 * the plan + the USDZ beside them, and files the USDZ on the job when the visit is on one. Every
 * number is a tapped corner or a RoomPlan wall — never a guess off the mesh.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { bytesFile, planPointOf, roomScanOf, scanDoors, scanNative, scanPluginPresent, siteScanOf, USDZ_MIME } from "@/lib/native-scan";
import { cornerLetter, fitPlan, PLAN_HEIGHT, PLAN_WIDTH, roomPlanSvg, sideLabel, sitePlanSvg } from "@/lib/scan/plan-svg";
import { scanLanding } from "@/lib/scan/landing";

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

const b64 = Buffer.from("x".repeat(200)).toString("base64");

/** A 3 m square, walked A→B→C→D, in the plugin's meters. */
const SQUARE = {
  ok: true,
  kind: "site",
  corners: [[0, 0, 0], [3, 0, 0], [3, 0, 3], [0, 0, 3]],
  sides: [3, 3, 3, 3],
  squareMeters: 9,
  perimeterMeters: 12,
  lidar: true,
};

const ROOM = {
  ok: true,
  kind: "room",
  walls: [
    { meters: 4, height: 2.5, a: [0, 0], b: [4, 0] },
    { meters: 3, height: 2.5, a: [4, 0], b: [4, 3] },
    { meters: 4, height: 2.4, a: [4, 3], b: [0, 3] },
    { meters: 3, height: 2.5, a: [0, 3], b: [0, 0] },
  ],
  doors: 1,
  windows: 2,
  openings: 0,
  tallestWallMeters: 2.5,
  floorCorners: [[0, 0], [4, 0], [4, 3], [0, 3]],
  floorSquareMeters: 12,
};

describe("the bridge's numbers: meters to feet, a plan point from x and z", () => {
  it("a world point is a plan point: x across, z down the page, feet to two decimals", () => {
    expect(planPointOf([1, 2, 3])).toEqual({ x: 3.28, y: 9.84 });
    expect(planPointOf([1, 3])).toEqual({ x: 3.28, y: 9.84 });
    expect(planPointOf([1])).toBeNull();
    expect(planPointOf("1,2,3")).toBeNull();
  });
  it("a site: corners, every side, area and perimeter in feet; the files typed; the note kept", () => {
    const s = siteScanOf({ ...SQUARE, model: b64, modelNote: "  The 3D file holds the 4 pieces nearest the footprint.  " }, 5);
    expect(s).not.toBeNull();
    expect(s!.corners).toEqual([{ x: 0, y: 0 }, { x: 9.84, y: 0 }, { x: 9.84, y: 9.84 }, { x: 0, y: 9.84 }]);
    expect(s!.sides).toEqual([9.84, 9.84, 9.84, 9.84]);
    expect(s!.area).toBe(96.9);
    expect(s!.perimeter).toBe(39.37);
    expect(s!.photo).toBeNull();
    expect(s!.model?.type).toBe(USDZ_MIME);
    expect(s!.model?.name).toBe("site-scan-5.usdz");
    expect(s!.modelNote).toBe("The 3D file holds the 4 pieces nearest the footprint.");
  });
  it("a site that is not a footprint is null: two corners, sides that don't match the corners, no area", () => {
    expect(siteScanOf({ ...SQUARE, corners: SQUARE.corners.slice(0, 2), sides: [3, 3] })).toBeNull();
    expect(siteScanOf({ ...SQUARE, sides: [3, 3, 3] })).toBeNull();
    expect(siteScanOf({ ...SQUARE, squareMeters: 0 })).toBeNull();
    expect(siteScanOf({ ...SQUARE, corners: [[0, 0, 0], ["a", 0, 0], [3, 0, 3]] , sides: [1, 1, 1] })).toBeNull();
  });
  it("a room: walls with both ends, counts, the ceiling, the floor where iOS gave one", () => {
    const r = roomScanOf({ ...ROOM, model: b64 }, 7);
    expect(r).not.toBeNull();
    expect(r!.walls).toHaveLength(4);
    expect(r!.walls[0]).toEqual({ length: 13.12, height: 8.2, a: { x: 0, y: 0 }, b: { x: 13.12, y: 0 } });
    expect(r!.doors).toBe(1);
    expect(r!.windows).toBe(2);
    expect(r!.tallestWall).toBe(8.2);
    expect(r!.floorCorners).toHaveLength(4);
    expect(r!.floorArea).toBe(129.2);
    expect(r!.model?.name).toBe("room-scan-7.usdz");
    // No floor at all (iOS 16): no outline, no area. Two floors (iOS 17): the areas summed, no outline.
    const bare = roomScanOf({ ...ROOM, floorCorners: undefined, floorSquareMeters: undefined });
    expect(bare!.floorCorners).toBeNull();
    expect(bare!.floorArea).toBeNull();
    const two = roomScanOf({ ...ROOM, floorCorners: undefined, floorSquareMeters: 20 });
    expect(two!.floorCorners).toBeNull();
    expect(two!.floorArea).toBe(215.3);
    // A wall without an end is skipped; a room without a wall is null.
    expect(roomScanOf({ ...ROOM, walls: [{ meters: 4, height: 2.5, a: [0, 0] }] })).toBeNull();
    expect(roomScanOf({ ...ROOM, walls: [] })).toBeNull();
  });
  it("bytes become a File of the given type; junk is null — and bytes that came but did not decode are SAID", () => {
    expect(bytesFile(b64, USDZ_MIME, "a.usdz")?.type).toBe(USDZ_MIME);
    expect(bytesFile("short", USDZ_MIME, "a.usdz")).toBeNull();
    expect(bytesFile(12, USDZ_MIME, "a.usdz")).toBeNull();
    const s = siteScanOf({ ...SQUARE, model: "short" })!;
    expect(s.model).toBeNull();
    expect(s.modelNote).toBe("The 3D file came back unreadable; the plan and the measurements did.");
    expect(siteScanOf(SQUARE)!.modelNote).toBeNull();
  });
});

describe("the bridge: doors only where the plugin says so; a cancel is a cancel; a refusal is a sentence", () => {
  afterEach(() => {
    shellOn = false;
  });
  it("no plugin: no door, no scan", async () => {
    expect(scanPluginPresent()).toBe(false);
    expect(await scanDoors()).toEqual({ site: false, room: false, model: false });
    expect(await scanNative("site")).toEqual({ ok: false, refused: "Scanning needs the North app on an iPhone with a LiDAR sensor." });
  });
  it("the plugin's own answer on what this phone can do; a throw is no doors", async () => {
    const off = shell({ Scan: { scanSite: async () => SQUARE, isSupported: async () => ({ site: true, room: false }) } });
    try {
      expect(scanPluginPresent()).toBe(true);
      expect(await scanDoors()).toEqual({ site: true, room: false, model: false });
    } finally {
      off();
    }
    const off2 = shell({ Scan: { scanSite: async () => SQUARE, isSupported: async () => { throw new Error("x"); } } });
    try {
      expect(await scanDoors()).toEqual({ site: false, room: false, model: false });
    } finally {
      off2();
    }
  });
  it("a site comes back in feet; a room too; cancelled → {cancelled}; a rejection → its sentence; a payload with no footprint → refused in words", async () => {
    const off = shell({
      Scan: {
        scanSite: async () => SQUARE,
        scanRoom: async () => ROOM,
      },
    });
    try {
      const s = await scanNative("site");
      expect(s.ok && s.kind === "site" && s.area === 96.9).toBe(true);
      const r = await scanNative("room");
      expect(r.ok && r.kind === "room" && r.walls.length === 4).toBe(true);
    } finally {
      off();
    }
    const off2 = shell({ Scan: { scanSite: async () => ({ ok: false, cancelled: true }), scanRoom: async () => { throw new Error("Scan The Room needs iOS 16 or newer. Update the iPhone, or Scan The Site."); } } });
    try {
      expect(await scanNative("site")).toEqual({ ok: false, cancelled: true });
      expect(await scanNative("room")).toEqual({ ok: false, refused: "Scan The Room needs iOS 16 or newer. Update the iPhone, or Scan The Site." });
    } finally {
      off2();
    }
    const off3 = shell({ Scan: { scanSite: async () => ({ ok: true, kind: "site", corners: [] }) } });
    try {
      expect(await scanNative("site")).toEqual({ ok: false, refused: "The scan came back without a footprint — tap at least three corners next time." });
    } finally {
      off3();
    }
  });
});

describe("the plan drawing: to scale, every side labeled, corners lettered, a scale bar, the figures in the footer", () => {
  it("one scale both ways, inside the margins", () => {
    const f = fitPlan([{ x: 0, y: 0 }, { x: 40, y: 10 }]);
    expect(f.scale).toBeCloseTo((PLAN_WIDTH - 240) / 40, 6);
    expect(f.ox + 0 * f.scale).toBeGreaterThanOrEqual(120);
    expect(f.ox + 40 * f.scale).toBeLessThanOrEqual(PLAN_WIDTH - 120);
    expect(f.oy + 10 * f.scale).toBeLessThanOrEqual(PLAN_HEIGHT - 90 - 120);
    const tall = fitPlan([{ x: 0, y: 0 }, { x: 5, y: 60 }]);
    expect(tall.scale).toBeCloseTo((PLAN_HEIGHT - 240 - 90) / 60, 6);
  });
  it("a site plan carries the polygon, four side labels, letters A–D, the 10 ft bar and the area footer; a title is escaped", () => {
    const svg = sitePlanSvg({ title: "Site plan — <Oct 16>", corners: [{ x: 0, y: 0 }, { x: 9.84, y: 0 }, { x: 9.84, y: 9.84 }, { x: 0, y: 9.84 }], sides: [9.84, 9.84, 9.84, 9.84], area: 96.9, perimeter: 39.37 });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain("<polygon points=");
    expect((svg.match(/>9 ft 10\.1 in</g) ?? []).length).toBe(4);
    for (const l of ["A", "B", "C", "D"]) expect(svg).toContain(`>${l}</text>`);
    expect(svg).toContain(">1 ft</text>");
    expect(svg).toContain("Area 96.9 sq ft · 39 ft 4.4 in around");
    expect(svg).toContain("Site plan — &lt;Oct 16&gt;");
    expect(() => sitePlanSvg({ title: "x", corners: [{ x: 0, y: 0 }, { x: 1, y: 1 }], sides: [1, 1], area: 1, perimeter: 2 })).toThrow();
    // A big footprint gets the 10 ft bar.
    const big = sitePlanSvg({ title: "x", corners: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }], sides: [60, 40, 72.1], area: 1200, perimeter: 172.1 });
    expect(big).toContain(">10 ft</text>");
  });
  it("a room plan draws every wall as a labeled segment, shades the floor when it has one, and says the counts", () => {
    const walls = [
      { length: 13.12, a: { x: 0, y: 0 }, b: { x: 13.12, y: 0 } },
      { length: 9.84, a: { x: 13.12, y: 0 }, b: { x: 13.12, y: 9.84 } },
    ];
    const svg = roomPlanSvg({ title: "Room", walls, floorCorners: [{ x: 0, y: 0 }, { x: 13.12, y: 0 }, { x: 13.12, y: 9.84 }], floorArea: 64.6, tallestWall: 8.2, doors: 1, windows: 2 });
    expect((svg.match(/<line x1=/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(svg).toContain(">1: 13 ft 1.4 in<");
    expect(svg).toContain(">2: 9 ft 10.1 in<");
    expect(svg).toContain('fill="#f1f5f9"');
    expect(svg).toContain("Floor 64.6 sq ft · Tallest wall 8 ft 2.4 in · 1 door · 2 windows");
    const bare = roomPlanSvg({ title: "Room", walls, floorCorners: null, floorArea: null, tallestWall: null, doors: 0, windows: 0 });
    expect(bare).not.toContain('fill="#f1f5f9"');
    expect(bare).toContain("0 doors · 0 windows");
    expect(() => roomPlanSvg({ title: "x", walls: [], floorCorners: null, floorArea: null, tallestWall: null, doors: 0, windows: 0 })).toThrow();
  });
  it("every side label sits OUTSIDE the figure and inside the page — on an L-shaped deck too (skeptic #17)", () => {
    const L = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 }];
    for (const corners of [L, [...L].reverse(), [{ x: 0, y: 0 }, { x: 9.84, y: 0 }, { x: 9.84, y: 9.84 }, { x: 0, y: 9.84 }]]) {
      const n = corners.length;
      const sides = corners.map((a, i) => Math.hypot(corners[(i + 1) % n].x - a.x, corners[(i + 1) % n].y - a.y));
      const svg = sitePlanSvg({ title: "L", corners, sides, area: 300, perimeter: sides.reduce((s, x) => s + x, 0) });
      const poly = /<polygon points="([^"]+)"/.exec(svg)![1].split(" ").map((p) => p.split(",").map(Number) as [number, number]);
      const inside = (x: number, y: number) => {
        let on = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [xi, yi] = poly[i], [xj, yj] = poly[j];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) on = !on;
        }
        return on;
      };
      const labels = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="middle" dominant-baseline="middle" font-size="26"/g)].map((m) => [Number(m[1]), Number(m[2])]);
      expect(labels).toHaveLength(n);
      for (const [x, y] of labels) {
        expect(inside(x, y)).toBe(false);
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(PLAN_WIDTH);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(PLAN_HEIGHT);
      }
    }
  });
  it("corner letters run A…Z then AA…; a side reads in feet and inches", () => {
    expect(cornerLetter(0)).toBe("A");
    expect(cornerLetter(23)).toBe("Z");
    expect(cornerLetter(24)).toBe("AA");
    expect(cornerLetter(25)).toBe("AB");
    expect(sideLabel(9.84)).toBe("9 ft 10.1 in");
    expect(sideLabel(0.5)).toBe("6 in");
  });
});

describe("what lands: the rows, the plan, the caption", () => {
  const when = new Date(2026, 9, 16, 5, 0, 0);
  it("a site lands its area, its perimeter and every lettered side; the plan wears the headline", () => {
    const s = siteScanOf(SQUARE)!;
    const l = scanLanding(s, when);
    expect(l.rows).toEqual([
      { label: "Site area", value: 96.9, unit: "sq ft" },
      { label: "Site perimeter", value: 39.37, unit: "ft" },
      { label: "Side A–B", value: 9.84, unit: "ft" },
      { label: "Side B–C", value: 9.84, unit: "ft" },
      { label: "Side C–D", value: 9.84, unit: "ft" },
      { label: "Side D–A", value: 9.84, unit: "ft" },
    ]);
    expect(l.caption).toBe("Site plan — 96.9 sq ft, 39 ft 4.4 in around");
    expect(l.about).toBe("Scan The Site");
    expect(l.name).toBe(`site-plan-${when.getTime()}`);
    expect(l.svg).toContain("Site plan — Oct 16, 2026");
  });
  it("a room lands every wall, the ceiling, the floor area where known, and the counts it saw (never a zero row)", () => {
    const r = roomScanOf(ROOM)!;
    const l = scanLanding(r, when);
    expect(l.rows.map((x) => x.label)).toEqual(["Wall 1", "Wall 2", "Wall 3", "Wall 4", "Tallest wall", "Floor area", "Doors", "Windows"]);
    expect(l.rows.find((x) => x.label === "Doors")).toEqual({ label: "Doors", value: 1, unit: "each" });
    expect(l.caption).toBe("Room plan — 4 walls, 129.2 sq ft, 8 ft 2.4 in tallest wall");
    expect(l.about).toBe("Scan The Room");
    const bare = scanLanding(roomScanOf({ ...ROOM, floorCorners: undefined, floorSquareMeters: undefined, doors: 0, windows: 0 })!, when);
    expect(bare.rows.map((x) => x.label)).toEqual(["Wall 1", "Wall 2", "Wall 3", "Wall 4", "Tallest wall"]);
    expect(bare.caption).toBe("Room plan — 4 walls, 8 ft 2.4 in tallest wall");
  });
});

describe("the stored row keeps its scan tag", () => {
  it("parseInspectorCapture keeps scan: site | room and drops anything else", async () => {
    const { parseInspectorCapture } = await import("@/lib/inspection/capture");
    const c = parseInspectorCapture({
      notes: "", measurements: "", materials: "", photos: [],
      measures: [
        { id: "a", label: "Wall 1", value: 12, unit: "ft", scan: "room" },
        { id: "b", label: "Side A–B", value: 9.84, unit: "ft", scan: "site", task_id: "t1" },
        { id: "c", label: "Typed", value: 3, unit: "ft", scan: "other" },
        { id: "d", label: "Measured length", value: 3.25, unit: "ft" },
      ],
    });
    expect(c.measures).toEqual([
      { id: "a", label: "Wall 1", value: 12, unit: "ft", scan: "room" },
      { id: "b", label: "Side A–B", value: 9.84, unit: "ft", task_id: "t1", scan: "site" },
      { id: "c", label: "Typed", value: 3, unit: "ft" },
      { id: "d", label: "Measured length", value: 3.25, unit: "ft" },
    ]);
  });
});

describe("the wiring, pinned", () => {
  it("the Swift plugin: two doors, the mesh kept, corners from the tapped circle, the USDZ written by SceneKit / RoomPlan, no network", () => {
    const swift = read("ios/App/App/ScanPlugin.swift");
    expect(swift).toContain('public let jsName = "Scan"');
    for (const m of ["isSupported", "scanSite", "scanRoom"]) expect(swift).toContain(`CAPPluginMethod(name: "${m}", returnType: CAPPluginReturnPromise)`);
    expect(swift).toContain("ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)");
    expect(swift).toContain("config.sceneReconstruction = .mesh");
    expect(swift).toContain("if let on = sceneView.hitTest(center, options: [.categoryBitMask: Self.meshMask");
    expect(swift).toContain("static let maxFaces = 150_000");
    expect(swift).toContain("scene.write(to: url, options: nil, delegate: nil, progressHandler: nil)");
    expect(swift).toContain('"modelMime"] = "model/vnd.usdz+zip"');
    expect(swift).toContain("guard trackingNormal else {");
    expect(swift).toContain("func sessionWasInterrupted(_ session: ARSession) {\n        trackingNormal = false\n        clearCorners()");
    expect(swift).toContain("func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { false }");
    expect(swift).toContain("@available(iOS 16.0, *)\nfinal class RoomScanViewController");
    expect(swift).toContain("RoomCaptureSession.isSupported");
    expect(swift).toContain("try room.export(to: url, exportOptions: .mesh)");
    // Skeptic #17: Done freezes the corners while the file builds; the tallest wall is called that;
    // every floor is summed; RoomPlan's callbacks hop to main; a build that never ends is said.
    expect(swift).toContain("private var building = false");
    expect(swift).toContain("guard !finished, !building, let fp = footprint else { return }");
    expect(swift).toContain("guard !finished, !building, !corners.isEmpty else { return }");
    expect(swift).toContain("doneButton.isEnabled = fp != nil && !building");
    expect(swift).toContain('"tallestWallMeters": tallest');
    expect(swift).not.toContain("ceilingMeters");
    expect(swift).toContain("let floors = room.floors.filter { $0.polygonCorners.count >= 3 }");
    expect(swift).toContain("if outlines.count == 1, let one = outlines.first");
    expect(swift).toContain("DispatchQueue.main.asyncAfter(deadline: .now() + 90)");
    expect((swift.match(/DispatchQueue\.main\.async \{ \[weak self\] in/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(swift).toContain('call.resolve(["ok": false, "cancelled": true])');
    expect(swift).not.toMatch(/URLSession|URLRequest/);
    expect(read("ios/App/App/NorthBridgeViewController.swift")).toContain("bridge?.registerPluginInstance(ScanPlugin())");
    const pbx = read("ios/App/App.xcodeproj/project.pbxproj");
    expect(pbx).toContain("ScanPlugin.swift in Sources */ = {isa = PBXBuildFile;");
    expect(pbx).toContain("ScanPlugin.swift */ = {isa = PBXFileReference;");
    expect((pbx.match(/ScanPlugin\.swift/g) ?? []).length).toBe(6);
    expect(read("ios/App/App/Info.plist")).toContain("Scan The Site and Scan The Room use it with the LiDAR sensor to draw a plan and build a 3D scan.");
  });
  it("the Inspector: the doors after the plugin answers, the landing (rows under the cap, the plan, the USDZ, the job copy), the 3D tile; the page hands the job id", () => {
    const insp = read("src/app/(app)/appointments/[id]/inspector.tsx");
    expect(insp).toContain("const [scanOn, setScanOn] = useState<ScanDoors>(NO_SCAN_DOORS);");
    expect(insp).toContain("void scanDoors().then((d) => {\n      if (live) setScanOn(d);");
    expect(insp).toContain('onClick={() => void scanInto(taskId, "site")}');
    expect(insp).toContain('onClick={() => void scanInto(taskId, "room")}');
    expect(insp).toContain("Scan The Site\n");
    expect(insp).toContain("Scan The Room\n");
    const fn = insp.slice(insp.indexOf("async function scanInto("), insp.indexOf("async function fileOnJob("));
    expect(fn).toContain("if (measuringRef.current) return;");
    expect(fn).toContain('if ("refused" in r) setError(r.refused);');
    expect(fn).toContain("const landing = scanLanding(r);");
    // A re-scan replaces its own earlier rows on the same task/visit (and says so); hand-typed and
    // Measure rows are kept; the cap counts what is kept.
    expect(fn).toContain("const kept = measuresRef.current.filter((m) => !(m.scan === r.kind && (m.task_id ?? null) === taskId));");
    expect(fn).toContain("const fits = Math.max(0, MAX_MEASURES - kept.length);");
    expect(fn).toContain("const next = [...kept, ...rows];\n        measuresRef.current = next;");
    expect(fn).toContain("scan: r.kind, ...(taskId ? { task_id: taskId } : {})");
    expect(fn).toContain("if (replaced) notes.push(`Replaced the last ${r.kind} scan's ${replaced} row${replaced === 1 ? \"\" : \"s\"}.`);");
    // The buttons sit on their own wrapping row under the label, never beside it (they stacked).
    expect(insp).toContain('<div className="mt-2 flex flex-wrap gap-2">');
    expect(insp).toContain("<SectionLabel>Measurements</SectionLabel>\n                {measureButtons(t.id)}");
    expect(insp).toContain("<SectionLabel>Measurements</SectionLabel>\n          {measureButtons(null)}");
    expect(insp).not.toContain("flex flex-wrap justify-end gap-2");
    expect(fn).toContain("queueCapture({ measures: next });");
    expect(fn).toContain("const plan = await planImageFile(landing.svg, landing.name);");
    // Every upload's outcome is read off its return and said (skeptic #17): the plan, the site
    // picture, the 3D file; the job copy only after the file is stored.
    expect(fn).toContain("const planStored = await upload([plan], { caption: landing.caption, about: landing.about });");
    expect(fn).toContain("if (!planStored.length) notes.push(\"The plan drawing didn't upload — try the scan again.\");");
    expect(fn).toContain("const shot = await upload([r.photo], { caption: landing.caption, about: landing.about });");
    expect(fn).toContain('const stored = await upload([r.model], { caption: "3D scan", about: landing.about });');
    expect(fn).toContain("if (!stored.length) notes.push(\"The 3D file didn't upload — try the scan again.\");\n        else if (jobId) {");
    expect(fn).toContain("if (r.modelNote) notes.push(r.modelNote);");
    const job = insp.slice(insp.indexOf("async function fileOnJob("), insp.indexOf("const measureButtons = "));
    expect(job).toContain("await storage.copy(from, to)");
    expect(job).toContain('await addDocument({ job_id: job, name, category: "Other", file_url: to, size_bytes: size });');
    expect(job).toContain("} catch (e: unknown) {");
    expect(job).toContain("await storage.remove([to]).then(() => undefined, () => undefined);");
    expect(insp).toContain("const is3d = (p: string) => /\\.(usdz|glb|gltf)($|\\?)/i.test(p);");
    // The 3D badge on both tiles (the task's and the visit's), each a button into the viewer.
    expect((insp.match(/<span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black\/55 px-1 py-0\.5 text-\[9px\] font-bold text-white">3D<\/span>/g) ?? []).length).toBe(2);
    expect(insp).toContain("jobId?: string | null;");
    expect(read("src/app/(app)/appointments/[id]/page.tsx")).toContain("jobId={a.job_id ?? null}");
    // The job's papers already know a 3D file by its name (the portal's model seam).
    expect(read("src/lib/portal/doc-kinds.ts")).toContain("usdz");
  });
});
