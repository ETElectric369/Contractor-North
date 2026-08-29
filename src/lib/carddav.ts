import "server-only";
import { parseVCards, type VCardContact } from "@/lib/vcard";

/**
 * A MINIMAL CardDAV CLIENT FOR iCLOUD — the open-protocol door to the user's own Contacts.
 *
 * Why this exists: Erik spent a day at the mercy of Safari's AutoFill chrome — the iOS flow works
 * but is buried three taps deep, the Mac's blue icon offers only his OWN card, and the typed
 * dropdown served him S-names for "Jeff" while Safari chewed on thousands of contacts for a full
 * minute. The browser owns that UI and we cannot fix it. iCloud, though, speaks CardDAV — so North
 * syncs the book into the user's own rows (0235) and renders its OWN picker, identical on every
 * screen. Same doctrine as the Google Calendar integration: integrate the SOURCE, not the chrome.
 *
 * Deliberately dependency-free: iCloud's DAV XML is small and stable, and a fragile-looking regex
 * over known response shapes beats a 2MB XML library on a serverless function. Every parse here is
 * tolerant — a shape we don't recognize yields "not found", never a crash.
 *
 * Auth is HTTP Basic with an APP-SPECIFIC password the user generates at appleid.apple.com —
 * revocable there any time, never their real password. We never see or handle the credential
 * outside their own database row.
 */

const ICLOUD = "https://contacts.icloud.com";

function authHeader(appleId: string, appPassword: string): string {
  return "Basic " + Buffer.from(`${appleId}:${appPassword}`).toString("base64");
}

async function dav(
  url: string,
  auth: string,
  method: string,
  body: string,
  depth: "0" | "1",
): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      Depth: depth,
      "Content-Type": "application/xml; charset=utf-8",
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}

/** First href inside the named DAV property. Namespace-prefix agnostic. */
function hrefIn(xml: string, prop: string): string | null {
  const m = new RegExp(`<[^>]*${prop}[^>]*>\\s*<[^>]*href[^>]*>([^<]+)</`, "i").exec(xml);
  return m ? m[1].trim() : null;
}

const abs = (base: string, href: string): string =>
  href.startsWith("http") ? href : new URL(href, base).toString();

/**
 * Walk the discovery chain: principal → addressbook home → the first address book.
 * Wrong password surfaces as a 401 with a message a person can act on.
 */
export async function discoverAddressbook(
  appleId: string,
  appPassword: string,
): Promise<{ ok: true; addressbookUrl: string } | { ok: false; error: string }> {
  const auth = authHeader(appleId, appPassword);
  const propfind = (props: string) =>
    `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop>${props}</d:prop></d:propfind>`;

  const p1 = await dav(`${ICLOUD}/`, auth, "PROPFIND", propfind("<d:current-user-principal/>"), "0");
  if (p1.status === 401) {
    return { ok: false, error: "iCloud said the sign-in is wrong. Use an APP-SPECIFIC password from appleid.apple.com — not your Apple ID password." };
  }
  const principal = hrefIn(p1.text, "current-user-principal");
  if (!principal) return { ok: false, error: `Couldn't find your iCloud account (status ${p1.status}).` };

  const p2 = await dav(abs(ICLOUD, principal), auth, "PROPFIND", propfind("<card:addressbook-home-set/>"), "0");
  const home = hrefIn(p2.text, "addressbook-home-set");
  if (!home) return { ok: false, error: "Couldn't find your contacts home in iCloud." };

  // The home usually lives on a numbered host (pXX-contacts.icloud.com) — abs() keeps it.
  const homeUrl = abs(ICLOUD, home);
  const p3 = await dav(homeUrl, auth, "PROPFIND", propfind("<d:resourcetype/><d:displayname/>"), "1");
  // Any response child that is an addressbook collection; iCloud names the main one "card".
  const books = [...p3.text.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/gi)]
    .map((m) => m[1].trim())
    .filter((h) => h !== new URL(homeUrl).pathname && /\/card\/?$|addressbook/i.test(h));
  const book = books[0] ?? new URL("card/", homeUrl.endsWith("/") ? homeUrl : homeUrl + "/").pathname;
  return { ok: true, addressbookUrl: abs(homeUrl, book) };
}

export type RemoteContact = VCardContact & { uid: string; etag: string };

/** Every card's href + etag — the sync's shopping list. */
export async function listCards(
  addressbookUrl: string,
  appleId: string,
  appPassword: string,
): Promise<{ ok: true; items: { href: string; etag: string }[] } | { ok: false; error: string }> {
  const auth = authHeader(appleId, appPassword);
  const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`;
  const res = await dav(addressbookUrl, auth, "PROPFIND", body, "1");
  if (res.status === 401) return { ok: false, error: "iCloud rejected the sign-in — reconnect with a fresh app-specific password." };
  if (res.status >= 400) return { ok: false, error: `iCloud listing failed (status ${res.status}).` };
  const items: { href: string; etag: string }[] = [];
  for (const m of res.text.matchAll(/<[^>]*response[^>]*>([\s\S]*?)<\/[^>]*response[^>]*>/gi)) {
    const chunk = m[1];
    const href = /<[^>]*href[^>]*>([^<]+)</i.exec(chunk)?.[1]?.trim();
    const etag = /<[^>]*getetag[^>]*>([^<]+)</i.exec(chunk)?.[1]?.trim() ?? "";
    if (href && /\.vcf$/i.test(href)) items.push({ href, etag });
  }
  return { ok: true, items };
}

/** Fetch a batch of cards by href (addressbook-multiget) and parse them. */
export async function fetchCards(
  addressbookUrl: string,
  appleId: string,
  appPassword: string,
  hrefs: string[],
): Promise<{ ok: true; contacts: RemoteContact[] } | { ok: false; error: string }> {
  const auth = authHeader(appleId, appPassword);
  const body =
    `<?xml version="1.0"?><card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">` +
    `<d:prop><d:getetag/><card:address-data/></d:prop>` +
    hrefs.map((h) => `<d:href>${h}</d:href>`).join("") +
    `</card:addressbook-multiget>`;
  const res = await dav(addressbookUrl, auth, "REPORT", body, "1");
  if (res.status >= 400) return { ok: false, error: `iCloud fetch failed (status ${res.status}).` };

  const contacts: RemoteContact[] = [];
  for (const m of res.text.matchAll(/<[^>]*response[^>]*>([\s\S]*?)<\/[^>]*response[^>]*>/gi)) {
    const chunk = m[1];
    const href = /<[^>]*href[^>]*>([^<]+)</i.exec(chunk)?.[1]?.trim();
    const etag = /<[^>]*getetag[^>]*>([^<]+)</i.exec(chunk)?.[1]?.trim() ?? "";
    const dataM = /<[^>]*address-data[^>]*>([\s\S]*?)<\/[^>]*address-data[^>]*>/i.exec(chunk);
    if (!href || !dataM) continue;
    // XML-entity decode the vCard payload (iCloud escapes it).
    const vcf = dataM[1]
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#13;/g, "\r").replace(/&amp;/g, "&");
    const parsed = parseVCards(vcf)[0];
    if (parsed && (parsed.name || parsed.phone)) contacts.push({ ...parsed, uid: href, etag });
  }
  return { ok: true, contacts };
}
