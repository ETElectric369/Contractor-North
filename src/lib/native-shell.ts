/**
 * AM I INSIDE THE NATIVE SHELL? The Capacitor config appends "CNShell/<v> (iOS|Android)" to the
 * WebView's user agent (capacitor.config.ts), so BOTH the server (headers()) and the browser can
 * tell. False everywhere today; the moment the shell exists, the places that must differ on
 * native — Add-to-Home-Screen coaching, web-push settings, the SaaS checkout (Apple 3.1.1) — key
 * off this one function. One detector, never a scattering of UA sniffs.
 */
const MARK = /\bCNShell\/(\d+)\s*\((iOS|Android)\)/i;

export type ShellInfo = { native: boolean; platform: "ios" | "android" | null; version: number | null };

export function shellFromUserAgent(ua: string | null | undefined): ShellInfo {
  const m = MARK.exec(ua ?? "");
  if (!m) return { native: false, platform: null, version: null };
  return { native: true, platform: m[2].toLowerCase() as "ios" | "android", version: Number(m[1]) || null };
}

/** Browser-side: true inside the shell. Safe to call during SSR (false). */
export function isNativeShell(): boolean {
  if (typeof navigator === "undefined") return false;
  return shellFromUserAgent(navigator.userAgent).native;
}
