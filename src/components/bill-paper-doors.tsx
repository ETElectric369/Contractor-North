"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import { MediaLightbox } from "@/components/media-lightbox";
import type { BillPaper } from "@/lib/job-photos";

/**
 * A BILL'S OWN PAPER, ON ITS ROW (Erik, 2026-09-27: bills and job photos kept separate). The receipt
 * that used to sit in the job's Photos grid opens from the bill it made: a 44px door with the picture
 * itself as its face (a page icon for a PDF), and its word, "Receipt". One copy for the job's Costs
 * tab and the bill's row on /bills. A paper whose link couldn't be made says so, never a dead tap.
 */
export function BillPaperDoors({ papers }: { papers?: readonly BillPaper[] | null }) {
  const [viewing, setViewing] = useState<BillPaper | null>(null);
  if (!papers?.length) return null;
  const face = (p: BillPaper) =>
    p.kind === "image" && p.url ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={p.url} alt="" className="h-9 w-9 shrink-0 rounded-md object-cover" />
    ) : (
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-100">
        <FileText className="h-4 w-4 text-slate-400" />
      </span>
    );
  const door = "inline-flex h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white pl-1 pr-3 text-sm font-medium text-slate-700 hover:bg-slate-50";
  return (
    <>
      {papers.map((p) =>
        !p.url ? (
          <span key={p.id} className="inline-flex min-h-11 items-center text-xs text-slate-500">
            The {p.label.toLowerCase()} couldn&apos;t load just now. Reload to try again.
          </span>
        ) : p.kind === "file" ? (
          <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className={door} title={p.name}>
            {face(p)}
            {p.label}
          </a>
        ) : (
          <button key={p.id} type="button" onClick={() => setViewing(p)} className={door} title={p.name} aria-label={`Open the ${p.label.toLowerCase()}: ${p.name}`}>
            {face(p)}
            {p.label}
          </button>
        ),
      )}
      {viewing?.url && <MediaLightbox url={viewing.url} name={viewing.name} onClose={() => setViewing(null)} />}
    </>
  );
}
