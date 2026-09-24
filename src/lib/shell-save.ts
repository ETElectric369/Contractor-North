/**
 * WHAT A DOWNLOAD TAP DOES, decided synchronously inside the tap.
 *
 * A browser saves a file from `<a href download>`. The iOS shell cannot: WebKit drops `download`
 * on a cross-origin href (a signed Supabase URL), the shell allows *.supabase.co in the WebView,
 * and so the tap NAVIGATED THE APP ITSELF to the raw file, with no chrome and no way back
 * (be3dca81). On iOS, "download" means the share sheet (Save to Files, Save Image, AirDrop), so
 * inside the shell the file goes there.
 *
 * The sheet only opens while the tap is still warm, so the file has to be in hand before the tap
 * (see share-icon-button.tsx for what an await in between costs). When it isn't, or the sheet has
 * already refused it once, the link opens in Safari instead: a separate app, with the app left
 * exactly where it was behind it. Never the app's own WebView.
 */
export type SaveRoute = "download" | "share-sheet" | "safari";

export function saveRoute(s: {
  inShell: boolean;
  /** The bytes are fetched and wrapped as a File. */
  fileReady: boolean;
  /** navigator.canShare({ files }) said yes for that File. */
  canShareFile: boolean;
  /** The sheet already rejected this file with something other than the user closing it. */
  shareFailed: boolean;
}): SaveRoute {
  if (!s.inShell) return "download";
  if (s.fileReady && s.canShareFile && !s.shareFailed) return "share-sheet";
  return "safari";
}
