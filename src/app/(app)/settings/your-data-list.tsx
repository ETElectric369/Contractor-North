"use client";

import { useState } from "react";
import { DownloadButton } from "@/components/download-button";
import type { JobWithFiles } from "@/lib/export-files/jobs-with-files";
import { listJobsWithFiles } from "./your-data-actions";
import { filesWord } from "./your-data-words";

export const SHOW_MORE = "Show More";
export const LOADING_MORE = "Loading…";

/**
 * FILES BY JOB (cn-v1138): one row per job that has files — the job's label (the place, the number,
 * who), how many files, and its own Download door — the first page server-rendered through the
 * props, the next pages from the server action. A row that comes back twice (a job added between
 * two pages shifts the offsets) is kept once. A failed page is said under the list and nothing is
 * appended.
 */
export function YourDataList({ initial, total }: { initial: JobWithFiles[]; total: number }) {
  const [rows, setRows] = useState<JobWithFiles[]>(initial);
  const [known, setKnown] = useState(total);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function more() {
    setBusy(true);
    setError(null);
    try {
      const next = await listJobsWithFiles(rows.length);
      if ("error" in next) {
        setError(next.error);
        return;
      }
      const seen = new Set(rows.map((r) => r.id));
      setRows([...rows, ...next.rows.filter((r) => !seen.has(r.id))]);
      setKnown(next.total);
    } catch {
      setError("The next page didn't come through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <ul className="divide-y divide-slate-100">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-slate-900">{r.label}</p>
              <p className="text-xs text-slate-500">{filesWord(r.files)}</p>
            </div>
            <DownloadButton
              href={`/settings/export/job/${r.id}`}
              fileName={`${r.label}-files.zip`}
              label="Download"
              variant="link"
              want="zip"
              className="flex shrink-0 flex-col items-end gap-1"
            />
          </li>
        ))}
      </ul>
      {rows.length < known && (
        <button
          type="button"
          onClick={() => void more()}
          disabled={busy}
          className="mt-2 inline-flex min-h-[44px] items-center justify-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {busy ? LOADING_MORE : SHOW_MORE}
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
