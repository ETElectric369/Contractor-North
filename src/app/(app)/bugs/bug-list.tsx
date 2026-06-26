"use client";

import { useState } from "react";
import { Image as ImageIcon, Check, X, RotateCcw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { setBugReportStatus, type BugReport } from "@/app/(app)/bug-report-actions";

const TABS = [
  { key: "open", label: "Open" },
  { key: "fixed", label: "Fixed" },
  { key: "wontfix", label: "Won't fix" },
  { key: "all", label: "All" },
] as const;

const statusOf = (r: BugReport) => r.status || "open";

export function BugList({ initial }: { initial: BugReport[] }) {
  const [reports, setReports] = useState<BugReport[]>(initial);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("open");

  function setStatus(id: string, status: string) {
    // Optimistic: the server action (RLS staff-gated) runs in the background.
    setReports((p) => p.map((r) => (r.id === id ? { ...r, status } : r)));
    setBugReportStatus(id, status);
  }

  async function viewShot(path: string) {
    try {
      const { data } = await createClient().storage.from("documents").createSignedUrl(path, 3600);
      if (data?.signedUrl) window.open(data.signedUrl, "_blank");
    } catch {
      /* ignore */
    }
  }

  const shown = reports.filter((r) => tab === "all" || statusOf(r) === tab);
  const openCount = reports.filter((r) => statusOf(r) === "open").length;

  return (
    <div>
      <div className="mb-3 flex gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key ? "bg-brand text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {t.label}
            {t.key === "open" && openCount > 0 ? ` (${openCount})` : ""}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-400">
          {tab === "open" ? "Nothing open — all clear." : "Nothing here."}
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {shown.map((r) => {
            const st = statusOf(r);
            return (
              <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className={`text-sm ${st !== "open" ? "text-slate-400 line-through" : "text-slate-800"}`}>{r.note}</div>
                  <div className="mt-0.5 truncate text-xs text-slate-400">
                    {r.page ?? ""}
                    {r.reporter ? ` · ${r.reporter}` : ""}
                    {r.created_at ? ` · ${new Date(r.created_at).toLocaleDateString()}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  {r.screenshot_path && (
                    <button onClick={() => viewShot(r.screenshot_path!)} title="View screenshot" className="text-slate-400 hover:text-brand">
                      <ImageIcon className="h-4 w-4" />
                    </button>
                  )}
                  {st === "open" ? (
                    <>
                      <button onClick={() => setStatus(r.id, "fixed")} title="Mark fixed" className="flex items-center gap-1 text-xs text-slate-400 hover:text-green-600">
                        <Check className="h-3.5 w-3.5" /> fixed
                      </button>
                      <button onClick={() => setStatus(r.id, "wontfix")} title="Won't fix" className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-700">
                        <X className="h-3.5 w-3.5" /> won&apos;t
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setStatus(r.id, "open")} title="Re-open" className="flex items-center gap-1 text-xs text-slate-400 hover:text-amber-600">
                      <RotateCcw className="h-3.5 w-3.5" /> re-open
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
