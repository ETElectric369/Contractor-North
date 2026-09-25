import { formatPhone, formatState } from "@/lib/utils";
import { linkOf, websiteHref } from "./item-options-math";

/**
 * LOOK UP (vendor import, Phase 2): what a web lookup of one vendor is allowed to put in front of a
 * person, decided IN CODE after the model has answered.
 *
 * Erik said Go to Claude with web search, on one condition: every field kept is tied to a source
 * URL present in that same response's search results or citations. The prompt asks for that; this
 * file ENFORCES it. A phone number, email, website or address whose source isn't one of the pages
 * the search actually returned is dropped, never shown, and the answer says how many were left out.
 * A choice with nothing left is removed. Nothing left at all is "Nothing found", said plainly.
 *
 * THE APP SUGGESTS, A PERSON DECIDES. A choice is only ever picked for a person when exactly one
 * came back and the name isn't a person's, and even then it is on screen with None Of These beside
 * it. A pick fills the preview row or the card's boxes; nothing is saved until Add or Save.
 *
 * Pure and client-safe (no server imports), so every rule is tested with made-up names.
 */

/** About what one lookup costs: one Sonnet 5 call with up to 3 searches ($0.06 to $0.12). */
export const LOOKUP_EACH_USD = 0.1;
/** About what reading one photo or scanned page of a list costs. */
export const READ_EACH_USD = 0.03;
export const LOOKUP_MAX_SEARCHES = 3;
/** Names one Look Up For N press looks up, at most. */
export const LOOKUP_PER_TAP = 30;
/** Lookups one company can run in a day (UTC, the ledger's day). About $10 at worst. */
export const LOOKUP_PER_DAY = 100;
/** Names one server call looks up: small enough to stay far inside a function's time limit, so the
 *  progress count is real and Stop stops within one chunk. */
export const LOOKUP_CHUNK = 5;
/** Choices one lookup shows, at most. */
export const LOOKUP_MAX_CHOICES = 3;

export type FoundField = "address" | "phone" | "website" | "email";
export const FOUND_FIELDS: FoundField[] = ["phone", "email", "website", "address"];
export const FOUND_LABEL: Record<FoundField, string> = { phone: "Phone", email: "Email", website: "Website", address: "Address" };

/** One detail a lookup kept, with the page it was found on (the URL as the search returned it). */
export interface Found {
  value: string;
  source: string;
}

export interface LookupChoice {
  id: string;
  /** Where this one is: "Truckee, CA", read off its own kept address, or "Place Not Found". */
  place: string;
  fields: Partial<Record<FoundField, Found>>;
  /** A map link: the search's own map page when one was returned, else a map search of the kept
   *  address. Null when there is no address to map. */
  maps_url: string | null;
  /** The page most of this choice came from, saved on the card with the pick. */
  source_url: string;
}

export type LookupAnswer =
  | { found: true; choices: LookupChoice[]; dropped: number; near: string }
  | { found: false; why: "nothing" | "unsourced" | "unreadable" | "unfinished" | "failed"; dropped: number; near: string };

/* ── THE SOURCES: every page this response's searches actually returned ─────────────────────── */

/**
 * The key two spellings of one page share: host without "www.", lower case; the path without a
 * trailing slash; the query kept; the #fragment dropped. Only http(s). A model that writes
 * "https://www.acme.com/contact/" for the result "https://acme.com/contact" is citing that page;
 * one that writes "https://acme.com/about" is not, even though the site is the same.
 */
export function pageKey(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 2000) return null;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * Every page URL in a response's content: the results of each web_search_tool_result block and the
 * url of every citation on a text block. Anything else (the model's own JSON, a URL typed into its
 * prose) is not a source. Keyed by pageKey, valued by the URL exactly as the search returned it.
 */
export function sourcesIn(content: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  const add = (url: unknown) => {
    const k = pageKey(url);
    if (k && !out.has(k)) out.set(k, String(url).trim());
  };
  for (const b of Array.isArray(content) ? content : []) {
    const block = b as { type?: string; content?: unknown; citations?: unknown };
    if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
      // A failed search's content is an error OBJECT, not a list: nothing to add.
      for (const r of block.content as { type?: string; url?: unknown }[]) if (r?.type === "web_search_result") add(r.url);
    }
    if (block?.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations as { url?: unknown }[]) add(c?.url);
    }
  }
  return out;
}

/* ── THE GUARD ───────────────────────────────────────────────────────────────────────────── */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One field's value as it would be saved, or null when it isn't one (a phone that isn't ten
 *  digits, an email with no domain). A malformed value is dropped like an unsourced one. */
function cleanValue(field: FoundField, raw: unknown): string | null {
  const v = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (field === "phone") {
    const f = formatPhone(v);
    return /^\(\d{3}\) \d{3}-\d{4}$/.test(f) ? f : null;
  }
  if (field === "email") return v.length <= 200 && EMAIL.test(v) ? v : null;
  if (field === "website") return v.length <= 300 ? websiteHref(v) : null;
  return v.length <= 300 && /[A-Za-z]/.test(v) ? v : null;
}

/** "Truckee, CA" off an address written the usual way, "10200 Pioneer Trl, Truckee, CA 96161": the
 *  segment before the one that is a two-letter state (with or without the zip). An address that
 *  doesn't say it that way gives null, and the choice reads "Place Not Found" rather than a guess. */
export function placeOfAddress(address: string | null | undefined): string | null {
  const parts = String(address ?? "")
    .split(",")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    const st = parts[i].match(/^([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
    if (!st) continue;
    const city = parts[i - 1];
    if (!/^[A-Za-z][A-Za-z .'-]{0,40}$/.test(city)) return null;
    return `${city.replace(/\b[a-z]/g, (x) => x.toUpperCase())}, ${st[1].toUpperCase()}`;
  }
  return null;
}

/** A Google Maps search of the vendor at its kept address. Built here, never taken from the model. */
export function mapSearchUrl(name: string, address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name.trim()}, ${address.trim()}`)}`.slice(0, 500);
}

type RawCandidate = Partial<Record<FoundField | "place_label" | "maps_url", unknown>> & { sources?: Partial<Record<string, unknown>> };

/**
 * THE NEVER-INVENT GUARD. The model's parsed answer → what a person may see.
 *
 *  · A field is kept only when its sources[field] is a page in `sources` (this response's search
 *    results and citations), and its value is well-formed (formatPhone to ten digits, an email
 *    with a domain, a web address). It is shown with THAT page as its "Found On" link.
 *  · A choice with no field left is removed; at most 3 are kept; two choices with the same phone,
 *    website or address are one.
 *  · The place label is read off the choice's own kept address, never taken on the model's word.
 *  · Nothing left → found: false. "unsourced" when the model offered details no page backed.
 */
export function guardAnswer(parsed: unknown, sources: Map<string, string>, name: string, near: string): LookupAnswer {
  const list = Array.isArray((parsed as { candidates?: unknown } | null)?.candidates)
    ? ((parsed as { candidates: unknown[] }).candidates as RawCandidate[])
    : [];
  let dropped = 0;
  const choices: LookupChoice[] = [];
  const seen = new Set<string>();
  for (const cand of list.slice(0, 10)) {
    if (!cand || typeof cand !== "object") continue;
    const srcs = (cand.sources && typeof cand.sources === "object" ? cand.sources : {}) as Record<string, unknown>;
    const fields: Partial<Record<FoundField, Found>> = {};
    for (const f of FOUND_FIELDS) {
      const raw = cand[f];
      if (raw === undefined || raw === null || String(raw).trim() === "") continue;
      const key = pageKey(srcs[f]);
      const page = key ? sources.get(key) : undefined;
      const value = cleanValue(f, raw);
      if (!page || !value) {
        dropped++;
        continue;
      }
      fields[f] = { value, source: page };
    }
    const kept = FOUND_FIELDS.filter((f) => fields[f]);
    if (!kept.length) continue;
    const sig = [
      fields.phone ? `p:${fields.phone.value.replace(/\D/g, "")}` : "",
      fields.website ? `w:${pageKey(fields.website.value)?.split("/")[0] ?? ""}` : "",
      fields.address ? `a:${fields.address.value.toLowerCase()}` : "",
    ].filter(Boolean);
    if (sig.some((s) => seen.has(s))) continue;
    sig.forEach((s) => seen.add(s));
    if (choices.length >= LOOKUP_MAX_CHOICES) continue;
    const mapKey = pageKey(cand.maps_url);
    const mapPage = mapKey ? sources.get(mapKey) : undefined;
    const maps = linkOf(mapPage) || (fields.address ? mapSearchUrl(name, fields.address.value) : null);
    const first = (["phone", "address", "website", "email"] as FoundField[]).map((f) => fields[f]).find(Boolean) as Found;
    choices.push({
      id: `choice-${choices.length + 1}`,
      place: placeOfAddress(fields.address?.value) ?? "Place Not Found",
      fields,
      maps_url: maps ?? null,
      source_url: linkOf(first.source) ?? first.source.slice(0, 500),
    });
  }
  if (choices.length) return { found: true, choices, dropped, near };
  return { found: false, why: dropped > 0 ? "unsourced" : "nothing", dropped, near };
}

/** The one choice to pick for a person: only when exactly one came back and the name isn't a
 *  person's (a person's name finds strangers). Null otherwise; a person picks. */
export function autoPick(answer: LookupAnswer, isPerson: boolean): LookupChoice | null {
  if (!answer.found || isPerson || answer.choices.length !== 1) return null;
  return answer.choices[0];
}

/* ── WHAT A PICK CHANGES ─────────────────────────────────────────────────────────────────── */

export interface FoundChange {
  field: FoundField;
  /** What the row or card says now (null = empty). */
  current: string | null;
  found: Found;
  /** Starts ON for an empty field and OFF for one somebody typed (old → new, they choose). */
  take: boolean;
}

function same(field: FoundField, a: string, b: string): boolean {
  if (field === "phone") return a.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "") === b.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (field === "website") return pageKey(websiteHref(a)) === pageKey(websiteHref(b));
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A pick against what is there: fills only the empty fields; a typed field that differs is shown
 *  old → new with its tick off; a field that already says the same is left out. */
export function changesFor(current: Partial<Record<FoundField, string | null | undefined>>, choice: LookupChoice): FoundChange[] {
  const out: FoundChange[] = [];
  for (const f of FOUND_FIELDS) {
    const found = choice.fields[f];
    if (!found) continue;
    const now = String(current[f] ?? "").trim() || null;
    if (now && same(f, now, found.value)) continue;
    out.push({ field: f, current: now, found, take: !now });
  }
  return out;
}

/** The values a preview row adds with, once its pick is applied: the ticked found fields replace
 *  what the row said, and the pick's source and map link ride along only when something was taken. */
export function applyPick<T extends Partial<Record<FoundField, string | null>>>(
  row: T,
  pick: { choice: LookupChoice; take: FoundField[] } | null | undefined,
): T & { source_url: string | null; maps_url: string | null } {
  const out = { ...row, source_url: null as string | null, maps_url: null as string | null };
  if (!pick) return out;
  const taken = pick.take.filter((f) => pick.choice.fields[f]);
  if (!taken.length) return out;
  for (const f of taken) (out as Record<string, unknown>)[f] = pick.choice.fields[f]!.value;
  out.source_url = pick.choice.source_url;
  out.maps_url = pick.choice.maps_url;
  return out;
}

/** "Found On acme.com": the page's host, without www. */
export function foundOn(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "the page";
  }
}

/* ── WHERE, AND WHAT IT COSTS ────────────────────────────────────────────────────────────── */

export interface LookupPlace {
  /** "Truckee" or "Truckee, CA": said in the prompt and in "Nothing found ... near Truckee". */
  label: string;
  city: string | null;
  region: string | null;
  /** The office, when it's somewhere else than the public city (a second place to prefer). */
  also: string | null;
}

/**
 * Where to search near. The public city (settings.public_city) first. Its state comes from
 * settings.public_state, else from the org's own address ONLY when that address is in the same city:
 * Vivian's public city is Truckee (a California town) and its mailing address is Reno, NV, and
 * "Truckee, NV" would send every search to the wrong state. No state that fits → the city alone.
 */
export function lookupPlace(
  settings: { public_city?: unknown; public_state?: unknown } | null | undefined,
  org: { city?: unknown; state?: unknown } | null | undefined,
): LookupPlace | null {
  const pubCity = String(settings?.public_city ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const pubState = formatState(String(settings?.public_state ?? ""));
  const orgCity = String(org?.city ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const orgState = formatState(String(org?.state ?? ""));
  const office = orgCity ? (orgState ? `${orgCity}, ${orgState}` : orgCity) : null;
  if (pubCity) {
    const region = pubState || (orgCity && orgCity.toLowerCase() === pubCity.toLowerCase() ? orgState : "") || null;
    return {
      label: region ? `${pubCity}, ${region}` : pubCity,
      city: pubCity,
      region,
      also: office && orgCity.toLowerCase() !== pubCity.toLowerCase() ? office : null,
    };
  }
  if (orgCity) return { label: office as string, city: orgCity, region: orgState || null, also: null };
  return null;
}

/** "$3", "$0.50": a dollar amount as the button says it. */
function dollars(n: number): string {
  return n >= 1 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

/** The price on the Look Up button, before the tap. */
export function lookupPrice(n: number): string {
  const count = Math.max(0, Math.floor(n));
  if (count <= 1) return `about ${dollars(LOOKUP_EACH_USD)}`;
  return `about ${dollars(LOOKUP_EACH_USD)} each, about ${dollars(count * LOOKUP_EACH_USD)} total`;
}

/** What "Nothing found" says, in plain words, with the way forward. Never a made-up number. */
export function nothingFoundText(name: string, answer: Extract<LookupAnswer, { found: false }>, isPerson: boolean): string {
  const who = name.trim() || "that name";
  const near = answer.near ? ` near ${answer.near}` : "";
  const yourself = isPerson ? "Add their phone yourself or leave it blank." : "Add the phone yourself or leave it blank.";
  switch (answer.why) {
    case "unsourced":
      return `Nothing found for ${who}${near} that a web page backs up, so nothing is shown. ${yourself}`;
    case "unreadable":
      return `The lookup for ${who} came back in a form that couldn't be read, so nothing is shown. Try it again, or ${yourself.charAt(0).toLowerCase()}${yourself.slice(1)}`;
    case "unfinished":
      return `The lookup for ${who} used its searches without finishing, so nothing is shown. ${yourself}`;
    case "failed":
      return `The lookup for ${who} didn't answer. Try this one again.`;
    default:
      return isPerson
        ? `Nothing found for ${who}${near}. A person's name is harder to find. ${yourself}`
        : `Nothing found for ${who}${near}. ${yourself}`;
  }
}
