"use client";

import { useState } from "react";
import { WhichJobSheet } from "../planner/which-job";
import { CHANGE_JOB_LABEL, changeJobAsk, type AppChoseNotice } from "./clock-told";
import type { WhichJobAsk } from "./which-job-choices";

/**
 * "YOUR PUNCH IS ON <JOB>. THE APP PICKED THAT…" — the one line every clock door shows when nobody
 * chose the job, and the one tap that moves it.
 *
 * THE CLOCK STAYS TWO BUTTONS. This is a sentence with a link, not a modal: nobody is stopped,
 * nobody has to answer, and ignoring it leaves the punch exactly where the app put it. The Change
 * door opens the clock's EXISTING "Which Job Are You On?" sheet (the same list, the same write) in
 * move mode, off the job named in the sentence.
 *
 * WHY A LINE AND NOT A TOAST. A money decision has to be READ, not glimpsed, and the toast channel
 * cannot hold this one: an ordinary toast is gone in 2.8 seconds, an action toast in ten, and a
 * sticky toast renders Got It only when it has no action (components/toast) — so sticky + Change
 * would sit on every screen in the app with no way to dismiss it. The line lives on the card the
 * punch is on instead, beside the job it is about, which is the one screen a person looks at after
 * punching and has no timer on it at all (Erik's text-to-visual law: put it inside the thing it
 * belongs to). It is NOT re-derived on the server, so a full navigation away does leave it behind —
 * the Timeclock panel and the Now card both carry it, and the punch itself is correctable from
 * either one and from Timecards.
 */
export function AppChoseJobNotice({
  notice,
  onDone,
  confirmInline = false,
  className = "",
}: {
  /** What the clock answered (clock-told: tellAppChose). Null: the person chose the job, or there is
   *  nothing to say — then this renders nothing at all. */
  notice: AppChoseNotice | null;
  /** The door's own state reset: the punch has been moved, or the person is done reading. */
  onDone: () => void;
  /** The door has no toast (the shell's offline queue sits outside the toast provider), so the
   *  sheet says where the punch landed itself. */
  confirmInline?: boolean;
  className?: string;
}) {
  const [ask, setAsk] = useState<WhichJobAsk | null>(null);
  if (!notice) return null;
  return (
    <>
      <div className={`text-sm ${className}`} role="status">
        <span className="text-slate-600">{notice.sentence}</span>{" "}
        <button
          type="button"
          onClick={() => setAsk(changeJobAsk(notice))}
          className="inline-flex min-h-11 items-center font-semibold text-brand underline-offset-2 hover:underline"
        >
          {CHANGE_JOB_LABEL}
        </button>
      </div>
      {ask && (
        <WhichJobSheet
          key={ask.entryId + ask.moment}
          entryId={ask.entryId}
          moment={ask.moment}
          from={ask.from ?? null}
          confirmInline={confirmInline}
          onClose={() => {
            setAsk(null);
            // The question has been answered or waved off: the sentence has done its job either way,
            // and a line still saying "the app picked that" after the punch moved would be a lie.
            onDone();
          }}
        />
      )}
    </>
  );
}
