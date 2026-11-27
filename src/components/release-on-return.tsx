"use client";

import { useEffect } from "react";
import { installReleaseOnReturn } from "@/lib/release-on-return";

/**
 * The phone app's half of "an open app never keeps running an old build" (cn-v1205). A browser
 * tab is reloaded by <PwaRegister /> when its service worker is replaced; the phone app has no
 * service worker, so this asks when the app comes back into view and reloads only when, as the
 * answer lands, no sheet is up, no field has focus, no typed text is on the screen, the person has
 * not touched it since coming back, no native screen or file picker holds it, and no screen has
 * registered work only this page holds. The whole rule, and where it does and does not run, is
 * lib/release-on-return. Mounted once, in the root layout, beside <PwaRegister />.
 */
export function ReleaseOnReturn() {
  useEffect(() => installReleaseOnReturn(), []);
  return null;
}
