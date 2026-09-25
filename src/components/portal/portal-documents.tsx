"use client";

import { useCallback, useRef, useState } from "react";
import { Box, ExternalLink, FileText, Maximize2, X } from "lucide-react";
import type { PortalDocument } from "@/lib/portal/job-view-shape";
import { PORTAL_DOC_KINDS } from "@/lib/portal/doc-kinds";
import { fmtDay } from "./portal-format";
import { TimedOut, iconBtn, useDeadLink, useDialog } from "./portal-media";

/**
 * THE CUSTOMER'S PLANS AND DRAWINGS (0326): every plan, permit, circuit map, drawing, rendering
 * and scan the office showed, the newest version of each only (the database picks it), grouped by
 * kind, each with its title and the day it was added (or "Updated" when it replaced an older one).
 *
 * How each file shows depends on what the file IS (doc-kinds docFormat):
 *   - a picture is drawn right on the page, and a tap opens it full screen;
 *   - a PDF opens in the page's own viewer, with Open Full Size beside it (a phone's browser may
 *     show a framed PDF one page at a time; its own viewer shows every page and zooms);
 *   - anything else (a 3D model, a point cloud, a file type the portal cannot draw) gets a plain
 *     Open The File link and a sentence saying what it is. THE SEAM: a 3D viewer for renderings
 *     and LiDAR scans plugs in where format is "model".
 *
 * Every URL is a 10-minute signed link the server minted for exactly this file (job-view.ts), and
 * the page reads itself again before they die (PortalKeepFresh on the job page).
 */
export function PortalDocuments({ documents, thisYear }: { documents: PortalDocument[]; thisYear: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    setOpenId(null);
    requestAnimationFrame(() => opener.current?.focus());
  }, []);
  const cur = documents.find((d) => d.id === openId) ?? null;
  const open = (d: PortalDocument, el: HTMLElement) => {
    opener.current = el;
    setOpenId(d.id);
  };

  // Grouped by kind in the page's order (the shape already sorted them).
  const groups: { key: string; label: string; items: PortalDocument[] }[] = [];
  for (const d of documents) {
    const g = groups.find((x) => x.key === d.kind);
    if (g) g.items.push(d);
    else {
      const k = PORTAL_DOC_KINDS.find((x) => x.key === d.kind);
      groups.push({ key: d.kind, label: k?.plural ?? d.kindLabel, items: [d] });
    }
  }

  return (
    <>
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.key}>
            <h3 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">{g.items.length > 1 ? g.label : g.items[0].kindLabel}</h3>
            <ul className="space-y-2">
              {g.items.map((d) => (
                <li key={d.id} className="min-w-0">
                  <DocCard d={d} thisYear={thisYear} onOpen={open} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <DocViewer d={cur} thisYear={thisYear} onClose={close} />
    </>
  );
}

/** "Added Aug 3", or "Updated Sep 24" for a newer version. The kind is the group's heading. */
function whenLine(d: PortalDocument, thisYear: string): string {
  const day = d.addedOn ? fmtDay(d.addedOn, thisYear) : "";
  return day ? `${d.isUpdate ? "Updated" : "Added"} ${day}` : "";
}
/** The viewer has no heading above it, so it says the kind too. */
function dateLine(d: PortalDocument, thisYear: string): string {
  const when = whenLine(d, thisYear);
  return when ? `${d.kindLabel} · ${when}` : d.kindLabel;
}

const action =
  "seaglass-btn inline-flex h-11 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]";

function DocCard({ d, thisYear, onOpen }: { d: PortalDocument; thisYear: string; onOpen: (d: PortalDocument, el: HTMLElement) => void }) {
  const img = d.format === "image" ? d.url : null;
  const { dead, onError } = useDeadLink(img);
  return (
    <div className="portal-glass rounded-2xl p-3">
      <div className="flex items-start gap-3 px-1">
        <div className="min-w-0 flex-1">
          <div className="[overflow-wrap:anywhere] font-semibold text-slate-900">{d.title}</div>
          {whenLine(d, thisYear) ? <div className="text-sm text-slate-700">{whenLine(d, thisYear)}</div> : null}
        </div>
      </div>

      {d.format === "image" ? (
        <button
          type="button"
          onClick={(e) => onOpen(d, e.currentTarget)}
          className="group relative mt-2 block w-full overflow-hidden rounded-xl bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]"
          aria-label={`Open ${d.title} full screen`}
        >
          {dead ? (
            <TimedOut className="h-40 w-full" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={d.url} alt={d.title} loading="lazy" decoding="async" onError={onError} className="max-h-[60vh] w-full object-contain" />
          )}
          <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md bg-black/55 px-2 py-1 text-xs font-medium text-white">
            <Maximize2 className="h-3.5 w-3.5" aria-hidden /> Full Screen
          </span>
        </button>
      ) : d.format === "pdf" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={(e) => onOpen(d, e.currentTarget)} className={action}>
            <FileText className="h-4 w-4" aria-hidden />
            <span>Open The {d.kindLabel}</span>
          </button>
          <a href={d.url} target="_blank" rel="noopener noreferrer" className={action}>
            <ExternalLink className="h-4 w-4" aria-hidden />
            <span>Open Full Size</span>
          </a>
        </div>
      ) : (
        <div className="mt-2">
          <p className="px-1 text-sm text-slate-700">
            {d.format === "model"
              ? "A 3D file. It opens in an app that reads 3D files, or saves to your phone to open later."
              : "This file opens in a new tab, or saves to your phone to open later."}
          </p>
          <a href={d.url} target="_blank" rel="noopener noreferrer" className={`${action} mt-2`}>
            {d.format === "model" ? <Box className="h-4 w-4" aria-hidden /> : <ExternalLink className="h-4 w-4" aria-hidden />}
            <span>Open The File</span>
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * The full-screen viewer: a picture at full size, or a PDF in a frame. A native <dialog> opened
 * with showModal() (focus trapped, Escape closes, the page behind is inert), as the photos use.
 */
function DocViewer({ d, thisYear, onClose }: { d: PortalDocument | null; thisYear: string; onClose: () => void }) {
  const dialog = useDialog(d !== null, onClose);
  return (
    <dialog
      ref={dialog}
      aria-label={d ? `${d.title}, ${dateLine(d, thisYear)}` : "Plan"}
      className="portal-dialog m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-transparent p-0 text-white"
    >
      {d ? (
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{d.title}</div>
              <div className="truncate text-xs text-white/80">{dateLine(d, thisYear)}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <a href={d.url} target="_blank" rel="noopener noreferrer" className={iconBtn} aria-label="Open full size in a new tab">
                <ExternalLink className="h-5 w-5" aria-hidden />
              </a>
              <button type="button" onClick={onClose} className={iconBtn} aria-label="Close" autoFocus>
                <X className="h-6 w-6" aria-hidden />
              </button>
            </div>
          </div>
          <div
            className="flex flex-1 items-center justify-center overflow-auto px-2 pb-[max(1rem,env(safe-area-inset-bottom))]"
            onClick={(e) => e.target === e.currentTarget && onClose()}
          >
            {d.format === "pdf" ? (
              <iframe key={d.url} src={d.url} title={d.title} className="h-full w-full rounded-lg bg-white" />
            ) : (
              <ViewerImage key={d.url} src={d.url} alt={d.title} />
            )}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

function ViewerImage({ src, alt }: { src: string; alt: string }) {
  const { dead, onError } = useDeadLink(src);
  if (dead) return <TimedOut className="rounded-lg px-4 py-6 text-sm" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} onError={onError} className="max-h-full max-w-full rounded-lg object-contain motion-safe:animate-[cn-fade_0.16s_ease-out_both]" />
  );
}
