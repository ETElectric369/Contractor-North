"use client";

import { useRef, useState, useSyncExternalStore } from "react";

/**
 * FILE DRAG-AND-DROP, ONE PRIMITIVE (Erik: "we should have it app wide for where it makes sense
 * like on the inspector, plans, all that jazz, the button area could be the shadow drag and drop
 * zone").
 *
 * Every upload door in the app is a button wired to a hidden <input type="file"> whose handler
 * already takes File[] — so a drop is just a SECOND way into the SAME handler, never a second
 * upload path. Wrap the button (or the whole card) in <DropTarget onFiles={...}>: invisible in
 * normal use, and the moment a file drag enters the window every mounted target reveals itself
 * as a dashed "shadow" zone; the one under the cursor lights up; dropping hands the files over.
 *
 * The rules, each load-bearing:
 *   · GATE ON FILES ONLY — every listener checks dataTransfer.types.includes("Files"), so text,
 *     contact-card, and element drags (the killed Safari-freeze experiment's territory) never
 *     activate anything.
 *   · NEVER GATE ON TOUCH — HTML5 file-drag events simply don't fire on a touch-only iPhone, so
 *     the primitive is naturally inert there; a touch check would wrongly kill iPad, which drags
 *     real files from Split View and is an explicit target.
 *   · DRAGOVER DOES ALMOST NOTHING — it fires continuously; its handler only preventDefaults.
 *     Highlight state changes ride dragenter/dragleave with a depth counter (children re-fire
 *     them), the Safari-weight lesson.
 *   · Buttons stay the universal way in. A drop that matches nothing says so briefly instead of
 *     silently eating the file (NOTHING SILENT).
 */

// ── Window-level "a file drag is happening" store (one set of listeners, many targets). ──
let dragDepth = 0;
let dragActive = false;
let wired = false;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    if (!dragActive) {
      dragActive = true;
      notify();
    }
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && dragActive) {
      dragActive = false;
      notify();
    }
  });
  // Without these two, dropping anywhere outside a target NAVIGATES the tab to the file.
  window.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    if (hasFiles(e)) e.preventDefault();
    dragDepth = 0;
    if (dragActive) {
      dragActive = false;
      notify();
    }
  });
}

const subscribe = (cb: () => void) => {
  wire();
  subs.add(cb);
  return () => subs.delete(cb);
};

/** True while a FILE drag is anywhere over the window — what reveals the shadow zones. */
export function useFileDragActive(): boolean {
  return useSyncExternalStore(subscribe, () => dragActive, () => false);
}

function matchesAccept(file: File, accept?: string): boolean {
  if (!accept) return true;
  const type = (file.type || "").toLowerCase();
  const name = file.name.toLowerCase();
  return accept.split(",").some((raw) => {
    const a = raw.trim().toLowerCase();
    if (!a) return false;
    if (a.startsWith(".")) return name.endsWith(a);
    if (a.endsWith("/*")) return type.startsWith(a.slice(0, -1));
    return type === a;
  });
}

export function DropTarget({
  onFiles,
  accept,
  multiple = true,
  disabled = false,
  label = "Drop files here",
  className,
  children,
}: {
  /** The SAME File[] handler the door's hidden input feeds — never a parallel path. */
  onFiles: (files: File[]) => void;
  /** Mirror the door's own accept= attr; non-matching drops are refused out loud. */
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const active = useFileDragActive();
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState(false);
  const depthRef = useRef(0);
  const refuseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (disabled) return <div className={className}>{children}</div>;

  return (
    <div
      className={`relative ${className ?? ""}`}
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
        depthRef.current++;
        setOver(true);
      }}
      onDragLeave={() => {
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (depthRef.current === 0) setOver(false);
      }}
      onDragOver={(e) => {
        // Continuous event: preventDefault only (Safari weight rule) — no state here.
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        depthRef.current = 0;
        setOver(false);
        const dropped = Array.from(e.dataTransfer.files ?? []);
        const files = dropped.filter((f) => matchesAccept(f, accept));
        if (!files.length) {
          // The wrong file type gets an answer, not silence.
          setRefused(true);
          if (refuseTimer.current) clearTimeout(refuseTimer.current);
          refuseTimer.current = setTimeout(() => setRefused(false), 2000);
          return;
        }
        onFiles(multiple ? files : files.slice(0, 1));
      }}
    >
      {children}
      {(active || refused) && (
        <div
          className={`pointer-events-none absolute -inset-1 z-10 flex items-center justify-center rounded-xl border-2 border-dashed text-xs font-semibold backdrop-blur-[1px] transition-colors ${
            refused
              ? "border-red-400 bg-red-50/90 text-red-600"
              : over
                ? "border-brand bg-brand-light/80 text-brand"
                : "border-brand/40 bg-white/75 text-brand/80"
          }`}
        >
          {refused ? "That file type doesn't go here" : label}
        </div>
      )}
    </div>
  );
}
