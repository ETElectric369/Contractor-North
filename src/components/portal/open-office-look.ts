/**
 * Open the office's See What They See in a new tab (0331). The tab is opened INSIDE the click,
 * before the await, so Safari doesn't take it for a popup; the one-use URL is filled in once the
 * server hands it over. The new tab gets no handle back to the app (opener cleared). Returns what
 * to say when it didn't open, or null.
 */
export async function openOfficeLook(
  getUrl: () => Promise<{ ok: true; url: string } | { ok: false; error: string }>,
): Promise<string | null> {
  const tab = window.open("", "_blank");
  let r: { ok: true; url: string } | { ok: false; error: string };
  try {
    r = await getUrl();
  } catch {
    r = { ok: false, error: "Their page couldn't be opened. Check your connection and try again." };
  }
  if (!r.ok) {
    tab?.close();
    return r.error;
  }
  if (tab) {
    try {
      tab.opener = null;
    } catch {
      /* some browsers make opener read-only; the page is on another host either way */
    }
    tab.location.href = r.url;
    return null;
  }
  // The browser refused the blank tab: try once more with the real URL. (With noopener, open()
  // answers null even when it worked, so there is nothing to check here.)
  window.open(r.url, "_blank", "noopener,noreferrer");
  return null;
}
