/**
 * THE CAMERA MODAL'S PURE PARTS: when a picture has really arrived, whether a picture is black,
 * which camera to open, and what a failure says (to the person and to ops).
 *
 * "camera was black" (Erik, 2026-09-24, the North web app on his Intel Mac with his iPhone on the
 * cable): Organize → Take Photo, the Mac's camera light came on, the preview was black, and the
 * modal offered Retake / Use Photo over a black frame. The old modal (camera-capture.tsx before
 * this fix) had one CONFIRMED way to get there and two that fit but weren't proven:
 *
 *   CONFIRMED, deterministic: RETAKE ORPHANED THE STREAM. The <video> was rendered only while
 *      there was no shot, so Capture unmounted it and Retake mounted a NEW one with no srcObject
 *      while the stream kept running: camera light on, black preview, `ready` still true, the
 *      shutter still open. The next Capture drew a 0×0 canvas: a blank "data:," image under
 *      Retake / Use Photo, and a toBlob of null, so Use Photo did nothing, without a word. That is
 *      exactly what Erik saw.
 *   POSSIBLE: READY MEANT "play() RESOLVED", NOT "A FRAME ARRIVED". The shutter opened the moment
 *      play() settled. A Mac camera sends black for a moment after its light comes on, so a
 *      capture in that window was black (a black CAPTURE, not a preview that stays black).
 *   POSSIBLE, unchecked: ONE CAMERA, CHOSEN BY facingMode "environment". On a Mac with an iPhone
 *      attached, that ask can land on a Continuity or virtual camera that sends black, with no way
 *      to pick another or to choose a file. A computer now asks for no facing at all (the system's
 *      default webcam); phones keep the rear-camera ask.
 *
 * Everything here is pure so it is tested, not assumed: no DOM, no React, no storage of its own.
 */

/** HTMLMediaElement.HAVE_CURRENT_DATA: the element holds the frame at the current position. */
export const HAVE_CURRENT_DATA = 2;

/** The bits of an HTMLVideoElement the ready gate reads. */
export type VideoLike = { readyState: number; videoWidth: number; videoHeight: number };

/**
 * THE READY GATE. A frame can be drawn only when the element holds one (readyState ≥
 * HAVE_CURRENT_DATA) and knows its size (both dimensions above zero). Where the browser has
 * requestVideoFrameCallback the caller also waits for that callback, which fires only after a
 * frame has been handed to the compositor; this gate is the part that holds everywhere.
 */
export function frameReady(v: VideoLike | null | undefined): boolean {
  return !!v && v.readyState >= HAVE_CURRENT_DATA && v.videoWidth > 0 && v.videoHeight > 0;
}

/**
 * IS THIS PICTURE BLACK? Reads an RGBA buffer (a canvas's getImageData().data, usually from a
 * small copy of the frame) and answers true when essentially nothing in it is lit.
 *
 * "Lit" is a pixel whose luma (Rec. 601) is above `litLuma` (default 24 of 255, well above the
 * noise a dark sensor sends and well below any receipt, page or room). The picture is black when
 * fewer than `litShare` of its pixels are lit (default 0.5%): a dead camera's stray hot pixel does
 * not rescue it, and a dim room still has far more than half a percent of its pixels over 24.
 * Fully transparent pixels count as unlit, because that is what a canvas never drawn on holds.
 * An empty buffer is black: nothing was captured.
 */
export function isMostlyBlack(
  rgba: ArrayLike<number>,
  opts: { litLuma?: number; litShare?: number } = {},
): boolean {
  const litLuma = opts.litLuma ?? 24;
  const litShare = opts.litShare ?? 0.005;
  const pixels = Math.floor(rgba.length / 4);
  if (pixels === 0) return true;
  let lit = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    if (rgba[o + 3] === 0) continue;
    const luma = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    if (luma > litLuma) lit++;
  }
  return lit / pixels < litShare;
}

/** The size of the small copy a frame is shrunk to before isMostlyBlack reads it: the whole
 *  picture, sampled, at a cost that doesn't matter (64×64×4 bytes). */
export const BLACK_SAMPLE_SIZE = 64;

/** The sentence a black capture gets instead of Use Photo. */
export const BLACK_FRAME_LINE = "The camera sent a black picture. Try another camera or choose a photo instead.";

/** The sentence when the camera opened but no picture ever arrived. */
export const NO_FRAME_LINE = "The camera never sent a picture. Try another camera or choose a photo instead.";

/** How long a camera that has been granted gets to send its first picture before the modal says
 *  so. Generous: a cold Mac camera, or a phone camera waking over a cable, takes a few seconds. */
export const FIRST_FRAME_TIMEOUT_MS = 10_000;

/** How long, after the first picture arrives, the shutter waits for one that isn't black. A
 *  cold camera's first frames are black (the sensor starts dark and the exposure climbs); past
 *  this the shutter opens anyway, because a dark subject is the person's call. */
export const WARMUP_GATE_MS = 1_500;

/** The sentence a black capture gets while the camera is still warming up: not the camera's fault,
 *  and not reported to ops. */
export const WARMING_UP_LINE = "The camera is still starting. Wait a moment and capture again.";

/** How long the preview may stay black before the modal says so (the shutter stays open: a
 *  camera warming up sends black for a moment, and a genuinely dark subject is the person's
 *  call; the capture itself is what gets refused). */
export const DARK_PREVIEW_HINT_MS = 3_000;

/**
 * WHY getUserMedia FAILED, IN PLAIN WORDS. Keyed on the DOMException name; the modal shows this
 * line above "Choose A Photo Instead", which is always there.
 */
export function cameraFailureLine(errorName: string | null | undefined, native = false): string {
  switch (errorName) {
    case "NotAllowedError":
    case "SecurityError":
      return native
        ? "The camera is blocked for North. Turn it on in Settings → North → Camera, or choose a photo instead."
        : "The camera is blocked for this site. Allow it in the browser's settings for this site, or choose a photo instead.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera was found. Choose a photo instead.";
    case "NotReadableError":
    case "AbortError":
      return "The camera is in use by another app, or it didn't start. Close the other app and try again, or choose a photo instead.";
    case "NoMediaDevices":
      return "This browser can't open a camera here. Choose a photo instead.";
    default:
      return "The camera didn't open. Try again, or choose a photo instead.";
  }
}

/** A camera the modal can offer: what enumerateDevices gives, with a label to show. */
export type CameraOption = { deviceId: string; label: string };

/**
 * The cameras to offer in the picker, in the system's order and with the system's labels. A
 * camera with no label (labels are empty before permission, and some drivers never give one) is
 * named by its place in the list so the picker never shows a blank row.
 */
export function cameraOptions(
  devices: ReadonlyArray<{ kind: string; deviceId: string; label?: string }>,
): CameraOption[] {
  const out: CameraOption[] = [];
  for (const d of devices) {
    if (d.kind !== "videoinput" || !d.deviceId) continue;
    if (out.some((c) => c.deviceId === d.deviceId)) continue;
    out.push({ deviceId: d.deviceId, label: (d.label ?? "").trim() || `Camera ${out.length + 1}` });
  }
  return out;
}

/** Where this browser remembers the camera it was last told to use. */
export const CAMERA_CHOICE_KEY = "cn.camera.deviceId";

/** The storage the choice lives in. Injected so the tests (and a browser whose storage throws)
 *  are the same code path. */
export type ChoiceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The camera this browser was last told to use, or null. Storage that is missing or throws
 *  (a private window, blocked site data) is "nothing remembered", never an error. */
export function readCameraChoice(storage: ChoiceStorage | null | undefined): string | null {
  try {
    const v = storage?.getItem(CAMERA_CHOICE_KEY);
    return v && v.length <= 512 ? v : null;
  } catch {
    return null;
  }
}

/** Remember (or, with null, forget) the camera for next time. Never throws. */
export function rememberCameraChoice(storage: ChoiceStorage | null | undefined, deviceId: string | null): void {
  try {
    if (!storage) return;
    if (deviceId) storage.setItem(CAMERA_CHOICE_KEY, deviceId);
    else storage.removeItem(CAMERA_CHOICE_KEY);
  } catch {
    /* a remembered camera is a convenience; losing it is fine */
  }
}

/**
 * The video constraints to open with. A remembered camera is asked for by id (exact, so the
 * browser can't quietly substitute the one that was black). With nothing remembered, a phone asks
 * for the rear camera; a computer (`preferRear` false) asks for no facing at all, so the system's
 * default webcam opens rather than whatever answers to "environment" (a Continuity or virtual
 * camera). Either way at a size a receipt can be read at.
 */
export function videoConstraints(deviceId: string | null, preferRear = true): MediaTrackConstraints {
  const size = { width: { ideal: 2560 }, height: { ideal: 1440 } };
  if (deviceId) return { deviceId: { exact: deviceId }, ...size };
  return preferRear ? { facingMode: "environment", ...size } : { ...size };
}

/**
 * How many cameras this machine has, for a failure report (not the picker). Counts the raw
 * videoinput rows: before permission is granted a browser lists at most one camera, with an empty
 * id, so the count is then "1+" (at least one) rather than a number that reads as "no camera".
 */
export function cameraCountForReport(devices: ReadonlyArray<{ kind: string; deviceId: string }>): string {
  const cams = devices.filter((d) => d.kind === "videoinput");
  if (cams.length === 0) return "0";
  if (cams.some((d) => !d.deviceId)) return `${cams.length}+`;
  return String(cams.length);
}

/** Every way the camera modal ends without a picture. The name IS the error_events message. */
export type CameraBranch =
  | "no-media-devices"
  | "getusermedia-rejected"
  | "no-frame"
  | "black-frame"
  | "encode-failed";

/**
 * The extra payload for reportClientError("camera", branch, …). No personal data: no device
 * labels, no ids, no picture. Just the facts that tell the branches apart.
 */
export function cameraFailureExtra(s: {
  errorName?: string | null;
  cameras: number | string;
  frameArrived: boolean;
  remembered: boolean;
  native: boolean;
}): Record<string, string> {
  return {
    error_name: s.errorName ? String(s.errorName).slice(0, 80) : "none",
    cameras: String(s.cameras),
    frame_arrived: String(s.frameArrived),
    remembered_camera: String(s.remembered),
    shell: s.native ? "native" : "web",
  };
}
