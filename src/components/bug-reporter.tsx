"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { Bug, Check, Loader2, Image as ImageIcon } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { installErrorCapture, getLogs } from "@/lib/bug-buffer";
import { createBugReport, listBugReports, setBugReportStatus, type BugReport } from "@/app/(app)/bug-report-actions";

/** Grab a screenshot of what's on screen right now (oklch-safe via html2canvas-pro), as a
 *  compact JPEG. Best-effort — returns null on any failure so a report never blocks on it. */
async function captureScreen(): Promise<Blob | null> {
  try {
    const html2canvas = (await import("html2canvas-pro")).default;
    const canvas = await html2canvas(document.body, {
      backgroundColor: "#ffffff",
      scale: 0.6,
      useCORS: true,
      logging: false,
      // Skip the report button itself (and anything else flagged) so it's not in the shot.
      ignoreElements: (el) => (el as HTMLElement)?.getAttribute?.("data-bug-ignore") === "1",
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
    });
    return await new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", 0.6));
  } catch {
    return null;
  }
}

/** One-tap "Report a bug" button (staff only — mounted by the app layout). Auto-attaches
 *  the page, captured console errors, browser/viewport + reporter to each report, and
 *  shows the org's recent reports so the team can track what's logged/fixed. */
export function BugReporter({ orgId }: { orgId: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [capturing, setCapturing] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<BugReport[]>([]);
  const [errCount, setErrCount] = useState(0);
  const shotRef = useRef<Blob | null>(null);

  useEffect(() => {
    installErrorCapture();
  }, []);

  async function openPanel() {
    // Grab the screen they're looking at FIRST (before the dialog covers it), then open.
    setCapturing(true);
    shotRef.current = await captureScreen();
    setCapturing(false);
    setOpen(true);
    setSent(false);
    setNote("");
    setError(null);
    setErrCount(getLogs().filter((l) => l.level === "error").length);
    listBugReports().then(setReports).catch(() => {});
  }

  function submit() {
    const n = note.trim();
    if (!n) return setError("Tell me what happened.");
    setError(null);
    start(async () => {
      // Best-effort: upload the screenshot to the documents bucket (path starts with org_id
      // per the storage RLS). A failed upload never blocks the report.
      let screenshotPath: string | undefined;
      if (shotRef.current) {
        // Retry the upload — a single attempt drops the screenshot on a flaky connection
        // (e.g. reporting from the field while driving), which is exactly when we most want
        // it. upsert:true so a retry to the same path doesn't collide. Report sends regardless.
        const path = `${orgId}/bug-screenshots/${Date.now()}.jpg`;
        for (let attempt = 0; attempt < 3 && !screenshotPath; attempt++) {
          try {
            const { error: upErr } = await createClient().storage
              .from("documents")
              .upload(path, shotRef.current, { upsert: true, contentType: "image/jpeg" });
            if (!upErr) { screenshotPath = path; break; }
          } catch {
            /* fall through to retry */
          }
          if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      const res = await createBugReport({
        page: pathname + (typeof window !== "undefined" ? window.location.search : ""),
        note: n,
        console: getLogs(),
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        viewport: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : "",
        screenshotPath,
      });
      if (!res.ok) return setError(res.error ?? "Could not send.");
      shotRef.current = null;
      setSent(true);
      setNote("");
      listBugReports().then(setReports).catch(() => {});
    });
  }

  function markFixed(id: string) {
    setReports((p) => p.map((r) => (r.id === id ? { ...r, status: "fixed" } : r)));
    setBugReportStatus(id, "fixed");
  }

  async function viewShot(path: string) {
    try {
      const { data } = await createClient().storage.from("documents").createSignedUrl(path, 3600);
      if (data?.signedUrl) window.open(data.signedUrl, "_blank");
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <button
        onClick={openPanel}
        data-bug-ignore="1"
        disabled={capturing}
        title="Report a bug"
        aria-label="Report a bug"
        className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] right-4 z-[71] flex h-11 w-11 items-center justify-center rounded-full bg-slate-900 text-white shadow-lg transition hover:bg-slate-700 disabled:opacity-70 sm:bottom-4"
      >
        {capturing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Bug className="h-5 w-5" />}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Report a bug">
        <div className="space-y-4">
          {sent ? (
            <div className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
              <Check className="h-4 w-4" /> Sent — thanks. I&apos;ll pick it up on the next pass.
            </div>
          ) : (
            <div className="space-y-2">
              <Textarea rows={3} autoFocus placeholder="What happened? (e.g. clock-out wouldn't save)" value={note} onChange={(e) => setNote(e.target.value)} />
              <p className="text-xs text-slate-400">
                Auto-attached: a <span className="font-medium text-slate-500">screenshot</span> of this screen
                {shotRef.current ? " ✓" : ""}, this page (<span className="font-mono">{pathname}</span>)
                {errCount > 0 ? `, ${errCount} console error${errCount > 1 ? "s" : ""}` : ""}, your name + browser.
              </p>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button onClick={submit} disabled={pending} className="w-full">
                {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending</> : "Send report"}
              </Button>
            </div>
          )}

          {reports.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent reports</div>
              <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 text-sm">
                {reports.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-2 px-3 py-1.5">
                    <div className="min-w-0">
                      <div className={`truncate ${r.status === "fixed" ? "text-slate-400 line-through" : "text-slate-800"}`}>{r.note}</div>
                      <div className="truncate text-xs text-slate-400">{r.page ?? ""}{r.reporter ? ` · ${r.reporter}` : ""}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {r.screenshot_path && (
                        <button onClick={() => viewShot(r.screenshot_path!)} title="View screenshot" className="text-slate-400 hover:text-brand">
                          <ImageIcon className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {r.status === "fixed" ? (
                        <span className="text-xs text-green-600">fixed</span>
                      ) : (
                        <button onClick={() => markFixed(r.id)} className="text-xs text-slate-400 hover:text-green-600">mark fixed</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
