"use client";

import { useEffect } from "react";
import { recordPortalOpen } from "./actions";

/** Tells the office "they opened it" (Last Opened on the contact's portal card). Runs only in a
 *  real browser that ran the page, so link previewers and most mail scanners never get here. The
 *  database writes at most once a minute per link, so a refresh storm is one touch. Best-effort:
 *  a failed stamp never shows the customer anything. */
export function OpenedBeacon({ token }: { token: string }) {
  useEffect(() => {
    recordPortalOpen(token).catch(() => undefined);
  }, [token]);
  return null;
}
