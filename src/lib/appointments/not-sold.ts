/**
 * A VISIT'S NOT SOLD AND ITS UNDO (cn-v1170). Marking a visit Not Sold also marks its lead Not Sold
 * when that lead is open and nothing else from it stands (setAppointmentOutcome answers leadMarked).
 * Erik: "once a lead has been scheduled or Not Sold they come off the leads page". Taking the answer
 * back (the Undo clears it) puts a Not Sold lead back on the list by the server's own rule, with no
 * option passed, and the server says whether it did (leadReopened). So each toast says only what the
 * answer said happened. One rule for the visit page and the Inspections row.
 * Pure: it hands back catalog keys, never words.
 */
export type NotSoldAnswer = {
  /** The toast's sentence key. */
  said: "vp_markedLost" | "vp_markedLostLeadToo";
  /** A lead step that failed, as the server said it: the caller shows it too. */
  warning: string | undefined;
};

export function notSoldAnswer(res: { leadMarked?: boolean; warning?: string }): NotSoldAnswer {
  return {
    said: res.leadMarked === true ? "vp_markedLostLeadToo" : "vp_markedLost",
    warning: res.warning || undefined,
  };
}

/** The Undo's own sentence key: the lead is said to be open again ONLY when the server reopened it;
 *  undefined means the caller's usual undone sentence. */
export function undoneKey(res: { leadReopened?: boolean }): "vp_undoneLeadToo" | undefined {
  return res.leadReopened === true ? "vp_undoneLeadToo" : undefined;
}
