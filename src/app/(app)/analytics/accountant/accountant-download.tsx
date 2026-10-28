"use client";

import { Download } from "lucide-react";
import { useFileDownload } from "@/components/download-button";
import { useOpeningPeriod } from "./period-picker";

/**
 * DOWNLOAD FOR YOUR ACCOUNTANT, AND THE SAME THING AS CSV FILES.
 *
 * A plain download link hands the route's refusals ("for the office only", "couldn't be read just
 * now") to the browser's download manager, where nobody reads them. So this fetches the file, says
 * any refusal on the card in the route's own words, and saves the file under the route's own name.
 * The mechanics — the fetch that never follows a redirect, the verdict (download-response.ts), the
 * blob link, the iOS shell's share sheet and its Save The File second tap — are useFileDownload
 * (components/download-button.tsx, cn-v1138), shared with the company export; this card keeps its
 * two doors on ONE busy state, one line of words and one kept file.
 *
 * While a newly picked period opens, all three wait, and the page keys this card on the period, so
 * a file kept for Save The File never outlives its period.
 */
export function AccountantDownload({ xlsxHref, csvHref, xlsxName, csvName }: { xlsxHref: string; csvHref: string; xlsxName: string; csvName: string }) {
  const { busy, error, said, ready, get: fetchFile, share } = useFileDownload();
  const opening = useOpeningPeriod();

  function get(which: "xlsx" | "csv") {
    return fetchFile(which, which === "xlsx" ? xlsxHref : csvHref, { want: which, fileName: which === "xlsx" ? xlsxName : csvName });
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
