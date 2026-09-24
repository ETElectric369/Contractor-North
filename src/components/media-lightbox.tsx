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

  useEffect(() => {
    if (!inShell || !shown) return;
    let live = true;
    // A new url must never share the previous file's bytes.
    setFile(null);
    fetchError.current = null;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const type = blob.type || (isPdf ? "application/pdf" : "application/octet-stream");
        if (live) setFile(new File([blob], name, { type }));
      })
      .catch((e: unknown) => {
        if (live) fetchError.current = e instanceof Error ? e.message : String(e);
      });
    return () => {
      live = false;
    };
  }, [inShell, shown, url, name, isPdf]);

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
        <a href={url} target="_blank" rel="noopener noreferrer" className="rounded-lg p-2 hover:bg-white/10" title="Open in new tab">
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
        <button onClick={onClose} className="rounded-lg p-2 hover:bg-white/10" aria-label="Close">
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
