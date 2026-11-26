"use client";

import { useState, useTransition } from "react";
import { Mic, MicOff } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label, Textarea } from "@/components/ui/input";
import { useDictation } from "@/lib/use-dictation";
import { translator } from "@/lib/i18n";
import { useLang } from "@/components/lang-provider";
import { useToast } from "@/components/toast";
import { addWhatTodayNote } from "./actions";

/**
 * "WHAT DID YOU DO TODAY?" — ONE QUESTION AFTER A TECH'S OWN CLOCK-OUT (cn-v1190). The owner: "and
 * for techs who are not lead lets have one question with their clocout - what did you do today".
 *
 * Who is asked is lib/what-today's asksWhatToday (a tech the lead's report does not ask), and it is
 * the other branch of the same rule that opens DailyReportDebrief: each door mounts one sheet or the
 * other, after a clock-out that kept the shift (a punch taken back, or any refusal, opens nothing).
 *
 * THE CLOCK IS ALREADY STOPPED when this opens, and the heading says so (Clocked Out). One box, with
 * the press-to-talk dictation the staff sheet has, and two buttons: Save adds the answer to that
 * shift's note (addWhatTodayNote, never over what is there), Skip closes. Skip, closing, or Save with
 * an empty box change nothing. A failed save keeps the sheet open with the words in the box, says
 * why, and the button reads Try Again.
 *
 * NEVER REMOUNTED WHILE OPEN (the Modal law): the door keeps this mounted and flips `open`; a new
 * opening resets the box with state, never with a key. `entryId` is the shift the close was about.
 */
export function WhatTodaySheet({ open, entryId, onClose }: { open: boolean; entryId: string | null; onClose: () => void }) {
  const t = translator(useLang());
  const toast = useToast();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // A NEW OPENING starts clean (a new shift, a new answer): state, never a key around the open Modal.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setText("");
      setError(null);
    }
  }

  const dictation = useDictation((said) => setText((prev) => (prev ? prev + " " : "") + said.trim()));
  const speechSupported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  function close() {
    dictation.cancel(); // leaving the sheet: mic released, audio discarded
    onClose();
  }

  function save() {
    const said = text.trim();
    // An empty box changes nothing: Save is the same as Skip.
    if (!said || !entryId) return close();
    setError(null);
    start(async () => {
      try {
        const res = await addWhatTodayNote({ entry_id: entryId, answer: said });
        if (!res.ok) return setError(res.error ?? t("tc_wtNotSaved"));
        toast(t("tc_wtSaved"), "success");
        close();
      } catch {
        // No connection: the words stay in the box, and the button says Try Again.
        setError(t("tc_offlineAnswersKept"));
      }
    });
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("tc_wtTitle")}
      dirty={!!text.trim()}
      holdOpen={pending}
      footer={
        <ModalActions
          onCancel={close}
          onSave={save}
          saving={pending}
          saveLabel={error ? t("sh_tryAgain") : t("sh_save")}
          cancelLabel={t("tc_skip")}
        />
      }
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="mb-0" htmlFor="wt-did">
            {t("tc_whatToday")}
          </Label>
          {speechSupported ? (
            <button
              type="button"
              onClick={() => (dictation.recording ? dictation.stop() : void dictation.start())}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium ${
                dictation.recording ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {dictation.recording ? (
                <>
                  <MicOff className="h-4 w-4 shrink-0" /> {t("tc_stop")}
                </>
              ) : (
                <>
                  <Mic className="h-4 w-4 shrink-0" /> {dictation.transcribing ? "…" : t("tc_dictate")}
                </>
              )}
            </button>
          ) : null}
        </div>
        <Textarea
          id="wt-did"
          rows={2}
          className="min-h-[44px]"
          placeholder={t("tc_didPlaceholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}
