"use client";

import { useRef, useState, useTransition } from "react";
import { AudioLines, CheckCircle2, Mic, MicOff } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label, Textarea } from "@/components/ui/input";
import { formatDuration } from "@/lib/utils";
import { fileDailyReport, type DailyReportSummary } from "./actions";

type Field = "did" | "mats";

/**
 * The crew-lead end-of-day debrief — Nort asks the two questions the moment a crew
 * lead clocks out: "What did you do today?" and "What materials do you need
 * tomorrow?" Dictation-first (the same Web Speech pattern as the timeclock notes
 * field, one mic per question), because the answerer is standing in a driveway.
 * Submit files it via fileDailyReport (upsert — one report per org-local day), the
 * server attaches the GPS story of the day, and the confirmation shows exactly what
 * Nort filed for office editing. Skippable — the clock-out already happened; this
 * never blocks going home.
 *
 * ADOPTION (audit 2026-07-16): fully wired end-to-end (crew_lead toggle in Edit
 * Member → this debrief → upsert → planner card → /timecards review) but ZERO
 * prod use so far — no profile has crew_lead=true, daily_reports is empty. It's
 * waiting on Erik flagging crew leads, not on missing code. Don't re-flag as junk.
 */
export function DailyReportDebrief({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [did, setDid] = useState("");
  const [mats, setMats] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<DailyReportSummary | null>(null);

  // Web Speech dictation (Chrome/Safari) — one recognizer, pointed at one field at a time.
  const [listening, setListening] = useState<Field | null>(null);
  const recogRef = useRef<any>(null);
  const speechSupported =
    typeof window !== "undefined" &&
    ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);

  function toggleDictation(field: Field) {
    if (listening) {
      // Detach onend BEFORE stopping — a late onend from the old recognizer would
      // otherwise clear the listening state of the one we're about to start.
      if (recogRef.current) recogRef.current.onend = null;
      recogRef.current?.stop();
      setListening(null);
      if (listening === field) return; // tapped the active mic — just stop
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.continuous = true;
    r.interimResults = false;
    r.lang = "en-US";
    r.onresult = (e: any) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
      }
      const set = field === "did" ? setDid : setMats;
      set((prev) => (prev ? prev + " " : "") + text.trim());
    };
    r.onend = () => setListening(null);
    r.start();
    recogRef.current = r;
    setListening(field);
  }

  function submit() {
    setError(null);
    start(async () => {
      try {
        const res = await fileDailyReport({ did_today: did, materials_tomorrow: mats });
        if (!res.ok) return setError(res.error ?? "Could not file the report.");
        setFiled(res.summary ?? { total_hours: 0, miles: 0, first_in: null, last_out: null, jobs: [] });
      } catch {
        setError("No connection — your answers are kept, try again when you have bars.");
      }
    });
  }

  function close() {
    recogRef.current?.stop();
    setListening(null);
    onClose();
  }

  const micButton = (field: Field) =>
    speechSupported ? (
      <button
        type="button"
        onClick={() => toggleDictation(field)}
        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ${
          listening === field ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
        }`}
      >
        {listening === field ? (
          <>
            <MicOff className="h-4 w-4 shrink-0" /> Stop
          </>
        ) : (
          <>
            <Mic className="h-4 w-4 shrink-0" /> Dictate
          </>
        )}
      </button>
    ) : null;

  return (
    <Modal
      open={open}
      onClose={close}
      title="Nort — end of day"
      dirty={!filed && (!!did.trim() || !!mats.trim())}
      footer={
        filed ? (
          <ModalActions onCancel={close} onSave={close} saveLabel="Done" hideCancel />
        ) : (
          <ModalActions
            onCancel={close}
            onSave={submit}
            saving={pending}
            saveLabel="File Report"
            cancelLabel="Skip"
            disabled={!did.trim() && !mats.trim()}
          />
        )
      }
    >
      {filed ? (
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-xl border border-green-200 bg-green-50/60 p-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
            <div className="text-sm">
              <div className="font-semibold text-slate-900">Confirmed by Nort — filed for the office.</div>
              <div className="mt-0.5 text-xs text-slate-500">The office can review and edit it on Crew Hours.</div>
            </div>
          </div>
          {did.trim() && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">What you did today</div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{did.trim()}</p>
            </div>
          )}
          {mats.trim() && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Materials for tomorrow</div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{mats.trim()}</p>
            </div>
          )}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">GPS tells the story</div>
            <p className="mt-1 text-sm text-slate-700">
              {formatDuration(filed.total_hours)} worked
              {filed.miles > 0 ? ` · ${filed.miles} mi` : ""}
              {filed.jobs.length
                ? ` · ${filed.jobs.map((j) => `${j.label} (${formatDuration(j.hours)})`).join(", ")}`
                : ""}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-xl border border-brand/30 bg-brand/5 p-3">
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white">
              <AudioLines className="h-4 w-4" />
            </span>
            <p className="text-sm text-slate-700">
              You&apos;re clocked out — before you go, two quick questions for the office. Nort files your
              answers with the day&apos;s GPS story (hours, miles, time on each job).
            </p>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label className="mb-0" htmlFor="dr-did">What did you do today?</Label>
              {micButton("did")}
            </div>
            <Textarea
              id="dr-did"
              rows={3}
              placeholder="Finished the panel swap, pulled homeruns for the addition…"
              value={did}
              onChange={(e) => setDid(e.target.value)}
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label className="mb-0" htmlFor="dr-mats">What materials do you need tomorrow?</Label>
              {micButton("mats")}
            </div>
            <Textarea
              id="dr-mats"
              rows={3}
              placeholder="A stick of 3/4 EMT, two 20A breakers, wire nuts…"
              value={mats}
              onChange={(e) => setMats(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
