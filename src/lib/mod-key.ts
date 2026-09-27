/**
 * THE SHORTCUT'S NAME ON THIS COMPUTER (W1-12). The command bar opens on ⌘K or Ctrl K (either
 * works everywhere: command-bar.tsx checks metaKey || ctrlKey), but the chip that names it should
 * say the key this person actually has: ⌘K on a Mac, iPhone or iPad, Ctrl K on Windows, Linux and
 * Chromebooks. Client-only: on the server (no navigator) it answers Apple, which is what the chip
 * said before, so a server render and a first client render always agree.
 */
type NavLike = { platform?: string; userAgent?: string; userAgentData?: { platform?: string } };

export function isApplePlatform(nav?: NavLike | null): boolean {
  const n: NavLike | undefined = nav ?? (typeof navigator !== "undefined" ? (navigator as unknown as NavLike) : undefined);
  if (!n) return true;
  const said = n.userAgentData?.platform || n.platform || n.userAgent || "";
  if (!said) return true;
  return /mac|iphone|ipad|ipod/i.test(said);
}

/** "⌘K" or "Ctrl K". */
export const modKeyLabel = (apple: boolean): string => (apple ? "⌘K" : "Ctrl K");
