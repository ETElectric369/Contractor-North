"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { isNativeShell } from "@/lib/native-shell";
import { saveRoute } from "@/lib/shell-save";
import { fileNameFromDisposition } from "@/lib/download-name";
import { reportClientError } from "@/app/report-client-error";
import { XLSX_TYPE, ZIP_TYPE, downloadVerdict } from "./download-response";
import { useOpeningPeriod } from "./period-picker";

/**
 * DOWNLOAD FOR YOUR ACCOUNTANT, AND THE SAME THING AS CSV FILES.
 *
 * A plain download link hands the route's refusals ("for the office only", "couldn't be read just
 * now") to the browser's download manager, where nobody reads them. So this fetches the file, says
 * any refusal on the card in the route's own words, and saves the file under the route's own name.
 *
 * IN THE iOS SHELL a blob link can't save (WebKit in the app has no download manager, see
 * shell-save.ts and the media lightbox), so the file goes to the share sheet (Save to Files, Mail,
 * AirDrop). The sheet only opens while the tap is still warm, and making the workbook takes a
 * moment: if the sheet says the tap went cold, the file is kept and one more tap, Save The File,
 * opens it with nothing in between. A phone that can't share files is told so, in words.
 *
 * SIGNED OUT, OR NOT THE FILE: the fetch never follows a redirect (the middleware's answer to a
 * lost session is a redirect to the login page), and anything that isn't the file is said in words
 * and never saved (download-response.ts). While a newly picked period opens, all three wait, and
 * the page keys this card on the period, so a file kept for Save The File never outlives its period.
 */
export function AccountantDownload({ xlsxHref, csvHref, xlsxName, csvName }: { xlsxHref: string; csvHref: string; xlsxName: string; csvName: string }) {
  const [busy, setBusy] = useState<"xlsx" | "csv" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [ready, setReady] = useState<File | null>(null);
  const opening = useOpeningPeriod();

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
          setSaid("It's ready. Tap Save The File to choose where it goes.");
          return;
        }
        setReady(null);
        setSaid(null);
        setError("Couldn't open the share sheet. Open North in Safari, or on a computer, and download it there.");
        void reportClientError("shell-navigation", "Accountant download: the share sheet refused the file", {
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          type: file.type,
          bytes: file.size,
        });
      },
    );
  }

  async function get(which: "xlsx" | "csv") {
    setBusy(which);
    setError(null);
    setSaid(null);
    setReady(null);
    try {
      const res = await fetch(which === "xlsx" ? xlsxHref : csvHref, { cache: "no-store", redirect: "manual" });
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
        which,
      );
      if (!verdict.ok) {
        setError(verdict.words);
        return;
      }
      const blob = await res.blob();
      const name = fileNameFromDisposition(res.headers.get("content-disposition")) || (which === "xlsx" ? xlsxName : csvName);
      const type = which === "xlsx" ? XLSX_TYPE : ZIP_TYPE;
      const inShell = isNativeShell();
      if (inShell) {
        const file = new File([blob], name, { type });
        const canShareFile = typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
        if (saveRoute({ inShell, fileReady: true, canShareFile, shareFailed: false }) !== "share-sheet") {
          setError("This phone can't hand the file over from inside the app. Open North in Safari, or on a computer, and download it there.");
          return;
        }
        await share(file, false);
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setSaid(`Downloaded ${name}.`);
    } catch {
      setError("The download didn't come through: the connection dropped. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => get("xlsx")}
        disabled={busy !== null || opening !== null}
        className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-medium text-white disabled:opacity-60"
      >
        <Download className="h-4 w-4" /> {busy === "xlsx" ? "Making It…" : "Download For Your Accountant"}
      </button>
      <button
        type="button"
        onClick={() => get("csv")}
        disabled={busy !== null || opening !== null}
        className="inline-flex min-h-[44px] items-center justify-center self-start px-1 text-sm font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 disabled:opacity-60"
      >
        {busy === "csv" ? "Making It…" : "Same Thing As CSV Files"}
      </button>
      {ready && (
        <button
          type="button"
          onClick={() => void share(ready, true)}
          disabled={busy !== null || opening !== null}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          <Download className="h-4 w-4" /> Save The File
        </button>
      )}
      {opening ? (
        <p role="status" className="text-xs text-slate-600">
          Opening {opening}…
        </p>
      ) : (
        <p className="text-xs text-slate-500">File: {xlsxName}</p>
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
