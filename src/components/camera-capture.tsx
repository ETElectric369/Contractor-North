"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type RefObject } from "react";
import { Camera, X, RotateCcw, Check, Loader2, ImageUp } from "lucide-react";
import { useModalLock } from "./ui/modal-lock";
import { Button } from "./ui/button";
import { reportClientError } from "@/app/report-client-error";
import { isNativeShell } from "@/lib/native-shell";
import {
  BLACK_FRAME_LINE,
  BLACK_SAMPLE_SIZE,
  DARK_PREVIEW_HINT_MS,
  FIRST_FRAME_TIMEOUT_MS,
  NO_FRAME_LINE,
  cameraFailureExtra,
  cameraFailureLine,
  cameraOptions,
  frameReady,
  isMostlyBlack,
  readCameraChoice,
  rememberCameraChoice,
  videoConstraints,
  type CameraBranch,
  type CameraOption,
  type ChoiceStorage,
} from "@/lib/camera-frame";

/**
 * Where the modal is:
 *   starting  asking for the camera, or waiting for its first real picture (the shutter is shut)
 *   live      a picture has arrived; the shutter is open
 *   encoding  a capture is being saved as a JPEG
 *   shot      the capture, with Retake / Use Photo
 *   refused   a capture was refused (black, or it couldn't be saved); the camera is still running
 *   failed    the camera isn't running, and `message` says why
 */
export type CameraPhase = "starting" | "live" | "encoding" | "shot" | "refused" | "failed";

/** Shown in the live view when the camera has sent nothing but black for a few seconds. */
export const DARK_PREVIEW_LINE = "The camera is only sending black so far. Try another camera, or choose a photo instead.";

const ENCODE_FAILED_LINE = "That picture couldn't be saved. Try again, or choose a photo instead.";
const TRACK_ENDED_LINE = "The camera stopped. Try again, or choose a photo instead.";

function errorName(e: unknown): string {
  if (e && typeof e === "object" && "name" in e) return String((e as { name: unknown }).name || "Error");
  return "Error";
}

function localStore(): ChoiceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Shrink a frame to a small square and ask whether it's black. A read that fails (no 2D
 *  context, a browser that won't hand back pixels) is NOT black: refusing on a guess would lock
 *  out a camera that works. */
function looksBlack(source: CanvasImageSource, scratch: { current: HTMLCanvasElement | null }): boolean {
  try {
    const c = scratch.current ?? document.createElement("canvas");
    scratch.current = c;
    c.width = BLACK_SAMPLE_SIZE;
    c.height = BLACK_SAMPLE_SIZE;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.clearRect(0, 0, BLACK_SAMPLE_SIZE, BLACK_SAMPLE_SIZE);
    ctx.drawImage(source, 0, 0, BLACK_SAMPLE_SIZE, BLACK_SAMPLE_SIZE);
    return isMostlyBlack(ctx.getImageData(0, 0, BLACK_SAMPLE_SIZE, BLACK_SAMPLE_SIZE).data);
  } catch {
    return false;
  }
}

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * THE IN-BROWSER CAMERA: the webcam on a computer, and the camera on a phone for the doors that
 * don't hand off to the phone's own camera app. Returns the picture as a File through
 * onCapture, or a photo the person chose instead (always offered, and offered alone when the
 * camera can't open). See lib/camera-frame.ts for the black-picture bug this was rebuilt for.
 *
 * The <video> is mounted for the modal's whole life and the capture is laid OVER it, so Retake
 * returns to the same running stream. Every track is stopped on Use Photo, on a chosen file, on
 * Close, on a camera switch, on a failure, and on unmount.
 */
export function CameraCapture({
  onCapture,
  onClose,
}: {
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<File | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  // Every camera start bumps the generation; a callback from an older start sees it's stale and
  // does nothing (a switched camera, a closed modal, StrictMode's double effect).
  const genRef = useRef(0);
  const shotSeqRef = useRef(0);
  const frameArrivedRef = useRef(false);
  const cleanupsRef = useRef<Array<() => void>>([]);
  const reportedRef = useRef<Set<CameraBranch>>(new Set());
  const camerasRef = useRef<CameraOption[]>([]);
  const rememberedRef = useRef(false);

  const [phase, setPhase] = useState<CameraPhase>("starting");
  const [message, setMessage] = useState<string | null>(null);
  const [darkHint, setDarkHint] = useState(false);
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  useModalLock(true); // hide the bottom nav so it can't cover Capture / Use Photo

  /** Make every camera start in flight stale (a close, a Use Photo, a chosen file, unmount). */
  const cancelStarts = useCallback(() => {
    genRef.current++;
  }, []);

  const clearWatchers = useCallback(() => {
    for (const fn of cleanupsRef.current) fn();
    cleanupsRef.current = [];
  }, []);

  const stopStream = useCallback(() => {
    clearWatchers();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [clearWatchers]);

  const refreshCameras = useCallback(async (): Promise<CameraOption[]> => {
    try {
      const list = cameraOptions(await navigator.mediaDevices.enumerateDevices());
      camerasRef.current = list;
      setCameras(list);
      return list;
    } catch {
      return camerasRef.current;
    }
  }, []);

  const report = useCallback(
    (branch: CameraBranch, name: string | null, cameraCount?: number) => {
      if (reportedRef.current.has(branch)) return;
      reportedRef.current.add(branch);
      void reportClientError(
        "camera",
        branch,
        cameraFailureExtra({
          errorName: name,
          cameras: cameraCount ?? camerasRef.current.length,
          frameArrived: frameArrivedRef.current,
          remembered: rememberedRef.current,
          native: isNativeShell(),
        }),
      ).catch(() => {});
    },
    [],
  );

  const fail = useCallback(
    (branch: CameraBranch, name: string | null, line?: string) => {
      stopStream();
      setPhase("failed");
      setDarkHint(false);
      setMessage(line ?? cameraFailureLine(name, isNativeShell()));
      // Count the cameras before reporting: "no frame from one of two cameras" and "no frame from
      // the only camera" are different findings. Without permission the count still comes back.
      // (refreshCameras never throws: no mediaDevices at all is an empty list.)
      void refreshCameras().then((list) => report(branch, name, list.length));
    },
    [refreshCameras, report, stopStream],
  );

  /** Wait for a REAL picture: the ready gate (readyState + size), and on browsers that have it,
   *  a requestVideoFrameCallback, which fires only once a frame was actually presented. */
  const watchFirstFrame = useCallback(
    (gen: number) => {
      const v = videoRef.current as VideoWithFrameCallback | null;
      if (!v) return;
      const arrived = () => {
        if (gen !== genRef.current) return true;
        if (!frameReady(v)) return false;
        frameArrivedRef.current = true;
        clearWatchers();
        setPhase("live");
        return true;
      };
      if (typeof v.requestVideoFrameCallback === "function") {
        let handle = 0;
        const onFrame = () => {
          if (!arrived()) handle = v.requestVideoFrameCallback!(onFrame);
        };
        handle = v.requestVideoFrameCallback(onFrame);
        cleanupsRef.current.push(() => v.cancelVideoFrameCallback?.(handle));
      } else {
        let raf = 0;
        const tick = () => {
          if (!arrived()) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        cleanupsRef.current.push(() => cancelAnimationFrame(raf));
      }
      // Belt and braces for an engine whose frame callback never fires for a camera stream:
      // playback time moving forward means pictures are flowing, and the gate still has to hold.
      const onTime = () => {
        if (v.currentTime > 0) arrived();
      };
      v.addEventListener("timeupdate", onTime);
      cleanupsRef.current.push(() => v.removeEventListener("timeupdate", onTime));
      // A hidden page gets no frames at all, so the clock only runs out while the modal is seen.
      let timer: ReturnType<typeof setTimeout>;
      const arm = () => {
        timer = setTimeout(() => {
          if (gen !== genRef.current || frameArrivedRef.current) return;
          if (typeof document !== "undefined" && document.hidden) arm();
          else fail("no-frame", null, NO_FRAME_LINE);
        }, FIRST_FRAME_TIMEOUT_MS);
      };
      arm();
      cleanupsRef.current.push(() => clearTimeout(timer));
    },
    [clearWatchers, fail],
  );

  const start = useCallback(
    async (deviceId: string | null): Promise<void> => {
      const gen = ++genRef.current;
      stopStream();
      frameArrivedRef.current = false;
      rememberedRef.current = !!deviceId;
      setPhase("starting");
      setMessage(null);
      setDarkHint(false);
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        fail("no-media-devices", "NoMediaDevices");
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(deviceId), audio: false });
      } catch (e) {
        if (gen !== genRef.current) return;
        const name = errorName(e);
        // The remembered camera is gone (unplugged, or a different computer's id): forget it and
        // open the default instead of failing on a choice nobody can see.
        if (deviceId && (name === "OverconstrainedError" || name === "NotFoundError")) {
          rememberCameraChoice(localStore(), null);
          return start(null);
        }
        fail("getusermedia-rejected", name);
        return;
      }
      if (gen !== genRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const openedId = track?.getSettings?.().deviceId ?? deviceId;
      setCameraId(openedId ?? null);
      if (track) {
        const onEnded = () => {
          if (gen === genRef.current) {
            stopStream();
            setPhase("failed");
            setMessage(TRACK_ENDED_LINE);
          }
        };
        track.addEventListener("ended", onEnded);
      }
      // Labels only exist once permission is granted, so the list is read now, not before.
      void refreshCameras();
      const v = videoRef.current;
      if (!v) {
        stopStream();
        return;
      }
      v.srcObject = stream;
      watchFirstFrame(gen);
      try {
        await v.play();
      } catch {
        // autoplay + muted normally makes this moot; the frame watch decides either way.
      }
    },
    [fail, refreshCameras, stopStream, watchFirstFrame],
  );

  // Open the camera once, with the one this browser was told to use last time.
  useEffect(() => {
    void start(readCameraChoice(localStore()));
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    const onDeviceChange = () => void refreshCameras();
    md?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      md?.removeEventListener?.("devicechange", onDeviceChange);
      cancelStarts();
      stopStream();
    };
  }, [cancelStarts, refreshCameras, start, stopStream]);

  // Let go of the last capture's object URL when it's replaced or the modal closes.
  useEffect(() => {
    if (!shotUrl) return;
    return () => URL.revokeObjectURL(shotUrl);
  }, [shotUrl]);

  // A live camera that sends nothing but black says so after a few seconds (the shutter stays
  // open: a warming camera goes black briefly, and a dark subject is the person's call).
  useEffect(() => {
    if (phase !== "live") return;
    let darkSince: number | null = null;
    const id = setInterval(() => {
      const v = videoRef.current;
      if (!frameReady(v)) return;
      if (looksBlack(v!, scratchRef)) {
        darkSince ??= Date.now();
        if (Date.now() - darkSince >= DARK_PREVIEW_HINT_MS) setDarkHint(true);
      } else {
        darkSince = null;
        setDarkHint(false);
      }
    }, 500);
    return () => clearInterval(id);
  }, [phase]);

  function snap() {
    const v = videoRef.current;
    if (phase !== "live" || !frameReady(v)) return;
    const canvas = document.createElement("canvas");
    canvas.width = v!.videoWidth;
    canvas.height = v!.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setPhase("refused");
      setMessage(ENCODE_FAILED_LINE);
      report("encode-failed", "NoContext");
      return;
    }
    ctx.drawImage(v!, 0, 0, canvas.width, canvas.height);
    if (looksBlack(canvas, scratchRef)) {
      setPhase("refused");
      setMessage(BLACK_FRAME_LINE);
      report("black-frame", null);
      return;
    }
    const seq = ++shotSeqRef.current;
    fileRef.current = null;
    setPhase("encoding");
    setMessage(null);
    canvas.toBlob(
      (blob) => {
        if (seq !== shotSeqRef.current) return;
        if (!blob) {
          setPhase("refused");
          setMessage(ENCODE_FAILED_LINE);
          report("encode-failed", "NullBlob");
          return;
        }
        fileRef.current = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
        setShotUrl(URL.createObjectURL(blob));
        setPhase("shot");
      },
      "image/jpeg",
      0.9,
    );
  }

  function retake() {
    shotSeqRef.current++;
    fileRef.current = null;
    setShotUrl(null);
    setMessage(null);
    if (streamRef.current && frameReady(videoRef.current)) setPhase("live");
    else void start(cameraId);
  }

  function tryAgain() {
    if (phase === "refused" && streamRef.current) retake();
    else void start(cameraId);
  }

  function pickCamera(id: string) {
    if (!id || id === cameraId) return;
    rememberCameraChoice(localStore(), id);
    setShotUrl(null);
    fileRef.current = null;
    void start(id);
  }

  function usePhoto() {
    if (phase !== "shot" || !fileRef.current) return;
    const file = fileRef.current;
    cancelStarts();
    stopStream();
    onCapture(file);
  }

  function chooseFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    cancelStarts();
    stopStream();
    onCapture(file);
  }

  function close() {
    cancelStarts();
    stopStream();
    onClose();
  }

  return (
    <CameraCaptureView
      phase={phase}
      message={message}
      darkHint={darkHint}
      cameras={cameras}
      cameraId={cameraId}
      shotUrl={shotUrl}
      videoRef={videoRef}
      fileInputRef={fileInputRef}
      onSnap={snap}
      onRetake={retake}
      onUse={usePhoto}
      onTryAgain={tryAgain}
      onPickCamera={pickCamera}
      onChooseFile={chooseFile}
      onClose={close}
    />
  );
}

/** What the camera modal looks like in each phase. No effects and no browser APIs, so every
 *  state renders in a test exactly as it renders on screen. */
export function CameraCaptureView({
  phase,
  message,
  darkHint,
  cameras,
  cameraId,
  shotUrl,
  videoRef,
  fileInputRef,
  onSnap,
  onRetake,
  onUse,
  onTryAgain,
  onPickCamera,
  onChooseFile,
  onClose,
}: {
  phase: CameraPhase;
  message: string | null;
  darkHint: boolean;
  cameras: CameraOption[];
  cameraId: string | null;
  shotUrl: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onSnap: () => void;
  onRetake: () => void;
  onUse: () => void;
  onTryAgain: () => void;
  onPickCamera: (deviceId: string) => void;
  onChooseFile: (e: ChangeEvent<HTMLInputElement>) => void;
  onClose: () => void;
}) {
  const showPicker = cameras.length > 1 && phase !== "shot" && phase !== "encoding";
  const selected = cameras.some((c) => c.deviceId === cameraId) ? cameraId! : "";
  const line = message ?? (phase === "live" && darkHint ? DARK_PREVIEW_LINE : null);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Take A Photo"
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 py-1 pl-4 pr-1">
          <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Camera className="h-4 w-4" /> Take A Photo
          </span>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" title="Close">
            <X />
          </Button>
        </div>

        <div className="relative min-h-56 bg-slate-900">
          {/* Mounted for the modal's whole life: Retake returns to this same running stream. */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            aria-label="Camera preview"
            className={`max-h-[60vh] w-full object-contain ${phase === "failed" ? "invisible" : ""}`}
          />
          {phase === "starting" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/80">
              <Loader2 className="h-6 w-6 animate-spin" />
              Waiting for the camera…
            </div>
          )}
          {phase === "encoding" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-900 text-sm text-white/80">
              <Loader2 className="h-6 w-6 animate-spin" />
              Saving the picture…
            </div>
          )}
          {phase === "shot" && shotUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shotUrl} alt="Captured" className="absolute inset-0 h-full w-full bg-slate-900 object-contain" />
          )}
          {(phase === "refused" || phase === "failed") && (
            <div role="alert" className="absolute inset-0 flex items-center justify-center bg-slate-900 px-6 text-center text-sm text-white">
              {message}
            </div>
          )}
        </div>

        {line && phase !== "refused" && phase !== "failed" && (
          <p role="status" className="border-b border-slate-100 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            {line}
          </p>
        )}

        <div className="flex flex-col gap-2 px-4 py-3">
          {showPicker && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <span className="shrink-0 font-medium">Camera</span>
              <select
                value={selected}
                onChange={(e) => onPickCamera(e.target.value)}
                className="h-11 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-900"
              >
                {!selected && <option value="">Choose A Camera</option>}
                {cameras.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="flex items-center justify-center gap-3">
            {phase === "shot" || phase === "encoding" ? (
              <>
                <Button variant="outline" onClick={onRetake}>
                  <RotateCcw /> Retake
                </Button>
                <Button onClick={onUse} disabled={phase !== "shot"}>
                  {phase === "encoding" ? <Loader2 className="animate-spin" /> : <Check />} Use Photo
                </Button>
              </>
            ) : phase === "refused" || phase === "failed" ? (
              <>
                <Button onClick={onTryAgain}>
                  <RotateCcw /> Try Again
                </Button>
                <Button variant="outline" onClick={onClose}>
                  Close
                </Button>
              </>
            ) : (
              <Button size="lg" className="rounded-full" onClick={onSnap} disabled={phase !== "live"}>
                <Camera /> Capture
              </Button>
            )}
          </div>

          <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
            <ImageUp /> Choose A Photo Instead
          </Button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onChooseFile} />
        </div>
      </div>
    </div>
  );
}
