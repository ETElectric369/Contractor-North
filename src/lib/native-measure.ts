"use client";

import { isNativeShell } from "@/lib/native-shell";

/**
 * MEASURE WITH THE CAMERA — the page's door to MeasurePlugin.swift (LiDAR rung 1, field feedback
 * 10-13, item 5). The shell opens Apple-style measuring (a crosshair, Add Point, Done) and hands
 * back meters and a snapshot; this converts to Erik's units and turns the picture into a File the
 * Inspector uploads the way it uploads any photo. Nothing here is a guess: a phone that cannot
 * measure refuses with the plugin's own sentence, and the button only exists where the plugin is
 * on the bridge (a browser has no door to show — "available is not visible").
 *
 * THE BRIDGE, NEVER AN IMPORT (native-tap.ts / native-orientation.ts): a local plugin compiled
 * into the shell, read off window.Capacitor.Plugins. A build without it (today's App Store build)
 * has no key, so measurePluginPresent() is false and the Inspector draws nothing.
 */

export type MeasureMode = "length" | "area";

type Plugin = {
  isSupported?(): Promise<{ supported?: unknown; lidar?: unknown; reason?: unknown }>;
  measure?(opts: { mode: MeasureMode }): Promise<{
    ok?: unknown;
    cancelled?: unknown;
    mode?: unknown;
    meters?: unknown;
    squareMeters?: unknown;
    points?: unknown;
    lidar?: unknown;
    photo?: unknown;
    photoMime?: unknown;
  }>;
};

function plugin(): Plugin | null {
  if (typeof window === "undefined" || !isNativeShell()) return null;
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  return (cap?.Plugins?.Measure as Plugin | undefined) ?? null;
}

/** Synchronous: is the Measure plugin on the bridge (the iOS shell, rebuilt with it). */
export function measurePluginPresent(): boolean {
  return typeof plugin()?.measure === "function";
}

export const FEET_PER_METER = 3.28084;
export const SQUARE_FEET_PER_SQUARE_METER = 10.7639;

/** Meters → feet, two decimals (a measurement row's number). */
export function metersToFeet(m: number): number {
  return Math.round(m * FEET_PER_METER * 100) / 100;
}
/** Square meters → square feet, one decimal. */
export function squareMetersToSquareFeet(m2: number): number {
  return Math.round(m2 * SQUARE_FEET_PER_SQUARE_METER * 10) / 10;
}
/** 3.86 ft → "3 ft 10.3 in" — the caption the snapshot wears (11.96 in rolls up to the next foot). */
export function feetInches(ft: number): string {
  const inches = ft * 12;
  let whole = Math.floor(inches / 12);
  let rest = Math.round((inches - whole * 12) * 10) / 10;
  if (rest >= 12) {
    whole += 1;
    rest = 0;
  }
  if (whole === 0) return `${rest} in`;
  return `${whole} ft ${rest} in`;
}
/** A figure off a phone without the sensor is close, not exact: one decimal, and said so. */
export function approxFeet(ft: number): number {
  return Math.round(ft * 10) / 10;
}
/** Below this the points sat on the same spot: not a measurement. */
export const MIN_METERS = 0.005;
export const MIN_SQUARE_METERS = 0.0005;

export type MeasureResult =
  | { ok: true; mode: MeasureMode; value: number; unit: "ft" | "sq ft"; caption: string; points: number; lidar: boolean; approx: boolean; photo: File | null }
  | { ok: false; cancelled: true }
  | { ok: false; refused: string };

/** A base64 JPEG from the plugin → a File the uploader takes; null when it is not a picture. */
export function photoFile(b64: unknown, mime: unknown, name: string): File | null {
  if (typeof b64 !== "string" || b64.length < 64 || typeof atob !== "function") return null;
  const type = typeof mime === "string" && mime.startsWith("image/") ? mime : "image/jpeg";
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type });
  } catch {
    return null;
  }
}

/** Open the measuring view and wait for the figure. The tap that calls this is the camera ask. */
export async function measureNative(mode: MeasureMode): Promise<MeasureResult> {
  const p = plugin();
  if (!p?.measure) return { ok: false, refused: "Measure needs the North app on an iPhone." };
  let r: Awaited<ReturnType<NonNullable<Plugin["measure"]>>>;
  try {
    r = await p.measure({ mode });
  } catch (e: unknown) {
    const msg = (e as { message?: unknown })?.message;
    return { ok: false, refused: typeof msg === "string" && msg.trim() ? msg : "Couldn't open Measure. Try again, or type the measurement." };
  }
  if (r?.ok !== true) return { ok: false, cancelled: true };
  const raw = mode === "area" ? r.squareMeters : r.meters;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return { ok: false, refused: "Measure came back without a number. Try again." };
  if (raw < (mode === "area" ? MIN_SQUARE_METERS : MIN_METERS)) return { ok: false, refused: "Measure came back with nothing — the points sat on the same spot. Try again." };
  const lidar = r.lidar === true;
  const exact = mode === "area" ? squareMetersToSquareFeet(raw) : metersToFeet(raw);
  const value = lidar ? exact : approxFeet(exact);
  const caption = `${mode === "area" ? `${value} sq ft` : feetInches(value)}${lidar ? "" : " (approx.)"}`;
  return {
    ok: true,
    mode,
    value,
    unit: mode === "area" ? "sq ft" : "ft",
    caption,
    points: typeof r.points === "number" ? r.points : 0,
    lidar,
    approx: !lidar,
    photo: photoFile(r.photo, r.photoMime, `measure-${Date.now()}.jpg`),
  };
}
