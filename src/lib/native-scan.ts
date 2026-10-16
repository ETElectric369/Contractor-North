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
  isSupported?(): Promise<{ site?: unknown; room?: unknown; reason?: unknown }>;
  scanSite?(): Promise<Record<string, unknown>>;
  scanRoom?(): Promise<Record<string, unknown>>;
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

export type ScanDoors = { site: boolean; room: boolean };
export const NO_SCAN_DOORS: ScanDoors = { site: false, room: false };

/** Which scans this phone can do — the plugin's own answer (the sensor; iOS 16 for a room). */
export async function scanDoors(): Promise<ScanDoors> {
  const p = plugin();
  if (!p?.isSupported) return NO_SCAN_DOORS;
  try {
    const r = await p.isSupported();
    return { site: r?.site === true, room: r?.room === true };
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
