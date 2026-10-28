"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { MANAGE_ROW_CLS } from "./job-manage-menu";
import { finishJob, finishJobPreview, type FinishJobPreview } from "../actions";

/**
 * "Finish Job" — quick end-of-job questions, then marks the job complete and puts its billing in
 * front of the office.
 *
 * THE TRUTH AT THE BUTTON (Connected North Phase 1; Tess Zane, J-002). A job billed with progress
 * payments is not billed by this modal: its toggles did nothing on the server, and "draft the
 * invoice" was a promise it didn't keep. So when it opens it asks the server what finishing will
 * actually do (finishJobPreview) and says that — including the hours and bills no bill holds
 * ("Not billed yet: 19.5 h ($2,437.50)…"), which finishing would otherwise drop off every screen.
 * And after the press it SHOWS what happened (the server's sentence, and any warning) with a door
 * to the invoice, instead of navigating away blind.
 *
 * A TIME & MATERIAL JOB IS FINISHED WITH ITS FINAL (Erik, 2026-09-26). With work not on a bill, the
 * press builds the Final as a DRAFT through the Overview card's own door and lands on it, the
 * sentence saying what was built. Nothing is sent, so the modal has no toggles and no email box
 * there: it says what will be built, for how much, before the press (finishJobPreview.final).
 */
export function FinishJobButton({
  jobId,
  hasQuote,
  defaultSendInvoice = false,
  isDrawBilled = false,
  isTm = false,
  menuItem = false,
}: {
  jobId: string;
  hasQuote: boolean;
  defaultSendInvoice?: boolean;
  isDrawBilled?: boolean;
  /** A Time & Material job: the modal waits for the server's plan (the Final it would build). */
  isTm?: boolean;
  /** Render the trigger as a Manage-menu row instead of a standalone button. */
  menuItem?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(useLang());
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FinishJobPreview | null>(null);
  const [done, setDone] = useState<{ id?: string; speak: string; warning?: string } | null>(null);
  const [timeIn, setTimeIn] = useState(false);
  const [costsIn, setCostsIn] = useState(false);
  const [importLabor, setImportLabor] = useState(!hasQuote);
  const [importCosts, setImportCosts] = useState(!hasQuote);
  const [sendInvoice, setSendInvoice] = useState(defaultSendInvoice);

  // The server's answer wins over the page's (a draw sent since the page rendered); until it
  // answers, the page's flag decides what shows.
  const drawBilled = preview?.ok ? !!preview.drawBilled : isDrawBilled;
  // THE FINAL THIS PRESS BUILDS (a T&M job with work not on a bill), in the server's words.
  const finalLine = preview?.ok ? (preview.final ?? null) : null;
  // A draft for set amounts is in the way of the Final: the modal opens that draft, or finishes
  // without billing (the work left off is said after the press).
  const finalBlocked = !!finalLine && !!preview?.finalBlocked;
  const blockingDraft = finalBlocked ? (preview?.finalDraft ?? null) : null;
  // The server decides what a T&M job's press does; until it answers, the modal doesn't guess.
  const waitForPlan = (drawBilled || isTm) && !preview;
  // The T&M plan couldn't be read: the email box isn't shown, so nothing is emailed on this press.
  const tmUnread = isTm && !!preview && !preview.ok;
  // The "email now" option only applies to standard invoices - a draw-billed job is billed with its
  // progress payments, which are sent from their own page, and a T&M Final is a draft a person sends.
  const wantSend = sendInvoice && !drawBilled && !finalLine && !tmUnread;

  function openModal() {
    setError(null);
    setDone(null);
    setPreview(null);
    setOpen(true);
    void finishJobPreview(jobId).then(setPreview, () => setPreview({ ok: false, error: t("jb_couldntReadBills") }));
  }

  function go() {
    setError(null);
    start(async () => {
      const res = await finishJob(
        jobId,
        finalBlocked ? { withoutBilling: true } : drawBilled || finalLine ? {} : { importLabor, importCosts, sendInvoice: wantSend },
      );
      if (!res.ok) {
        setError(res.error ?? t("jb_couldNotFinish"));
        return;
      }
      // THE FINAL WAS BUILT: land on it, with the sentence of what was built (and any heads-up).
      if (res.final && res.id) {
        toast(res.speak ?? t("jb_jobFinished"), "info");
        if (res.warning) toast(res.warning, "error");
        setOpen(false);
        router.push(`/billing/${res.id}`);
        return;
      }
      // Finished, but the email did NOT go out. Said, never pretended — and said for the right reason:
      // this line used to blame a missing customer email for every case, including the one where the
      // SERVER held the send back because a money question is waiting on the draft (finishJob skips the
      // email on a partial import). `res.warning` IS that question, so when it is there the sentence
      // names it instead of sending him to check an email address that is perfectly fine.
      const notSent =
        wantSend && !res.sent
          ? res.warning
            ? t("jb_notEmailedQuestion")
            : t("jb_notEmailedNoEmail")
          : undefined;
      setDone({ id: res.id, speak: res.speak ?? t("jb_jobFinished"), warning: [res.warning, notSent].filter(Boolean).join(" ") || undefined });
      router.refresh();
    });
  }

  const draftNo = preview?.openDraft?.number ?? t("jb_openProgressPayment");
  const drawLine = !preview?.ok
    ? null
    : preview.schedule
      ? t("jb_drawSchedule")
      : preview.openDraft?.refreshable
        ? fillText(t("jb_drawRefreshable"), { draft: draftNo })
        : preview.openDraft
          ? fillText(t("jb_drawOpenDraft"), { draft: draftNo })
          : t("jb_drawPlain");
  const offBill = drawBilled ? preview?.offBill ?? null : null;
  const saveLabel = finalLine
    ? finalBlocked
      ? t("jb_finishWithoutBilling")
      : preview?.finalBuilds
        ? preview.finalDoc === "final"
          ? t("jb_finishDraftFinal")
          : t("jb_finishDraftInvoice")
        : t("jb_finishJob")
    : drawBilled
      ? (offBill ? t("jb_finishWithoutBilling") : t("jb_finishJob"))
      : tmUnread
        ? t("jb_finishJob")
        : wantSend
          ? t("jb_finishSendInvoice")
          : t("jb_finishReviewInvoice");
  // "...and draft the invoice" only when the press really drafts one.
  const draftsOne = finalLine ? !!preview?.finalBuilds : !drawBilled && !tmUnread;

  return (
    <>
      {menuItem ? (
        <button type="button" onClick={openModal} className={MANAGE_ROW_CLS}>
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {t("jb_finishJob")}
        </button>
      ) : (
        <Button onClick={openModal}>
          <CheckCircle2 className="h-4 w-4" /> {t("jb_finishJob")}
        </Button>
      )}

      <Modal
        open={open}
        onClose={() => !pending && setOpen(false)}
        title={t("jb_finishThisJob")}
        portal
        footer={
          done ? (
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>{t("jb_close")}</Button>
              {done.id && <Button onClick={() => router.push(`/billing/${done.id}`)}>{t("jb_openTheInvoice")}</Button>}
            </div>
          ) : (
            <ModalActions
              onCancel={() => setOpen(false)}
              onSave={go}
              saving={pending}
              // A draw-billed job waits for the server's answer: the button must not say less than it knows.
              disabled={!timeIn || !costsIn || waitForPlan}
              saveLabel={saveLabel}
            />
          )
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {done ? (
            <div className="space-y-2">
              <div className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">{done.speak}</div>
              {done.warning && done.warning !== done.speak.replace(/^Job finished\.\s*/, "") && (
                <div className="rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-800">{done.warning}</div>
              )}
            </div>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                {draftsOne ? t("jb_quickCheckDraft") : t("jb_quickCheck")}
              </p>
              <div className="space-y-2">
                <label className={`flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2 text-sm ${timeIn ? "border-slate-200" : "border-amber-300 bg-amber-50"}`}>
                  <input type="checkbox" checked={timeIn} onChange={(e) => setTimeIn(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
                  <span className="text-slate-700">{t("jb_allTimeIn")}</span>
                </label>
                <label className={`flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2 text-sm ${costsIn ? "border-slate-200" : "border-amber-300 bg-amber-50"}`}>
                  <input type="checkbox" checked={costsIn} onChange={(e) => setCostsIn(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
                  <span className="text-slate-700">{t("jb_allMaterialsLogged")}</span>
                </label>
              </div>

              {finalLine ? (
                <div className="space-y-2 border-t border-slate-100 pt-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("jb_billing")}</div>
                  <p className={finalBlocked ? "rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" : "text-sm text-slate-600"}>{finalLine}</p>
                  {blockingDraft && (
                    <Button type="button" variant="outline" className="min-h-11" onClick={() => router.push(`/billing/${blockingDraft.id}`)}>
                      <FileText className="h-4 w-4" /> {t("jb_open")} {blockingDraft.number ?? t("jb_theDraft")}
                    </Button>
                  )}
                </div>
              ) : drawBilled || waitForPlan || (isTm && preview && !preview.ok) ? (
                <div className="space-y-2 border-t border-slate-100 pt-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("jb_billing")}</div>
                  {!preview ? (
                    <p className="flex items-center gap-2 text-sm text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin" /> {t("jb_checkingBilled")}
                    </p>
                  ) : !preview.ok ? (
                    <p className="text-sm text-amber-800">{preview.error ?? t("jb_couldntReadBills")} {t("jb_lookAtInvoices")}</p>
                  ) : (
                    <>
                      {drawLine && <p className="text-sm text-slate-600">{drawLine}</p>}
                      {offBill && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{offBill}</div>}
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="space-y-2 border-t border-slate-100 pt-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("jb_buildInvoiceFrom")}</div>
                    {hasQuote && (
                      <p className="text-sm text-slate-600">{t("jb_estimateCopies")}</p>
                    )}
                    <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={importLabor} onChange={(e) => setImportLabor(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
                      {t("jb_addLaborFromTimecards")}
                    </label>
                    <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={importCosts} onChange={(e) => setImportCosts(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
                      {t("jb_addMaterialsFromPos")}
                    </label>
                  </div>

                  <div className="space-y-1 border-t border-slate-100 pt-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("jb_whenDone")}</div>
                    <label className="flex min-h-11 items-start gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={sendInvoice} onChange={(e) => setSendInvoice(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
                      <span>
                        {t("jb_emailInvoiceNow")}
                        <span className="block text-xs text-slate-500">
                          {sendInvoice ? t("jb_sendsOnFinish") : t("jb_leaveUnchecked")}
                        </span>
                      </span>
                    </label>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
