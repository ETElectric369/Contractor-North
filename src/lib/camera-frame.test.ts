import { describe, it, expect } from "vitest";
import {
  BLACK_SAMPLE_SIZE,
  CAMERA_CHOICE_KEY,
  HAVE_CURRENT_DATA,
  cameraCountForReport,
  cameraFailureExtra,
  cameraFailureLine,
  cameraOptions,
  frameReady,
  isMostlyBlack,
  readCameraChoice,
  rememberCameraChoice,
  videoConstraints,
  type ChoiceStorage,
} from "./camera-frame";

/**
 * "camera was black" (Erik, 2026-09-24, Organize → Take Photo on the Mac): the modal offered Use
 * Photo over a black frame. These are the pure parts of the fix: the gate the shutter waits on,
 * the test a capture must pass before it is offered, and the memory of which camera to open.
 */

/** A size×size RGBA buffer, every pixel the same colour. */
function solid(r: number, g: number, b: number, a = 255, size = BLACK_SAMPLE_SIZE): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
  return buf;
}

/** Light `count` pixels of a buffer with a colour. */
function lightUp(buf: Uint8ClampedArray, count: number, rgb: [number, number, number] = [255, 255, 255]) {
  for (let p = 0; p < count; p++) {
    buf[p * 4] = rgb[0];
    buf[p * 4 + 1] = rgb[1];
    buf[p * 4 + 2] = rgb[2];
    buf[p * 4 + 3] = 255;
  }
  return buf;
}

describe("isMostlyBlack: is this capture a black picture", () => {
  it("a frame of pure black is black", () => {
    expect(isMostlyBlack(solid(0, 0, 0))).toBe(true);
  });

  it("a dark sensor's noise is still black (a camera that is on but sees nothing)", () => {
    const buf = solid(0, 0, 0);
    for (let i = 0; i < buf.length; i += 4) {
      const n = (i / 4) % 19; // 0..18, a noise floor well under the lit line
      buf[i] = n;
      buf[i + 1] = n;
      buf[i + 2] = n;
    }
    expect(isMostlyBlack(buf)).toBe(true);
  });

  it("a stray hot pixel or two does not rescue a dead camera", () => {
    // 64×64 = 4,096 pixels; 0.5% is 20.48. Twenty bright pixels is still a black picture.
    expect(isMostlyBlack(lightUp(solid(0, 0, 0), 20))).toBe(true);
  });

  it("a mostly dark picture with a real subject in it is NOT black", () => {
    // A receipt on a dark counter: a tenth of the frame is white paper.
    expect(isMostlyBlack(lightUp(solid(8, 8, 8), 410))).toBe(false);
  });

  it("a dim room is not black", () => {
    expect(isMostlyBlack(solid(40, 36, 30))).toBe(false);
  });

  it("an ordinary picture is not black", () => {
    expect(isMostlyBlack(solid(180, 170, 150))).toBe(false);
  });

  it("weighs the channels like an eye does: a deep blue that reads dark stays black, a green that reads bright does not", () => {
    // Rec. 601 luma: pure blue 255 → 29 (just over 24: lit), blue 200 → 22.8 (not lit).
    expect(isMostlyBlack(solid(0, 0, 200))).toBe(true);
    expect(isMostlyBlack(solid(0, 60, 0))).toBe(false); // 0.587 × 60 = 35.2
  });

  it("a canvas never drawn on (all transparent) is black, and so is an empty buffer", () => {
    expect(isMostlyBlack(solid(0, 0, 0, 0))).toBe(true);
    expect(isMostlyBlack(new Uint8ClampedArray(0))).toBe(true);
  });

  it("transparent pixels never count as lit, whatever colour they carry", () => {
    expect(isMostlyBlack(solid(255, 255, 255, 0))).toBe(true);
  });

  it("takes its thresholds as options", () => {
    const grey = solid(30, 30, 30);
    expect(isMostlyBlack(grey)).toBe(false);
    expect(isMostlyBlack(grey, { litLuma: 40 })).toBe(true);
    expect(isMostlyBlack(lightUp(solid(0, 0, 0), 100), { litShare: 0.05 })).toBe(true);
  });

  it("reads a plain number array as well as a typed one", () => {
    expect(isMostlyBlack([0, 0, 0, 255, 0, 0, 0, 255])).toBe(true);
    expect(isMostlyBlack([200, 200, 200, 255, 0, 0, 0, 255])).toBe(false);
  });
});

describe("frameReady: the shutter's gate", () => {
  it("shut before the element holds a frame, even when it already knows its size", () => {
    expect(frameReady({ readyState: 0, videoWidth: 1920, videoHeight: 1080 })).toBe(false);
    expect(frameReady({ readyState: 1, videoWidth: 1920, videoHeight: 1080 })).toBe(false);
  });

  it("shut while the size is zero, even when the element claims data (the 0×0 canvas)", () => {
    expect(frameReady({ readyState: 4, videoWidth: 0, videoHeight: 0 })).toBe(false);
    expect(frameReady({ readyState: 4, videoWidth: 1280, videoHeight: 0 })).toBe(false);
    expect(frameReady({ readyState: 4, videoWidth: 0, videoHeight: 720 })).toBe(false);
  });

  it("open once a frame is held and the size is real", () => {
    expect(frameReady({ readyState: HAVE_CURRENT_DATA, videoWidth: 1280, videoHeight: 720 })).toBe(true);
    expect(frameReady({ readyState: 4, videoWidth: 2560, videoHeight: 1440 })).toBe(true);
  });

  it("shut with no element at all", () => {
    expect(frameReady(null)).toBe(false);
    expect(frameReady(undefined)).toBe(false);
  });
});

/** An in-memory Storage, and one that throws like a private window's. */
function memoryStore(): ChoiceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}
const throwing: ChoiceStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("the camera choice memory", () => {
  it("remembers the camera it was told to use, and hands it back", () => {
    const s = memoryStore();
    expect(readCameraChoice(s)).toBeNull();
    rememberCameraChoice(s, "facetime-hd");
    expect(s.data.get(CAMERA_CHOICE_KEY)).toBe("facetime-hd");
    expect(readCameraChoice(s)).toBe("facetime-hd");
  });

  it("a new choice replaces the old one, and null forgets it", () => {
    const s = memoryStore();
    rememberCameraChoice(s, "iphone-continuity");
    rememberCameraChoice(s, "facetime-hd");
    expect(readCameraChoice(s)).toBe("facetime-hd");
    rememberCameraChoice(s, null);
    expect(readCameraChoice(s)).toBeNull();
  });

  it("storage that throws (a private window, blocked site data) is 'nothing remembered', never an error", () => {
    expect(() => rememberCameraChoice(throwing, "facetime-hd")).not.toThrow();
    expect(() => rememberCameraChoice(throwing, null)).not.toThrow();
    expect(readCameraChoice(throwing)).toBeNull();
  });

  it("no storage at all is the same", () => {
    expect(readCameraChoice(null)).toBeNull();
    expect(() => rememberCameraChoice(null, "x")).not.toThrow();
  });

  it("ignores a stored value too long to be a device id", () => {
    const s = memoryStore();
    s.data.set(CAMERA_CHOICE_KEY, "x".repeat(600));
    expect(readCameraChoice(s)).toBeNull();
  });

  it("a remembered camera is asked for EXACTLY; nothing remembered keeps the rear-camera ask", () => {
    expect(videoConstraints("facetime-hd")).toMatchObject({ deviceId: { exact: "facetime-hd" } });
    expect(videoConstraints("facetime-hd")).not.toHaveProperty("facingMode");
    expect(videoConstraints(null)).toMatchObject({ facingMode: "environment" });
    expect(videoConstraints(null)).not.toHaveProperty("deviceId");
    // Both keep the receipt-readable size.
    expect(videoConstraints(null)).toMatchObject({ width: { ideal: 2560 }, height: { ideal: 1440 } });
  });

  it("a computer with nothing remembered asks for no facing, so the system's default webcam opens", () => {
    const c = videoConstraints(null, false);
    expect(c).not.toHaveProperty("facingMode");
    expect(c).not.toHaveProperty("deviceId");
    expect(c).toMatchObject({ width: { ideal: 2560 }, height: { ideal: 1440 } });
    // A remembered camera is still asked for exactly.
    expect(videoConstraints("facetime-hd", false)).toMatchObject({ deviceId: { exact: "facetime-hd" } });
  });
});

describe("cameraOptions: what the picker offers", () => {
  it("cameras only, in the system's order, with the system's labels", () => {
    const list = cameraOptions([
      { kind: "audioinput", deviceId: "mic", label: "MacBook Microphone" },
      { kind: "videoinput", deviceId: "a", label: "FaceTime HD Camera" },
      { kind: "videoinput", deviceId: "b", label: "Erik’s iPhone Camera" },
    ]);
    expect(list).toEqual([
      { deviceId: "a", label: "FaceTime HD Camera" },
      { deviceId: "b", label: "Erik’s iPhone Camera" },
    ]);
  });

  it("a camera with no label is named by its place, never a blank row", () => {
    const list = cameraOptions([
      { kind: "videoinput", deviceId: "a", label: "" },
      { kind: "videoinput", deviceId: "b" },
    ]);
    expect(list.map((c) => c.label)).toEqual(["Camera 1", "Camera 2"]);
  });

  it("drops rows with no id and repeats", () => {
    const list = cameraOptions([
      { kind: "videoinput", deviceId: "", label: "Ghost" },
      { kind: "videoinput", deviceId: "a", label: "One" },
      { kind: "videoinput", deviceId: "a", label: "One again" },
    ]);
    expect(list).toEqual([{ deviceId: "a", label: "One" }]);
  });
});

describe("cameraCountForReport: the count ops sees", () => {
  it("counts every camera once permission has given them ids", () => {
    expect(
      cameraCountForReport([
        { kind: "audioinput", deviceId: "mic" },
        { kind: "videoinput", deviceId: "a" },
        { kind: "videoinput", deviceId: "b" },
      ]),
    ).toBe("2");
  });

  it("before permission (ids empty) says 'at least', never 0", () => {
    expect(cameraCountForReport([{ kind: "videoinput", deviceId: "" }])).toBe("1+");
    // The picker would drop that row, which is why the report doesn't use it.
    expect(cameraOptions([{ kind: "videoinput", deviceId: "" }])).toEqual([]);
  });

  it("no camera at all is 0", () => {
    expect(cameraCountForReport([{ kind: "audioinput", deviceId: "" }])).toBe("0");
    expect(cameraCountForReport([])).toBe("0");
  });
});

describe("what a failure says", () => {
  it("every line ends on the photo door, so no failure is a dead end", () => {
    for (const name of [
      "NotAllowedError",
      "SecurityError",
      "NotFoundError",
      "OverconstrainedError",
      "NotReadableError",
      "AbortError",
      "NoMediaDevices",
      "TypeError",
      null,
    ]) {
      expect(cameraFailureLine(name).toLowerCase()).toContain("choose a photo");
      expect(cameraFailureLine(name, true).toLowerCase()).toContain("choose a photo");
    }
  });

  it("a blocked camera in the shell points at the North app's switch, not the browser's", () => {
    expect(cameraFailureLine("NotAllowedError", true)).toContain("Settings → North → Camera");
    expect(cameraFailureLine("NotAllowedError", false)).not.toContain("Settings → North");
  });

  it("the ops payload carries counts and names, nothing personal", () => {
    const extra = cameraFailureExtra({
      errorName: "NotReadableError",
      cameras: 2,
      frameArrived: false,
      remembered: true,
      native: false,
    });
    expect(extra).toEqual({
      error_name: "NotReadableError",
      cameras: "2",
      frame_arrived: "false",
      remembered_camera: "true",
      shell: "web",
    });
    // reportClientError keeps the first eight keys; every key has to fit its key pattern.
    expect(Object.keys(extra).length).toBeLessThanOrEqual(8);
    for (const k of Object.keys(extra)) expect(k).toMatch(/^[a-z0-9_]{1,40}$/i);
    expect(cameraFailureExtra({ cameras: 0, frameArrived: true, remembered: false, native: true })).toMatchObject({
      error_name: "none",
      frame_arrived: "true",
      shell: "native",
    });
  });
});
