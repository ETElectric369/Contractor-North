import type { SiteField, SiteFields } from "./extract";

/**
 * WHAT A SITE'S DETAILS DO TO A FORM (Fill From Their Site, 2026-09-27). Pure, and shared by the
 * browser (which fills) and the server (which decides what is still missing).
 *
 * THE LAW: a suggestion fills an EMPTY box only. Whatever the person typed stays exactly as typed,
 * even if they typed it while the site was being read. Filling is not saving: nothing is written
 * until the person presses Save (the fill-vs-execute doctrine).
 */

/** The boxes a site can fill. Category is a pick-list with a default, so it counts as "empty" only
 *  while adding a new contact and nobody has touched it (the caller says so: `categoryOpen`). */
export type FillKey = "name" | "phone" | "email" | "address" | "notes" | "category";
export const FILL_KEYS: readonly FillKey[] = ["name", "phone", "email", "address", "notes", "category"];
export type FillValues = Record<FillKey, string>;

export const FILL_LABELS: Record<FillKey, string> = {
  name: "name",
  phone: "phone",
  email: "email",
  address: "address",
  notes: "notes",
  category: "category",
};

/** "101 Courthouse Sq, Downieville, CA 95936" from whatever parts the site gave. */
export function oneLineAddress(f: Pick<SiteFields, "street" | "city" | "state" | "zip">): string {
  const stateZip = [f.state, f.zip].filter(Boolean).join(" ");
  const cityLine = [f.city, stateZip].filter(Boolean).join(", ");
  return [f.street, cityLine].filter(Boolean).join(", ");
}

/** What goes in Notes: the one line saying what they are, their hours, and any other phone lines. */
export function notesFromSite(f: SiteFields): string {
  const lines: string[] = [];
  if (f.about) lines.push(f.about);
  if (f.hours) lines.push(`Hours: ${f.hours}`);
  const more = (f.phones ?? []).slice(1);
  if (more.length) lines.push(`Other ${more.length === 1 ? "phone" : "phones"}: ${more.join(", ")}`);
  return lines.join("\n");
}

/** A site's details as the form's boxes. */
export function siteToForm(f: SiteFields): Partial<FillValues> {
  const out: Partial<FillValues> = {
    name: f.name,
    phone: f.phones?.[0],
    email: f.email,
    address: oneLineAddress(f) || undefined,
    notes: notesFromSite(f) || undefined,
    category: f.category,
  };
  for (const k of FILL_KEYS) if (!out[k]) delete out[k];
  return out;
}

/** Fill the empty boxes; never touch one with anything in it. Returns the new values and which
 *  boxes were filled, so the form can mark them until the person edits them or saves. */
export function applySiteFill<T extends FillValues>(
  current: T,
  found: Partial<FillValues>,
  opts: { categoryOpen: boolean },
): { next: T; filled: FillKey[] } {
  const next = { ...current };
  const filled: FillKey[] = [];
  for (const k of FILL_KEYS) {
    const v = found[k]?.trim();
    if (!v) continue;
    if (k === "category") {
      if (opts.categoryOpen && v !== current.category) {
        next.category = v;
        filled.push(k);
      }
      continue;
    }
    if (!current[k].trim()) {
      next[k] = v;
      filled.push(k);
    }
  }
  return { next, filled };
}

/** The boxes still empty, which is what the server is asked to find. */
export function emptyBoxes(current: FillValues, opts: { categoryOpen: boolean }): FillKey[] {
  return FILL_KEYS.filter((k) => (k === "category" ? opts.categoryOpen : !current[k].trim()));
}

function listWords(words: string[], joiner: "and" | "or"): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${joiner} ${words[words.length - 1]}`;
}

/** One plain line for after a fill. Never silent: it says what was filled and what the site didn't list. */
export function fillSummary(before: FillValues, found: Partial<FillValues>, filled: FillKey[]): string {
  const missing = (["phone", "email", "address"] as const).filter((k) => !before[k].trim() && !found[k]);
  const didntList = missing.length
    ? `That site didn't list ${listWords(missing.map((k) => (k === "email" || k === "address" ? `an ${k}` : `a ${k}`)), "or")}.`
    : "";
  if (filled.length) {
    return [`Filled ${listWords(filled.map((k) => FILL_LABELS[k]), "and")} from their site. Check them, then Save.`, didntList]
      .filter(Boolean)
      .join(" ");
  }
  if (!Object.values(found).some(Boolean)) return "That page didn't list any contact details. Try the link to their Contact page.";
  return ["Every box that site could fill already has something in it, so nothing changed.", didntList].filter(Boolean).join(" ");
}

/** Does this look like a web address worth reading? "pge.com", "https://yourcounty.gov/building". */
export function looksLikeWebAddress(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 2000 || /\s/.test(t)) return false;
  return /^(https?:\/\/)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{2,5})?([/?#]\S*)?$/i.test(t);
}

/** What the person typed as a URL to read: https:// is added when there's no scheme. Another scheme
 *  (mailto:, javascript:, file:) is kept, so the reader refuses it in words. null = nothing typed. */
export function siteUrl(input: string): string | null {
  const t = String(input ?? "").trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t)) return t;
  return `https://${t}`;
}

/** Which of the site's fields would fill the boxes asked for. */
export const FIELDS_FOR_BOX: Record<FillKey, SiteField[]> = {
  name: ["name"],
  phone: ["phones"],
  email: ["email"],
  address: ["street", "city", "state", "zip"],
  notes: ["about", "hours"],
  category: ["category"],
};

/** The boxes asked for that the page's own card left empty (or only weakly filled). The model is
 *  asked about these only: when there are none, no model call is made. */
export function gapsFor(need: readonly FillKey[], f: SiteFields, weak: readonly SiteField[]): FillKey[] {
  return need.filter((k) => {
    switch (k) {
      case "name":
        return !f.name || weak.includes("name");
      case "phone":
        return !f.phones?.length;
      case "email":
        return !f.email;
      case "address":
        return !f.street;
      case "notes":
        return !f.about || !f.hours;
      case "category":
        return !f.category;
    }
  });
}

/** The model's answer fills the gaps only; what the page's own card said is never replaced. An
 *  address travels whole: the model's street, city, state and zip together, never mixed with a
 *  partial one from the page. */
export function mergeModelFields(base: SiteFields, weak: readonly SiteField[], model: SiteFields, gaps: readonly FillKey[]): SiteFields {
  const out: SiteFields = { ...base };
  for (const k of gaps) {
    if (k === "address") {
      if (model.street) {
        out.street = model.street;
        out.city = model.city;
        out.state = model.state;
        out.zip = model.zip;
      }
      continue;
    }
    for (const f of FIELDS_FOR_BOX[k]) {
      const have = out[f] !== undefined && !(f === "name" && weak.includes("name"));
      if (!have && model[f] !== undefined) (out as Record<string, unknown>)[f] = model[f];
    }
  }
  for (const f of Object.keys(out) as SiteField[]) if (out[f] === undefined) delete out[f];
  return out;
}
