"use client";

import { useEffect, useRef, useState } from "react";
import { X, ExternalLink, Download } from "lucide-react";
import { useModalLock } from "@/components/ui/modal-lock";
import { isNativeShell } from "@/lib/native-shell";
import { saveRoute } from "@/lib/shell-save";
import { reportClientError } from "@/app/report-client-error";

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
  // Use the shared REF-COUNTED body lock (not a raw document.body.style.overflow), so closing this
  // lightbox doesn't yank the lock out from under a camera overlay opened on top of it — the bottom nav
  // stays hidden until BOTH are closed (this is the recurring "Save hidden behind the nav" class).
  useModalLock(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isPdf = /\.pdf($|\?)/i.test(url) || /\.pdf$/i.test(name);

  // DOWNLOAD IN THE iOS SHELL (be3dca81). `<a href download>` to a signed Supabase URL is a save in
  // a browser, but in the shell WebKit drops `download` cross-origin and the tap navigated the app's
  // own WebView to the raw file: no chrome, no Back, restart the app. There the file goes to the
  // share sheet instead (Save to Files, Save Image), which closes back onto this lightbox. The sheet
  // needs the tap still warm, so the bytes are fetched once the file is on screen, not on the tap;
  // until they are (or if the sheet refuses them) the link opens in Safari, never in the app.
  // Browsers keep the plain download. The lightbox only mounts on a tap, so reading the user agent
  // in the initializer can't disagree with a server render.
  const [inShell] = useState(isNativeShell);
  const [shown, setShown] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [shareFailed, setShareFailed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fetchError = useRef<string | null>(null);
  const reported = useRef(false);

  // A PDF starts at once: WebKit in the shell may never fire load for a cross-origin PDF frame,
  // and waiting on it would send every PDF Download to Safari instead of the share sheet. ONE
  // fetch per file (audit v994 NF1): the effect keys on whether to start, not on `shown`, so the
  // PDF frame's own load (which sets `shown`) no longer aborts the download it started and begins
  // a second one; a 6 MB plan set was fetched twice on cellular, with Safari in the gap.
  const start = inShell && (isPdf || shown);
  useEffect(() => {
    if (!start) return;
    let live = true;
    // Closing the lightbox (or Back) mid-download stops the transfer instead of letting a
    // multi-MB file finish on cellular for nobody (review of the 09-23 wave).
    const ctl = new AbortController();
    // A new url must never share the previous file's bytes.
    setFile(null);
    fetchError.current = null;
    fetch(url, { signal: ctl.signal, cache: "force-cache" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const type = blob.type || (isPdf ? "application/pdf" : "application/octet-stream");
        if (live) setFile(new File([blob], withExtension(name, type), { type }));
      })
      .catch((e: unknown) => {
        if (!live || (e instanceof DOMException && e.name === "AbortError")) return;
        fetchError.current = e instanceof Error ? e.message : String(e);
      });
    return () => {
      live = false;
      ctl.abort();
    };
  }, [start, url, name, isPdf]);

  function onDownload(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!inShell) return; // a browser's own download, unchanged
    const canShareFile =
      !!file && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
    const route = saveRoute({ inShell, fileReady: !!file, canShareFile, shareFailed });
    if (route !== "share-sheet" || !file) {
      // Safari takes it (the link's own target=_blank). That works, but a fetch that failed means
      // the sheet can never have this file, and ops should see why.
      if (fetchError.current && !reported.current) {
        reported.current = true;
        void reportClientError("shell-navigation", "Lightbox download went to Safari: the file could not be fetched", {
          reason: fetchError.current,
          pdf: isPdf,
        });
      }
      return;
    }
    e.preventDefault();
    navigator.share({ files: [file] }).catch((err: unknown) => {
      // Closing the sheet without picking anything is a choice, not a failure.
      if (err instanceof Error && err.name === "AbortError") return;
      setShareFailed(true);
      setNote("Couldn't open the share sheet. Tap the download arrow again to open the file in Safari.");
      void reportClientError("shell-navigation", "Lightbox share sheet refused the file", {
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        type: file.type,
        bytes: file.size,
      });
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/90">
      <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-[max(0.75rem,var(--sat,0px))] text-white">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-white/10" title="Open in new tab" aria-label="Open in new tab">
          <ExternalLink className="h-5 w-5" />
        </a>
        <a
          href={url}
          {...(inShell ? { target: "_blank", rel: "noopener noreferrer" } : { download: name })}
          onClick={onDownload}
          className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-white/10"
          title="Download"
          aria-label="Download"
        >
          <Download className="h-5 w-5" />
        </a>
        <button onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-white/10" aria-label="Close">
          <X className="h-6 w-6" />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-auto p-2" onClick={onClose}>
        {isPdf ? (
          <iframe
            src={url}
            title={name}
            className="h-full w-full rounded bg-white"
            onClick={(e) => e.stopPropagation()}
            onLoad={() => setShown(true)}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={name}
            className="max-h-full max-w-full rounded object-contain"
            onClick={(e) => e.stopPropagation()}
            onLoad={() => setShown(true)}
          />
        )}
      </div>
      {note && (
        <p role="status" className="px-4 pb-2 text-center text-sm font-medium text-amber-200">
          {note}
        </p>
      )}
      <p className="pb-3 text-center text-xs text-white/50">Tap outside the image or the ✕ to close</p>
    </div>
  );
}

/** A renamed document ("Kitchen panel") has no extension, and Save to Files would write it with
 *  none. Add the one its type says, unless the name already ENDS in it.
 *
 *  "Already has an extension" used to mean any dot and two to five letters or digits at the end,
 *  so a receipt named "Home Depot — $47.44" or a plan named "Permit rev.12" kept ".44" and ".12"
 *  as its extension, and Files and Mail could not open what Save to Files wrote (audit v994 NF2).
 *  For a type this knows, only that type's own extension counts; an unknown type adds nothing. */
const EXTENSION_FOR: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/heic": ".heic",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
/** Other spellings a file of that type legitimately ends in. */
const ALSO_ENDS_IN: Record<string, string[]> = { ".jpg": [".jpeg"], ".heic": [".heif"] };
export function withExtension(name: string, type: string): string {
  const base = String(name || "file").trim() || "file";
  const ext = EXTENSION_FOR[String(type || "").toLowerCase().split(";")[0].trim()];
  if (!ext) return base;
  const lower = base.toLowerCase();
  if ([ext, ...(ALSO_ENDS_IN[ext] ?? [])].some((e) => lower.endsWith(e))) return base;
  return base + ext;
}
