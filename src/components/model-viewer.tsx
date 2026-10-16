"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, Download, Loader2, X } from "lucide-react";
import { arPreviewPresent, openInAr } from "@/lib/native-scan";

/**
 * THE 3D VIEWER (Lidar, 3D Scan). Erik 2026-10-16: "it would render an image just fine,
 * i want that." A scanned model — the USDZ from 3D Scan, or a GLB someone dropped from
 * Polycam — drawn right here with three.js (its USD loader reads Apple's binary USD, so one file
 * serves the phone, the office and the portal): spin, zoom, pan. On an iPhone, Open In AR hands
 * the same file to Apple's AR viewer, which drops it into the room.
 *
 * OPEN IN AR: in the North app the bytes the viewer drew go to the shell, which opens Apple's Quick
 * Look with its AR tab (a rel="ar" link is Safari's door and the app's web view ignores it; Erik,
 * 10-16). In Safari on an iPhone the rel="ar" link stays. Anywhere else there is no AR button.
 *
 * three.js is loaded only when the viewer opens (a dynamic import), never in the page's bundle.
 * A file the viewer cannot draw says so in one sentence and still offers the file itself. The
 * overlay is portaled onto <body>: inside a blurred card (the portal's glass) a fixed box would be
 * clipped to the card (skeptic #18). Everything three.js made is disposed on close — geometry,
 * materials, textures and the WebGL context — because iOS caps live contexts.
 */

export type ModelKind = "usdz" | "gltf";

/** What kind of 3D file a name is, by its extension (a signed URL's query string ignored). */
export function modelKind(pathOrName: string | null | undefined): ModelKind | null {
  const p = String(pathOrName ?? "").split("?")[0];
  if (/\.usdz$/i.test(p)) return "usdz";
  if (/\.(glb|gltf)$/i.test(p)) return "gltf";
  return null;
}

/** AR Quick Look wants an <img> as the link's child: a transparent pixel does. */
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function isIPhone(): boolean {
  return typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function ModelViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [why, setWhy] = useState<string | null>(null);
  const [ar, setAr] = useState<"idle" | "opening" | "failed">("idle");
  const [arWhy, setArWhy] = useState<string | null>(null);
  /** The model's bytes as drawn, kept for Open In AR (fetched once, by the loader). */
  const bytesRef = useRef<Uint8Array | null>(null);
  const kind = modelKind(name) ?? modelKind(url);
  const inShell = arPreviewPresent();

  async function openAr() {
    if (ar === "opening") return;
    setAr("opening");
    setArWhy(null);
    try {
      let bytes = bytesRef.current;
      if (!bytes) {
        const res = await fetch(url);
        if (!res.ok) throw new Error("the file didn't download");
        bytes = new Uint8Array(await res.arrayBuffer());
        bytesRef.current = bytes;
      }
      const r = await openInAr(bytes, name);
      if (!r.ok) {
        setArWhy(r.refused);
        setAr("failed");
        return;
      }
      setAr("idle");
    } catch (e: unknown) {
      setArWhy((e as { message?: string })?.message ?? "it didn't open");
      setAr("failed");
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    let dispose = () => {};
    (async () => {
      const el = mount.current;
      if (!el) return;
      try {
        if (!kind) throw new Error("not a 3D file this viewer reads");
        const THREE = await import("three");
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
        if (!alive) return;
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(el.clientWidth, el.clientHeight);
        el.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        let raf = 0;
        let controls: { update(): void; dispose(): void } | null = null;
        let onResize: (() => void) | null = null;
        // Disposal is armed the moment the context exists, so a load that fails or a close mid-load
        // still frees it; it also tears down whatever the scene holds by then.
        dispose = () => {
          cancelAnimationFrame(raf);
          if (onResize) window.removeEventListener("resize", onResize);
          controls?.dispose();
          scene.traverse((o) => {
            const mesh = o as import("three").Mesh;
            mesh.geometry?.dispose?.();
            const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
            for (const m of mats) {
              for (const v of Object.values(m as unknown as Record<string, unknown>)) {
                if (v && typeof v === "object" && "isTexture" in (v as object)) (v as import("three").Texture).dispose();
              }
              m.dispose();
            }
          });
          renderer.dispose();
          renderer.forceContextLoss();
          if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
        };
        scene.background = new THREE.Color(0x0f172a);
        const camera = new THREE.PerspectiveCamera(50, el.clientWidth / Math.max(el.clientHeight, 1), 0.01, 1000);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.6));
        const sun = new THREE.DirectionalLight(0xffffff, 1.2);
        sun.position.set(3, 6, 4);
        scene.add(sun);
        let object: import("three").Object3D;
        if (kind === "usdz") {
          const { USDLoader } = await import("three/examples/jsm/loaders/USDLoader.js");
          object = await new USDLoader().loadAsync(url);
        } else {
          const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
          object = (await new GLTFLoader().loadAsync(url)).scene;
        }
        if (!alive) return;
        // Centre the model and back the camera off to fit it, whatever its size in meters.
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        object.position.sub(center);
        scene.add(object);
        const radius = Math.max(size.x, size.y, size.z, 0.1);
        camera.position.set(radius * 0.9, radius * 0.6, radius * 1.3);
        camera.near = radius / 200;
        camera.far = radius * 200;
        camera.updateProjectionMatrix();
        const orbit = new OrbitControls(camera, renderer.domElement);
        orbit.enableDamping = true;
        orbit.target.set(0, 0, 0);
        controls = orbit;
        onResize = () => {
          const w = el.clientWidth, h = Math.max(el.clientHeight, 1);
          renderer.setSize(w, h);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        };
        window.addEventListener("resize", onResize);
        const loop = () => {
          orbit.update();
          renderer.render(scene, camera);
          raf = requestAnimationFrame(loop);
        };
        loop();
        setStatus("ready");
      } catch (e: unknown) {
        if (!alive) return;
        const msg = (e as { message?: string })?.message;
        setWhy(msg && msg.trim() ? msg : "it didn't load");
        setStatus("failed");
      }
    })();
    return () => {
      alive = false;
      dispose();
    };
  }, [url, kind]);

  const link = "inline-flex h-10 items-center gap-2 rounded-lg bg-white/10 px-3 text-sm font-semibold text-white hover:bg-white/20";
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[120] flex flex-col bg-slate-950" role="dialog" aria-modal="true" aria-label={name}>
      <div className="flex items-center gap-2 px-3 pb-2 pt-[max(0.5rem,var(--sat,0px))] text-white">
        <Box className="h-5 w-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</div>
        {kind === "usdz" && inShell ? (
          <button type="button" onClick={() => void openAr()} disabled={ar === "opening"} className={link}>
            {ar === "opening" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Open In AR
          </button>
        ) : kind === "usdz" && isIPhone() ? (
          <a rel="ar" href={url} className={link}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={PIXEL} alt="" width={1} height={1} />
            Open In AR
          </a>
        ) : null}
        <a href={url} target="_blank" rel="noopener noreferrer" className={link} aria-label="Open The File">
          <Download className="h-4 w-4" aria-hidden />
        </a>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-2 hover:bg-white/10">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div ref={mount} className="relative min-h-0 flex-1">
        {status === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/80">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading the model…
          </div>
        )}
        {status === "failed" && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white/90">
            Couldn&apos;t draw this 3D file here ({why}). Open The File opens it in an app that reads 3D files{isIPhone() ? "" : ", or on an iPhone"}.
          </div>
        )}
      </div>
      {ar === "failed" && arWhy && <p className="px-3 pt-2 text-center text-xs text-amber-300">Couldn&apos;t open it in AR: {arWhy}</p>}
      <p className="px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] text-center text-xs text-white/60">Drag to turn · pinch or scroll to zoom · two fingers to move</p>
    </div>,
    document.body,
  );
}
