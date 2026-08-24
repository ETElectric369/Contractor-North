/**
 * WATCHING THE GOOGLE LISTING (Erik: "is there a way to have the system pickup any changes to
 * the GBP and update the code and prompt for a website revision?").
 *
 * TWO DIFFERENT GOOGLE APIS, and it matters which one you need:
 *
 *   · PLACES API (New) — what this file uses. Any place, resolved by Place ID, authenticated
 *     with a SERVER API key. No OAuth, no application, no approval queue: enable the API and
 *     restrict a key by IP. It returns the listing as the PUBLIC sees it — name, phone, website,
 *     category, opening hours, rating, review count, and up to five reviews.
 *
 *   · BUSINESS PROFILE API — the owner's view: the service-area definition, posts, Q&A, every
 *     review, and the ability to WRITE back. It needs OAuth with business.manage AND an access
 *     application Google reviews by hand. That is a real gate with a real wait, so nothing here
 *     depends on it. If it ever lands, the diff below is the same shape.
 *
 * WHY A DIFF AND NOT A SYNC. A listing change is not automatically a site change. If Google says
 * the phone number moved, that is wiring and the site should follow. If it says the category or
 * the hours changed, a human should look at what the site SAYS about itself before anything is
 * rewritten. So this produces a described change set and lets the app ask; it never edits copy.
 */

/** The fields we watch. Deliberately small: everything here is publicly visible on the listing
 *  and each one has an obvious consequence for the website. */
export type GbpSnapshot = {
  /** places/ChIJ… — Google's stable id for the listing. */
  placeId: string;
  displayName: string | null;
  nationalPhoneNumber: string | null;
  websiteUri: string | null;
  primaryType: string | null;
  /** Flattened weekday text, e.g. ["Monday: 8 AM–5 PM", …] — compared as a whole. */
  hours: string[];
  rating: number | null;
  reviewCount: number | null;
  /** ISO of when we took this snapshot. */
  at: string;
};

export type GbpChange = {
  field: keyof GbpSnapshot | "reviews";
  label: string;
  from: string;
  to: string;
  /** WIRING can be applied to the site without a human rewriting anything (a phone number is a
   *  fact). COPY means a person should decide — the site's own words may need to change. */
  kind: "wiring" | "copy" | "signal";
};

const fmt = (v: unknown): string =>
  v === null || v === undefined || v === "" ? "—" : Array.isArray(v) ? v.join(" · ") : String(v);

/**
 * What changed between two snapshots, in the order a human would care.
 * Returns [] when nothing moved — the common case, and the one that must stay silent.
 */
export function diffGbp(prev: GbpSnapshot | null, next: GbpSnapshot): GbpChange[] {
  if (!prev) return []; // first sight is a baseline, never an alert
  const out: GbpChange[] = [];
  const push = (field: GbpChange["field"], label: string, a: unknown, b: unknown, kind: GbpChange["kind"]) => {
    if (fmt(a) === fmt(b)) return;
    out.push({ field, label, from: fmt(a), to: fmt(b), kind });
  };

  // Wiring first: these are facts the site should simply match.
  push("nationalPhoneNumber", "Phone number", prev.nationalPhoneNumber, next.nationalPhoneNumber, "wiring");
  push("websiteUri", "Website link", prev.websiteUri, next.websiteUri, "wiring");
  push("hours", "Opening hours", prev.hours, next.hours, "wiring");
  // Then the things that change what the site should SAY.
  push("displayName", "Business name", prev.displayName, next.displayName, "copy");
  push("primaryType", "Primary category", prev.primaryType, next.primaryType, "copy");

  // Reviews are a SIGNAL, not a correction: nothing on the site is wrong because a review
  // arrived, but new ones are the best reason there is to refresh what the page shows.
  const before = prev.reviewCount ?? 0;
  const after = next.reviewCount ?? 0;
  if (after > before) {
    out.push({
      field: "reviews",
      label: "New Google reviews",
      from: `${before}`,
      to: `${after}${next.rating ? ` (${next.rating}★)` : ""}`,
      kind: "signal",
    });
  } else if (after < before) {
    out.push({ field: "reviews", label: "Reviews removed", from: `${before}`, to: `${after}`, kind: "signal" });
  } else if (next.rating !== prev.rating && next.rating !== null) {
    out.push({ field: "reviews", label: "Star rating moved", from: fmt(prev.rating), to: fmt(next.rating), kind: "signal" });
  }
  return out;
}

/** One plain sentence for the inbox row — what a person needs before deciding to look. */
export function describeGbpChanges(changes: GbpChange[]): string {
  if (!changes.length) return "";
  const names = changes.map((c) => c.label.toLowerCase());
  const head = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Your Google listing changed: ${head}.`;
}

/** The instruction the Design Studio should open pre-filled, so the revision starts from the
 *  facts rather than from a blank box. Only COPY changes belong here — wiring is applied
 *  directly, and a review count is not something a designer rewrites. */
export function studioInstructionFor(changes: GbpChange[]): string {
  const copy = changes.filter((c) => c.kind === "copy");
  if (!copy.length) return "";
  const lines = copy.map((c) => `- ${c.label}: was "${c.from}", now "${c.to}"`);
  return [
    "My Google Business Profile changed. Update the site's wording so it agrees with the listing:",
    ...lines,
    "Keep the layout and the photos as they are — only the words that are now wrong.",
  ].join("\n");
}

/** Fetch a listing through the Places API (New). Returns null when the integration is not
 *  configured, which is the normal state until someone adds a SERVER key — the nightly job
 *  must no-op quietly rather than error every org, every night. */
export async function fetchGbpSnapshot(placeId: string): Promise<GbpSnapshot | null> {
  const key = process.env.GOOGLE_PLACES_SERVER_KEY;
  if (!key || !placeId) return null;
  const id = placeId.startsWith("places/") ? placeId : `places/${placeId}`;
  const fields = [
    "id",
    "displayName",
    "nationalPhoneNumber",
    "websiteUri",
    "primaryTypeDisplayName",
    "regularOpeningHours.weekdayDescriptions",
    "rating",
    "userRatingCount",
  ].join(",");
  try {
    const res = await fetch(`https://places.googleapis.com/v1/${id}?fields=${encodeURIComponent(fields)}`, {
      headers: { "X-Goog-Api-Key": key },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, any>;
    return {
      placeId: String(d.id ?? placeId),
      displayName: d.displayName?.text ?? null,
      nationalPhoneNumber: d.nationalPhoneNumber ?? null,
      websiteUri: d.websiteUri ?? null,
      primaryType: d.primaryTypeDisplayName?.text ?? null,
      hours: Array.isArray(d.regularOpeningHours?.weekdayDescriptions) ? d.regularOpeningHours.weekdayDescriptions : [],
      rating: typeof d.rating === "number" ? d.rating : null,
      reviewCount: typeof d.userRatingCount === "number" ? d.userRatingCount : null,
      at: new Date().toISOString(),
    };
  } catch {
    return null; // a listing check must never take the nightly run down with it
  }
}
