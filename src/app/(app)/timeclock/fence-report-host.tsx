"use client";

import { useEffect, useState } from "react";
import { FENCE_REPORT_EVENT } from "@/lib/fence-report-event";
import { DailyReportDebrief } from "./daily-report-debrief";

/**
 * THE FENCE'S DAILY REPORT (cn-v1175): the sheet the other three doors open after a crew lead's
 * clock-out (the Time Clock page, My Day's Now card, the job page's clock button), opened here when
 * the site fence's own prompt closes the shift on the person's tap (lib/fence-report-event).
 *
 * Mounted ONCE at the app layout's root, outside the open-shift branch and never keyed, so the
 * refresh that follows a clock-out cannot unmount it while it is open. `asks` is the one rule's
 * answer for this person (lib/daily-report-rule asksForDailyReport, over the profile and the switches
 * the layout already read): when it is false nothing listens and nothing is drawn. The sheet reads its own job choices when it opens, as it does on every door; it is
 * portalled, as on the job page, because nothing at this level may draw a box in the flow.
 */
export function FenceReportHost({ asks }: { asks: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => listenForFenceReport(window, asks, () => setOpen(true)), [asks]);
  if (!asks) return null;
  return <DailyReportDebrief open={open} onClose={() => setOpen(false)} portal />;
}

/** The one listener: the fence's event opens the sheet, and only for a person the rule asks.
 *  Returns the cleanup (the effect's). Its own function so a test drives it with a plain EventTarget. */
export function listenForFenceReport(target: EventTarget, asks: boolean, onAsk: () => void): () => void {
  if (!asks) return () => {};
  const handler = () => onAsk();
  target.addEventListener(FENCE_REPORT_EVENT, handler);
  return () => target.removeEventListener(FENCE_REPORT_EVENT, handler);
}
