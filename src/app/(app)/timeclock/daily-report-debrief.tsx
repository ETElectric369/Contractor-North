"use client";

import { useRef, useState, useTransition } from "react";
import { AudioLines, CheckCircle2, Mic, MicOff } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label, Textarea } from "@/components/ui/input";
import { formatDuration } from "@/lib/utils";
import { useDictation } from "@/lib/use-dictation";
import { fillText, translator } from "@/lib/i18n";
import { useLang } from "@/components/lang-provider";
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
  const t = translator(useLang());
  const [did, setDid] = useState("");
  const [mats, setMats] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<DailyReportSummary | null>(null);

  // Dictation — the shared press-to-talk turn (MediaRecorder → /api/transcribe), one mic pointed at
  // one field at a time. Raw SpeechRecognition had no onerror, so on iOS the mic failed silently.
  const activeField = useRef<Field | null>(null);
  const [listening, setListening] = useState<Field | null>(null);
  const dictation = useDictation((text) => {
    const set = activeField.current === "did" ? setDid : setMats;
    set((prev) => (prev ? prev + " " : "") + text.trim());
  });
  const speechSupported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  function toggleDictation(field: Field) {
    if (dictation.recording) {
      // Stop first; the turn transcribes into the field it was started on. Tap again to start the other.
      dictation.stop();
      setListening(null);
      return;
    }
    activeField.current = field;
    setListening(field);
    void dictation.start();
  }

  function submit() {
    setError(null);
    start(async () => {
      try {
        const res = await fileDailyReport({ did_today: did, materials_tomorrow: mats });
        if (!res.ok) return setError(res.error ?? t("tc_couldNotFileReport"));
        setFiled(res.summary ?? { total_hours: 0, miles: 0, first_in: null, last_out: null, jobs: [] });
      } catch {
        setError(t("tc_offlineAnswersKept"));
      }
    });
  }

  function close() {
    dictation.cancel(); // leaving the screen: mic released, audio discarded
    setListening(null);
    onClose();
  }

  const micButton = (field: Field) =>
    speechSupported ? (
      <button
        type="button"
        onClick={() => toggleDictation(field)}
        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ${
          dictation.recording && listening === field ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
        }`}
      >
        {dictation.recording && listening === field ? (
          <>
            <MicOff className="h-4 w-4 shrink-0" /> {t("tc_stop")}
          </>
        ) : (
          <>
            <Mic className="h-4 w-4 shrink-0" /> {dictation.transcribing && listening === field ? "…" : t("tc_dictate")}
          </>
        )}
      </button>
    ) : null;

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("tc_nortEndOfDay")}
      dirty={!filed && (!!did.trim() || !!mats.trim())}
      footer={
        filed ? (
          <ModalActions onCancel={close} onSave={close} saveLabel={t("tc_done")} hideCancel />
        ) : (
          <ModalActions
            onCancel={close}
            onSave={submit}
            saving={pending}
            saveLabel={t("tc_fileReport")}
            cancelLabel={t("tc_skip")}
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
              <div className="font-semibold text-slate-900">{t("tc_confirmedByNort")}</div>
              {/* Where the office reads it now: My Day's Daily reports card (cn-v958), with Mark
                  Reviewed. "Crew Hours" was the Timeclock's door card to Timecards, gone in Wave 2,
                  and Timecards no longer holds the reports (tc_officeReadsMyDay). */}
              <div className="mt-0.5 text-xs text-slate-500">{t("tc_officeReadsMyDay")}</div>
            </div>
          </div>
          {did.trim() && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("tc_whatYouDidToday")}</div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{did.trim()}</p>
            </div>
          )}
          {mats.trim() && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("tc_materialsTomorrow")}</div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{mats.trim()}</p>
            </div>
          )}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("tc_gpsTellsStory")}</div>
            <p className="mt-1 text-sm text-slate-700">
              {fillText(t("tc_worked"), { hours: formatDuration(filed.total_hours) })}
              {filed.miles > 0 ? ` · ${fillText(t("tc_milesShort"), { miles: String(filed.miles) })}` : ""}
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
            <p className="text-sm text-slate-700">{t("tc_debriefIntro")}</p>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label className="mb-0" htmlFor="dr-did">{t("tc_whatToday")}</Label>
              {micButton("did")}
            </div>
            <Textarea
              id="dr-did"
              rows={3}
              placeholder={t("tc_didPlaceholder")}
              value={did}
              onChange={(e) => setDid(e.target.value)}
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label className="mb-0" htmlFor="dr-mats">{t("tc_whatMaterialsTomorrow")}</Label>
              {micButton("mats")}
            </div>
            <Textarea
              id="dr-mats"
              rows={3}
              placeholder={t("tc_matsPlaceholder")}
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
