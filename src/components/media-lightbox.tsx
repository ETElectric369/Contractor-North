"use client";

import { useEffect } from "react";
import { X, ExternalLink, Download } from "lucide-react";

/** Full-screen in-app viewer for an image or PDF — always dismissible
 *  (fixes "can't go back from the photo" on the phone). */
export function MediaLightbox({
  url,
  name,
  onClose,
}: {
  url: string;
  name: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const isPdf = /\.pdf($|\?)/i.test(url) || /\.pdf$/i.test(name);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/90">
      <div className="flex items-center justify-between gap-2 px-4 py-3 text-white">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        <a href={url} target="_blank" rel="noopener noreferrer" className="rounded-lg p-2 hover:bg-white/10" title="Open in new tab">
          <ExternalLink className="h-5 w-5" />
        </a>
        <a href={url} download={name} className="rounded-lg p-2 hover:bg-white/10" title="Download">
          <Download className="h-5 w-5" />
        </a>
        <button onClick={onClose} className="rounded-lg p-2 hover:bg-white/10" aria-label="Close">
          <X className="h-6 w-6" />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-auto p-2" onClick={onClose}>
        {isPdf ? (
          <iframe src={url} title={name} className="h-full w-full rounded bg-white" onClick={(e) => e.stopPropagation()} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={name}
            className="max-h-full max-w-full rounded object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
      <p className="pb-3 text-center text-xs text-white/50">Tap outside the image or the ✕ to close</p>
    </div>
  );
}
