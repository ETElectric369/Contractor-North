"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { isNativeShell } from "@/lib/native-shell";
import { saveRoute, type SaveRoute } from "@/lib/shell-save";
import { fileNameFromDisposition } from "@/lib/download-name";
import { reportClientError } from "@/app/report-client-error";
import { downloadVerdict, expectedType, type DownloadWant } from "@/lib/download-response";

/**
 * ONE DOWNLOAD BUTTON (cn-v1138), with the accountant download's mechanics (cn-v1118) pulled into a
 * hook every file door shares — the accountant's two buttons and the company export's one.
 *
 * A plain download link hands a route's refusals ("for the office only", "couldn't be read just
 * now") to the browser's download manager, where nobody reads them. So the button FETCHES the file,
 * says any refusal on the card in the route's own words (lib/download-response), and saves the file
 * under the route's own name (Content-Disposition).
 *
 * IN THE iOS SHELL a blob link can't save (WebKit in the app has no download manager, see
 * shell-save.ts and the media lightbox), so the file goes to the share sheet (Save to Files, Mail,
 * AirDrop). The sheet only opens while the tap is still warm, and making the file takes a moment:
 * if the sheet says the tap went cold, the file is kept and one more tap, Save The File, opens it
 * with nothing in between. A phone that can't share files is told so, in words.
 *
 * SIGNED OUT, OR NOT THE FILE: the fetch never follows a redirect (the middleware's answer to a
 * lost session is a redirect to the login page), and anything that isn't the file is said in words
 * and never saved.
 */

export const MAKING_IT = "Making It…";
export const SAVE_THE_FILE = "Save The File";
export const READY_WORDS = "It's ready. Tap Save The File to choose where it goes.";
export const SHARE_REFUSED_WORDS = "Couldn't open the share sheet. Open North in Safari, or on a computer, and download it there.";
export const CANT_HAND_OVER_WORDS = "This phone can't hand the file over from inside the app. Open North in Safari, or on a computer, and download it there.";
export const CONNECTION_DROPPED_WORDS = "The download didn't come through: the connection dropped. Try again.";

export type FetchedFile = { ok: true; blob: Blob; name: string; type: string } | { ok: false; words: string };

/**
 * The fetch and the verdict, with no React in it: the route's refusal in words, or the file with
 * the name the route gave it (the caller's fallback name otherwise) and its type.
 */
export async function fetchTheFile(
  href: string,
  want: DownloadWant,
  fallbackName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedFile> {
  const res = await fetchImpl(href, { cache: "no-store", redirect: "manual" });
  const verdict = downloadVerdict(
    {
      ok: res.ok,
      status: res.status,
      type: res.type,
      redirected: res.redirected,
      contentType: res.headers.get("content-type"),
      disposition: res.headers.get("content-disposition"),
      body: res.ok ? undefined : await res.text().catch(() => ""),
    },
    want,
  );
  if (!verdict.ok) return verdict;
  const blob = await res.blob();
  const name = fileNameFromDisposition(res.headers.get("content-disposition")) || fallbackName;
  return { ok: true, blob, name, type: expectedType(want) };
}

/** Where a fetched file goes: a browser saves it, the shell hands it to the share sheet when it can. */
export function routeFor(file: File, inShell: boolean, nav: Pick<Navigator, "share" | "canShare"> | undefined): SaveRoute {
  const canShareFile = !!nav && typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: [file] });
  return saveRoute({ inShell, fileReady: true, canShareFile, shareFailed: false });
}

/** The browser's save: an <a download> clicked once, the object URL let go after. */
export function saveThroughAnchor(blob: Blob, name: string, doc: Document = document, urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL): void {
  const url = urls.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => urls.revokeObjectURL(url), 10_000);
}

/**
 * The mechanics as a hook, so a card with two file doors (the accountant's workbook and its CSV
 * zip) shares one busy state, one line of words and one kept file.
 */
export function useFileDownload() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [ready, setReady] = useState<File | null>(null);

  function share(file: File, secondTap: boolean) {
    return navigator.share({ files: [file] }).then(
      () => {
        setReady(null);
        setSaid(null);
      },
      (err: unknown) => {
        const name = err instanceof Error ? err.name : "";
        // Closing the sheet without picking anything is a choice, not a failure.
        if (name === "AbortError") return;
        if (name === "NotAllowedError" && !secondTap) {
          setReady(file);
          setSaid(READY_WORDS);
          return;
        }
        setReady(null);
        setSaid(null);
        setError(SHARE_REFUSED_WORDS);
        void reportClientError("shell-navigation", "Download: the share sheet refused the file", {
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          type: file.type,
          bytes: file.size,
        });
      },
    );
  }

  /** Fetch one file and save or share it; `key` is which door is busy while it runs. */
  async function get(key: string, href: string, opts: { want: DownloadWant; fileName: string }) {
    setBusy(key);
    setError(null);
    setSaid(null);
    setReady(null);
    try {
      const got = await fetchTheFile(href, opts.want, opts.fileName);
      if (!got.ok) {
        setError(got.words);
        return;
      }
      const inShell = isNativeShell();
      if (inShell) {
        const file = new File([got.blob], got.name, { type: got.type });
        if (routeFor(file, inShell, navigator) !== "share-sheet") {
          setError(CANT_HAND_OVER_WORDS);
          return;
        }
        await share(file, false);
        return;
      }
      saveThroughAnchor(got.blob, got.name);
      setSaid(`Downloaded ${got.name}.`);
    } catch {
      setError(CONNECTION_DROPPED_WORDS);
    } finally {
      setBusy(null);
    }
  }

  return { busy, error, said, ready, get, share };
}

const VARIANTS = {
  primary: "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-medium text-white disabled:opacity-60",
  outline: "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60",
  link: "inline-flex min-h-[44px] items-center justify-center self-start px-1 text-sm font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 disabled:opacity-60",
} as const;

/**
 * One file door: the button, Save The File when the shell kept the file, and the words under it.
 * `want` is what the route answers (a zip unless said otherwise), judged before anything is saved.
 */
export function DownloadButton({
  href,
  fileName,
  label,
  busyLabel = MAKING_IT,
  className,
  variant = "primary",
  want = "zip",
  disabled = false,
}: {
  href: string;
  fileName: string;
  label: string;
  busyLabel?: string;
  className?: string;
  variant?: keyof typeof VARIANTS;
  want?: DownloadWant;
  disabled?: boolean;
}) {
  const { busy, error, said, ready, get, share } = useFileDownload();
  return (
    <div className={className ?? "flex flex-col gap-2"}>
      <button type="button" onClick={() => void get("file", href, { want, fileName })} disabled={disabled || busy !== null} className={VARIANTS[variant]}>
        <Download className="h-4 w-4" /> {busy ? busyLabel : label}
      </button>
      {ready && (
        <button type="button" onClick={() => void share(ready, true)} disabled={disabled || busy !== null} className={VARIANTS.outline}>
          <Download className="h-4 w-4" /> {SAVE_THE_FILE}
        </button>
      )}
      {said && !error && (
        <p role="status" className="text-xs text-slate-600">
          {said}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
