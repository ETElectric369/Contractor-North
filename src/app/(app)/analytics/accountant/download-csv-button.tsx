"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";

/**
 * DOWNLOAD CSV, SAID IN WORDS WHEN IT CAN'T COME (Export For Accountant). A plain download link hands
 * the route's refusals ("office-only", "couldn't be recorded, so it wasn't made") to the browser's
 * download manager, where nobody reads them. This fetches the file, says any refusal on the card,
 * saves the file under the route's own name, and refreshes the page so Recent Downloads shows it.
 */
export function DownloadCsvButton({ href, fallbackName }: { href: string; fallbackName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(href, { cache: "no-store" });
      if (!res.ok) {
        const said = (await res.text().catch(() => "")).trim();
        setError(said && said.length < 400 ? said : "The download didn't come through. Nothing was made; try again.");
        return;
      }
      const blob = await res.blob();
      const named = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = named || fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      router.refresh();
    } catch {
      setError("The download didn't come through: the connection dropped. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-stretch gap-1 sm:items-end">
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
      >
        <Download className="h-4 w-4" /> {busy ? "Making It…" : "Download CSV"}
      </button>
      {error && (
        <p role="alert" className="max-w-xs text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
