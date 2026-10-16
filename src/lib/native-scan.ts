"use client";

import { isNativeShell } from "@/lib/native-shell";

/**
 * LIDAR — 3D SCAN: the page's door to ScanPlugin.swift. Erik 2026-10-16, after Polycam: "collect
 * all of the pixels for all surfaces and render an image … i want that"; and after Apple's own
 * capture: "lets group everything with a title called Lidar, get rid of the site scan and scan the
 * room and lets keep measurements and measure area and 3d scan". The shell walks the room or the
 * site with OUR OWN camera (the surfaces show blue until a photo has them), builds the textured
 * model on the phone and hands the FILE back; this brings it over in pieces and makes it a File
 * the Inspector uploads the way it uploads any photo. No numbers: the measurements are Measure's.
 * A phone that cannot scan refuses with the plugin's own sentence; the door exists only where the
 * plugin says so.
 *
 * THE BRIDGE, NEVER AN IMPORT (native-measure.ts): a local plugin compiled into the shell, read
 * off window.Capacitor.Plugins. A build without it has no key: no door is drawn.
 */

type Plugin = {
  isSupported?(): Promise<{ model?: unknown; reason?: unknown }>;
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
  return typeof plugin()?.scan3d === "function";
}

export type ScanDoors = { model: boolean };
export const NO_SCAN_DOORS: ScanDoors = { model: false };

/** Can this phone scan in 3D — the plugin's own answer (the sensor; iOS 17). */
export async function scanDoors(): Promise<ScanDoors> {
  const p = plugin();
  if (!p?.isSupported) return NO_SCAN_DOORS;
  try {
    const r = await p.isSupported();
    return { model: r?.model === true };
  } catch {
    return NO_SCAN_DOORS;
  }
}

export const USDZ_MIME = "model/vnd.usdz+zip";

// ── 3D SCAN: the textured model ────────────────────────────────────────────────────────────────
// The shell takes the photos as the walker moves and builds the model on the phone; the file
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

/** Open the capture screen, wait for the model, and bring it over. The tap that calls this is the camera ask. */
export async function scan3dNative(now = Date.now()): Promise<ModelScanResult> {
  const p = plugin();
  if (!p?.scan3d) return { ok: false, refused: "3D Scan needs the North app on an iPhone with a LiDAR sensor." };
  let r: Record<string, unknown>;
  try {
    r = await p.scan3d();
  } catch (e: unknown) {
    const msg = (e as { message?: unknown })?.message;
    return { ok: false, refused: typeof msg === "string" && msg.trim() ? msg : "Couldn't open 3D Scan. Try again." };
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
  if (!model) return { ok: false, refused: "The model didn't come over from the camera whole. Tap 3D Scan again to retry." };
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
