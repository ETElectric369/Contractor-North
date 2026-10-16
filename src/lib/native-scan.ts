"use client";

import { isNativeShell } from "@/lib/native-shell";
import { FEET_PER_METER, metersToFeet, photoFile, squareMetersToSquareFeet } from "@/lib/native-measure";

/**
 * SCAN THE SITE / SCAN THE ROOM — the page's door to ScanPlugin.swift (LiDAR rung 2). Erik
 * 2026-10-16: "go for the scan … not being able to scan outside is what my brother specifically
 * asked for." The shell walks the site (tapped corners over the LiDAR mesh) or the room (Apple's
 * RoomPlan) and hands back METERS and files; this turns the figures into feet and the bytes into
 * Files the Inspector uploads the way it uploads any photo. Nothing here is a guess: every number
 * is a tapped corner or a RoomPlan wall, never read off the mesh; a phone that cannot scan refuses
 * with the plugin's own sentence; the doors exist only where the plugin says so.
 *
 * THE BRIDGE, NEVER AN IMPORT (native-measure.ts): a local plugin compiled into the shell, read
 * off window.Capacitor.Plugins. A build without it has no key: no door is drawn.
 */

export type ScanKind = "site" | "room";

type Plugin = {
  isSupported?(): Promise<{ site?: unknown; room?: unknown; model?: unknown; reason?: unknown }>;
  scanSite?(): Promise<Record<string, unknown>>;
  scanRoom?(): Promise<Record<string, unknown>>;
  scan3d?(): Promise<Record<string, unknown>>;
  readChunk?(o: { path: string; offset: number; length: number }): Promise<{ data?: unknown; bytes?: unknown; total?: unknown }>;
  discard?(o: { path: string }): Promise<void>;
  stageFile?(o: { name: string }): Promise<{ path?: unknown }>;
  stageChunk?(o: { path: string; data: string }): Promise<{ bytes?: unknown }>;
  previewFile?(o: { path: string }): Promise<void>;
};

function plugin(): Plugin | null {
  if (typeof window === "undefined" || !isNativeShell()) return null;
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  return (cap?.Plugins?.Scan as Plugin | undefined) ?? null;
}

/** Synchronous: is the Scan plugin on the bridge (the iOS shell, rebuilt with it). */
export function scanPluginPresent(): boolean {
  return typeof plugin()?.scanSite === "function";
}

export type ScanDoors = { site: boolean; room: boolean; model: boolean };
export const NO_SCAN_DOORS: ScanDoors = { site: false, room: false, model: false };

/** Which scans this phone can do — the plugin's own answer (the sensor; iOS 16 for a room). */
export async function scanDoors(): Promise<ScanDoors> {
  const p = plugin();
  if (!p?.isSupported) return NO_SCAN_DOORS;
  try {
    const r = await p.isSupported();
    return { site: r?.site === true, room: r?.room === true, model: r?.model === true };
  } catch {
    return NO_SCAN_DOORS;
  }
}

/** A point on the plan, in feet: x across, y down the page (ARKit's x and z). */
export type PlanPoint = { x: number; y: number };

export type SiteScan = {
  ok: true;
  kind: "site";
  /** The tapped corners on the plan, in walking order. */
  corners: PlanPoint[];
  /** Each side's true length in feet (corner to corner, closing side last). */
  sides: number[];
  area: number;
  perimeter: number;
  photo: File | null;
  model: File | null;
  /** The plugin's word on the 3D file when it is partial or missing; shown, never swallowed. */
  modelNote: string | null;
};

export type RoomWall = { length: number; height: number; a: PlanPoint; b: PlanPoint };

export type RoomScan = {
  ok: true;
  kind: "room";
  walls: RoomWall[];
  doors: number;
  windows: number;
  openings: number;
  /** The tallest wall RoomPlan saw, feet (a flat ceiling's height; a gable's peak wall). */
  tallestWall: number | null;
  /** The floor outline (iOS 17+, one floor), else null; the plan draws walls alone without it. */
  floorCorners: PlanPoint[] | null;
  /** Every floor's area summed (iOS 17+), else null. */
  floorArea: number | null;
  model: File | null;
  modelNote: string | null;
};

export type ScanResult = SiteScan | RoomScan | { ok: false; cancelled: true } | { ok: false; refused: string };

/** Base64 bytes from the plugin → a File of the given type; null when it is not a string of bytes. */
export function bytesFile(b64: unknown, type: string, name: string): File | null {
  if (typeof b64 !== "string" || b64.length < 64 || typeof atob !== "function") return null;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type });
  } catch {
    return null;
  }
}

export const USDZ_MIME = "model/vnd.usdz+zip";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** [x, y, z] meters (world) → a plan point in feet: x across, z down the page. */
export function planPointOf(v: unknown): PlanPoint | null {
  if (!Array.isArray(v)) return null;
  const x = num(v[0]);
  const z = num(v[v.length === 2 ? 1 : 2]);
  if (x === null || z === null) return null;
  return { x: Math.round(x * FEET_PER_METER * 100) / 100, y: Math.round(z * FEET_PER_METER * 100) / 100 };
}

/** The plugin's word on the 3D file, or ours when bytes came that did not decode (never silent). */
function modelNoteOf(r: Record<string, unknown>, model: File | null): string | null {
  if (typeof r.modelNote === "string" && r.modelNote.trim()) return r.modelNote.trim();
  if (typeof r.model === "string" && r.model.length > 0 && !model) return "The 3D file came back unreadable; the plan and the measurements did.";
  return null;
}

/** The raw site payload → feet; null when it is not a site scan with three corners and a figure. */
export function siteScanOf(r: Record<string, unknown>, now = Date.now()): SiteScan | null {
  const corners = Array.isArray(r.corners) ? r.corners.map(planPointOf) : [];
  if (corners.length < 3 || corners.some((c) => !c)) return null;
  const sidesRaw = Array.isArray(r.sides) ? r.sides.map(num) : [];
  if (sidesRaw.length !== corners.length || sidesRaw.some((s) => s === null || s < 0)) return null;
  const area = num(r.squareMeters);
  const perimeter = num(r.perimeterMeters);
  if (area === null || area <= 0 || perimeter === null || perimeter <= 0) return null;
  const model = bytesFile(r.model, USDZ_MIME, `site-scan-${now}.usdz`);
  return {
    ok: true,
    kind: "site",
    corners: corners as PlanPoint[],
    sides: sidesRaw.map((s) => metersToFeet(s as number)),
    area: squareMetersToSquareFeet(area),
    perimeter: metersToFeet(perimeter),
    photo: photoFile(r.photo, r.photoMime, `site-scan-${now}.jpg`),
    model,
    modelNote: modelNoteOf(r, model),
  };
}

/** The raw room payload → feet; null when it is not a room scan with a wall. */
export function roomScanOf(r: Record<string, unknown>, now = Date.now()): RoomScan | null {
  const wallsRaw = Array.isArray(r.walls) ? r.walls : [];
  const walls: RoomWall[] = [];
  for (const w of wallsRaw) {
    const o = (w ?? {}) as Record<string, unknown>;
    const length = num(o.meters);
    const height = num(o.height);
    const a = planPointOf(o.a);
    const b = planPointOf(o.b);
    if (length === null || length <= 0 || height === null || !a || !b) continue;
    walls.push({ length: metersToFeet(length), height: metersToFeet(height), a, b });
  }
  if (!walls.length) return null;
  const model = bytesFile(r.model, USDZ_MIME, `room-scan-${now}.usdz`);
  const tallest = num(r.tallestWallMeters);
  const floorRaw = Array.isArray(r.floorCorners) ? r.floorCorners.map(planPointOf) : [];
  const floorCorners = floorRaw.length >= 3 && floorRaw.every(Boolean) ? (floorRaw as PlanPoint[]) : null;
  const floorArea = num(r.floorSquareMeters);
  return {
    ok: true,
    kind: "room",
    walls,
    doors: count(r.doors),
    windows: count(r.windows),
    openings: count(r.openings),
    tallestWall: tallest !== null && tallest > 0 ? metersToFeet(tallest) : null,
    floorCorners,
    floorArea: floorArea !== null && floorArea > 0 ? squareMetersToSquareFeet(floorArea) : null,
    model,
    modelNote: modelNoteOf(r, model),
  };
}

/** Open the scanning view and wait for the room or the site. The tap that calls this is the camera ask. */
export async function scanNative(kind: ScanKind): Promise<ScanResult> {
  const p = plugin();
  const door = kind === "site" ? p?.scanSite : p?.scanRoom;
  if (!door) return { ok: false, refused: "Scanning needs the North app on an iPhone with a LiDAR sensor." };
  let r: Record<string, unknown>;
  try {
    r = await door.call(p);
  } catch (e: unknown) {
    const msg = (e as { message?: unknown })?.message;
    return { ok: false, refused: typeof msg === "string" && msg.trim() ? msg : "Couldn't open the scan. Try again, or Measure instead." };
  }
  if (r?.ok !== true) return { ok: false, cancelled: true };
  const out = kind === "site" ? siteScanOf(r) : roomScanOf(r);
  if (!out) return { ok: false, refused: kind === "site" ? "The scan came back without a footprint — tap at least three corners next time." : "The scan came back without a wall. Try again, walking the room more slowly." };
  return out;
}

// ── SCAN IN 3D: the textured model ─────────────────────────────────────────────────────────────
// Erik 2026-10-16, after Polycam: "collect all of the pixels for all surfaces and render an
// image … i want that." The shell captures the photos and builds the model on the phone; the file
// (tens of megabytes) stays in the shell's temp folder and comes over in 2 MB pieces — never one
// giant string over the bridge — then is discarded. No numbers: this door is the picture.

export type ModelScan = { ok: true; kind: "model"; model: File; shots: number; /** The shell's copy, discarded by the page once the upload has landed. */ path: string };
export type ModelScanResult = ModelScan | { ok: false; cancelled: true } | { ok: false; refused: string };

/** How much comes over the bridge per call (base64 of this many bytes). */
export const CHUNK_BYTES = 2_000_000;
/** The biggest model the page will assemble (a reduced-detail room is a few to a few tens of MB). */
export const MODEL_MAX_BYTES = 200_000_000;

/** Base64 → bytes; null when it is not base64. */
export function bytesOf(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string" || typeof atob !== "function") return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The shell's copy of a scan goes — called by the page once the upload has LANDED, never before
 *  (a minutes-long capture must survive a bad-signal upload; skeptic #18). A wrong path is a no-op. */
export async function discardScan(path: string): Promise<void> {
  const p = plugin();
  if (!p?.discard || !path) return;
  await p.discard({ path }).catch(() => undefined);
}

/** Pull one file out of the shell in pieces and hand it back as a File. Each piece is asked twice
 *  before giving up; the shell's copy is left where it is (discardScan takes it later). */
export async function pullFile(p: Plugin, path: string, total: number, name: string, type: string): Promise<File | null> {
  if (!p.readChunk || !Number.isFinite(total) || total <= 0 || total > MODEL_MAX_BYTES) return null;
  const parts: Uint8Array[] = [];
  let got = 0;
  while (got < total) {
    let bytes: Uint8Array | null = null;
    for (let attempt = 0; attempt < 2 && !bytes; attempt++) {
      try {
        const r = await p.readChunk({ path, offset: got, length: CHUNK_BYTES });
        bytes = bytesOf(r?.data);
      } catch {
        bytes = null;
      }
    }
    if (!bytes || bytes.length === 0) return null;
    parts.push(bytes);
    got += bytes.length;
  }
  if (got !== total) return null;
  return new File(parts as BlobPart[], name, { type });
}

/** Open Apple's capture view, wait for the model, and bring it over. The tap that calls this is the camera ask. */
export async function scan3dNative(now = Date.now()): Promise<ModelScanResult> {
  const p = plugin();
  if (!p?.scan3d) return { ok: false, refused: "Scan In 3D needs the North app on an iPhone with a LiDAR sensor." };
  let r: Record<string, unknown>;
  try {
    r = await p.scan3d();
  } catch (e: unknown) {
    const msg = (e as { message?: unknown })?.message;
    return { ok: false, refused: typeof msg === "string" && msg.trim() ? msg : "Couldn't open Scan In 3D. Try again." };
  }
  if (r?.ok !== true) return { ok: false, cancelled: true };
  const path = typeof r.path === "string" ? r.path : "";
  const total = typeof r.bytes === "number" ? r.bytes : 0;
  if (!path || total <= 0) {
    await discardScan(path);
    return { ok: false, refused: "The model came back empty. Try again with more light and a slower walk." };
  }
  if (total > MODEL_MAX_BYTES) {
    await discardScan(path);
    return { ok: false, refused: `The model is too big to send (${Math.round(total / 1_000_000)} MB). Scan a smaller area.` };
  }
  const model = await pullFile(p, path, total, `scan-3d-${now}.usdz`, USDZ_MIME);
  if (!model) return { ok: false, refused: "The model didn't come over from the camera whole. Tap Scan In 3D again to retry." };
  return { ok: true, kind: "model", model, path, shots: typeof r.shots === "number" ? r.shots : 0 };
}

// ── OPEN IN AR: Apple's Quick Look from inside the shell ─────────────────────────────────────────
// A rel="ar" link is Safari's door; the app's web view ignores it (Erik, 10-16). The page holds the
// bytes it drew, hands them to the shell in pieces (the reverse of pullFile), and the shell opens
// Quick Look, which carries the AR tab. The staged copy goes when the viewer closes.

/** Synchronous: can this shell open a model in Quick Look (a build with the staging doors). */
export function arPreviewPresent(): boolean {
  const p = plugin();
  return typeof p?.stageFile === "function" && typeof p?.stageChunk === "function" && typeof p?.previewFile === "function";
}

/** Bytes → base64 (no spread of a huge array: a chunk at a time through a binary string). */
export function base64Of(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  return btoa(bin);
}

export type ArPreviewResult = { ok: true } | { ok: false; refused: string };

/** Stage the model in the shell and open it in Quick Look; resolves when the viewer closes. */
export async function openInAr(bytes: Uint8Array, name: string): Promise<ArPreviewResult> {
  const p = plugin();
  if (!p?.stageFile || !p.stageChunk || !p.previewFile) return { ok: false, refused: "Open In AR needs the North app on an iPhone." };
  if (!bytes.length || bytes.length > MODEL_MAX_BYTES) return { ok: false, refused: "This model is too big to open in AR here." };
  let path = "";
  try {
    const staged = await p.stageFile({ name });
    path = typeof staged?.path === "string" ? staged.path : "";
    if (!path) return { ok: false, refused: "The phone couldn't make room for the model." };
    for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
      await p.stageChunk({ path, data: base64Of(bytes.subarray(at, at + CHUNK_BYTES)) });
    }
    await p.previewFile({ path });
    return { ok: true };
  } catch (e: unknown) {
    if (path && p.discard) await p.discard({ path }).catch(() => undefined);
    const msg = (e as { message?: unknown })?.message;
    return { ok: false, refused: typeof msg === "string" && msg.trim() ? msg : "Couldn't open the model in AR. Try again." };
  }
}
