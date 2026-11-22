"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { CheckCircle2, Mic, MicOff } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label, Select, Textarea } from "@/components/ui/input";
import { formatDuration } from "@/lib/utils";
import { useDictation } from "@/lib/use-dictation";
import { fillText, translator } from "@/lib/i18n";
import { useLang } from "@/components/lang-provider";
import { dailyReportJobChoices, fileDailyReport, type DailyReportJobChoices, type DailyReportSummary, type ReportJobOption } from "./actions";

type Field = "did" | "mats";

/** The jobs read still out after this lands in the didn't-load state (filing with no job stays open). */
const REPORT_JOBS_TIMEOUT_MS = 8_000;

/** The jobs the sheet offers, once read: that day's jobs first, then the jobs still being worked. */
export type ReportJobChoicesView =
  | { state: "loading" }
  | { state: "failed"; error: string }
  | { state: "ready"; decided: ReportJobOption | null; dayJobs: ReportJobOption[]; otherJobs: ReportJobOption[] };
type Choices = ReportJobChoicesView;

/**
 * READ THE JOBS, ONCE PER OPENING. A read that hangs never holds File Report disabled: after
 * REPORT_JOBS_TIMEOUT_MS it lands in the didn't-load state (you can still file with no job), and an
 * answer after that is not taken, so the job never changes under a person already filing. Returns
 * the cancel (the effect's cleanup).
 */
export function readReportJobs(
  load: () => Promise<DailyReportJobChoices>,
  didntLoad: string,
  done: (next: ReportJobChoicesView, decidedId: string | null) => void,
): () => void {
  let alive = true;
  const timer = setTimeout(() => {
    if (!alive) return;
    alive = false;
    done({ state: "failed", error: didntLoad }, null);
  }, REPORT_JOBS_TIMEOUT_MS);
  const settle = (next: ReportJobChoicesView, decidedId: string | null) => {
    if (!alive) return;
    alive = false;
    clearTimeout(timer);
    done(next, decidedId);
  };
  let p: Promise<DailyReportJobChoices>;
  try {
    p = load();
  } catch (e) {
    p = Promise.reject(e);
  }
  p.then(
    (res) =>
      res.ok
        ? settle({ state: "ready", decided: res.decided, dayJobs: res.dayJobs, otherJobs: res.otherJobs }, res.decided?.id ?? null)
        : settle({ state: "failed", error: res.error }, null),
    () => settle({ state: "failed", error: didntLoad }, null),
  );
  return () => {
    alive = false;
    clearTimeout(timer);
  };
}

/**
 * WHICH JOB: ALWAYS ASKED, with the day's job PRESELECTED when the day decided it (skeptic, cn-v1174:
 * a sentence alone left no way to change the job or to file with none). That day's jobs first, then
 * the jobs still being worked; No Job stays an option, and one quiet line says so.
 */
export function ReportJobLine({ choices, jobId, onPick }: { choices: ReportJobChoicesView; jobId: string; onPick: (id: string) => void }) {
  const t = translator(useLang());
  if (choices.state === "loading") return <p className="text-sm text-slate-500">{t("tc_loadingReportJobs")}</p>;
  const ready = choices.state === "ready" ? choices : null;
  return (
    <div>
      {choices.state === "failed" ? (
        <p className="text-sm text-slate-600">{choices.error}</p>
      ) : (
        <>
          <Label htmlFor="dr-job">{t("tc_whichJobReport")}</Label>
          <Select id="dr-job" className="min-h-11" value={jobId} onChange={(e) => onPick(e.target.value)}>
            <option value="">{t("tc_noJobOption")}</option>
            {ready && ready.dayJobs.length > 0 && (
              <optgroup label={t("tc_todaysJobs")}>
                {ready.dayJobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.label}
                  </option>
                ))}
              </optgroup>
            )}
            {ready && ready.otherJobs.length > 0 && (
              <optgroup label={t("tc_otherJobs")}>
                {ready.otherJobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.label}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </>
      )}
      {!jobId && <p className="mt-1.5 text-xs text-slate-500">{t("tc_reportInNoJobFile")}</p>}
    </div>
  );
}

/**
 * The crew-lead end-of-day debrief — Nort asks the moment a crew lead clocks out, from EITHER door
 * (the Time Clock page and My Day's Now card, one component, one rule: lib/daily-report-rule).
 * Dictation-first (one mic per line), because the answerer is standing in a driveway.
 *
 * ONE LINE LEADS (cn-v1174; the owner: "a one line entry for what did you do today"): What did you
 * do today?, then Materials for tomorrow as a second, optional line. Then WHICH JOB the report is
 * for, always asked: when the day's closed punches name exactly one job it is PRESELECTED; when they
 * name none, or more than one, nothing is, and the list offers that day's jobs first and the jobs
 * still being worked after them. Filing with no job is allowed, and one quiet line says the report
 * will not be in any job's file. One sheet, one report, one job (migration 0411).
 *
 * Submit files it via fileDailyReport (upsert on person, day and job), the server attaches the GPS
 * story of the day, and the confirmation shows exactly what Nort filed. Skippable — the clock-out
 * already happened; this never blocks going home.
 *
 * NEVER REMOUNTED WHILE OPEN (the Modal law): the panel keeps this mounted and flips `open`; a new
 * opening resets the fields with state, not with a key.
 *
 * `portal` (cn-v1174): the job page's clock button sits inside the action dock's glass bar, whose
 * backdrop-filter traps an in-place fixed overlay, so that door portals the sheet out (as its own
 * Clock Out sheet does). The other doors render it in place, as before.
 */
export function DailyReportDebrief({ open, onClose, portal = false }: { open: boolean; onClose: () => void; portal?: boolean }) {
  const t = translator(useLang());
  const [did, setDid] = useState("");
  const [mats, setMats] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<DailyReportSummary | null>(null);
  const [choices, setChoices] = useState<Choices>({ state: "loading" });
  const [jobId, setJobId] = useState("");

  // A NEW OPENING after a report was filed starts clean (state, never a key around the open Modal).
  // Words typed and not filed stay: "your answers are kept".
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      // Which job is asked afresh at every clock-out: the day may have moved on since.
      setChoices({ state: "loading" });
      setJobId("");
      if (filed) {
        setFiled(null);
        setDid("");
        setMats("");
        setError(null);
      }
    }
  }

  // The jobs are read when the sheet opens, after any "Which Job Are You On?" answer has landed;
  // a read that hangs lands in the didn't-load state (readReportJobs, above).
  useEffect(() => {
    if (!open) return;
    return readReportJobs(dailyReportJobChoices, t("tc_reportJobsDidntLoad"), (next, decidedId) => {
      setChoices(next);
      // The day names exactly one job (the server read the one rule): it is PRESELECTED, and the
      // person may still pick another, or No Job.
      if (decidedId) setJobId(decidedId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per opening
  }, [open]);

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
        const res = await fileDailyReport({ did_today: did, materials_tomorrow: mats, job_id: jobId || null });
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

  const ready = choices.state === "ready" ? choices : null;
  const jobLabelOf = (id: string): string | null =>
    !id || !ready ? null : ([...ready.dayJobs, ...ready.otherJobs].find((j) => j.id === id)?.label ?? null);
  return (
    <Modal
      open={open}
      onClose={close}
      title={t("tc_nortEndOfDay")}
      portal={portal}
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
            // Not while the job is still being read: a day that decides its job must not be filed on none.
            disabled={(!did.trim() && !mats.trim()) || choices.state === "loading"}
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
          <p className="text-sm text-slate-600">{jobLabelOf(jobId) ? fillText(t("tc_reportForJob"), { job: jobLabelOf(jobId) as string }) : t("tc_reportInNoJobFile")}</p>
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
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label className="mb-0" htmlFor="dr-did">{t("tc_whatToday")}</Label>
              {micButton("did")}
            </div>
            {/* ONE LINE that grows as it is filled (dictation can run long). */}
            <Textarea
              id="dr-did"
              rows={1}
              className="min-h-[44px]"
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
              rows={1}
              className="min-h-[44px]"
              placeholder={t("tc_matsPlaceholder")}
              value={mats}
              onChange={(e) => setMats(e.target.value)}
            />
          </div>

          <ReportJobLine choices={choices} jobId={jobId} onPick={setJobId} />

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
