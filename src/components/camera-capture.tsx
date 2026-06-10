"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, X, RotateCcw, Check, Loader2 } from "lucide-react";

/**
 * Opens the device camera (webcam on desktop, rear camera on phones) via
 * getUserMedia, lets the user snap a photo, and returns it as a File.
 */
export function CameraCapture({
  onCapture,
  onClose,
}: {
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<File | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          // Ask for a high-res stream — without this many devices hand back
          // 640×480 and receipt text becomes unreadable.
          video: {
            facingMode: "environment",
            width: { ideal: 2560 },
            height: { ideal: 1440 },
          },
          audio: false,
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          await videoRef.current.play();
          setReady(true);
        }
      } catch {
        setErr("Couldn't access the camera. Allow camera permission, or use Upload file.");
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const [encoding, setEncoding] = useState(false);

  function snap() {
    const v = videoRef.current;
    if (!v) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")?.drawImage(v, 0, 0);
    setShot(canvas.toDataURL("image/jpeg", 0.9));
    fileRef.current = null;
    setEncoding(true);
    canvas.toBlob(
      (blob) => {
        if (blob) fileRef.current = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
        setEncoding(false);
      },
      "image/jpeg",
      0.9,
    );
  }

  function usePhoto() {
    // toBlob is async — never let "Use photo" silently no-op mid-encode.
    if (!fileRef.current) return;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    onCapture(fileRef.current);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Camera className="h-4 w-4" /> Take a photo
          </span>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="relative bg-slate-900">
          {err ? (
            <div className="px-6 py-10 text-center text-sm text-white">{err}</div>
          ) : shot ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shot} alt="Captured" className="max-h-[60vh] w-full object-contain" />
          ) : (
            <>
              <video ref={videoRef} playsInline muted className="max-h-[60vh] w-full object-contain" />
              {!ready && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-white/70" />
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-center gap-3 px-4 py-3">
          {err ? (
            <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium">
              Close
            </button>
          ) : shot ? (
            <>
              <button onClick={() => setShot(null)} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700">
                <RotateCcw className="h-4 w-4" /> Retake
              </button>
              <button
                onClick={usePhoto}
                disabled={encoding}
                className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {encoding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Use photo
              </button>
            </>
          ) : (
            <button
              onClick={snap}
              disabled={!ready}
              className="inline-flex items-center gap-2 rounded-full bg-brand px-6 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              <Camera className="h-5 w-5" /> Capture
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
