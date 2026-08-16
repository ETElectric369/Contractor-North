import type { Need } from "@/lib/playbook/types";

/**
 * ADDRESS QUESTIONS MIRROR THE FORM — they never collect (Erik, on Andrew's intake: "it
 * shouldnt pop up if the box is checked it should autopopulate the project address and
 * display it uneditable").
 *
 * The intake form OWNS the project address: home address + the "work is at my home address"
 * tick, or the explicit site block when unticked. Andrew also built Project Address / City /
 * State / Zip as playbook questions conditioned on project type — so picking "New
 * Construction" popped a second, empty, editable address. Two boxes for one fact is the
 * address-drift bug factory. So a playbook question that IS the project address renders as a
 * read-only mirror of the form's value, and the value flows into the answers at submit.
 *
 * MATCHING, DELIBERATELY NARROW:
 *  - The street question must be QUALIFIED: "project/site/job/property address". A bare
 *    "Address" never mirrors — the designer/architect block asks a bare "Address" that is a
 *    different party's address entirely.
 *  - "City"/"State"/"Zip" mirror ONLY when they ride the SAME `when` condition as a mirrored
 *    street question — Andrew's four share one trigger. The designer block's "City" hangs off
 *    has_designer and stays editable.
 */

export type EffectiveSite = { address: string; city: string; state: string; zip: string };

export const normAsk = (s: string): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[?:.…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const isSiteAddressAsk = (ask: string): boolean =>
  /^(project|site|job|property)\s+(street\s+)?address$/.test(normAsk(ask));

/** The `when` signatures of every mirrored street question in this playbook. */
export function siteAddressWhens(needs: Need[]): Set<string> {
  return new Set(needs.filter((n) => isSiteAddressAsk(n.ask)).map((n) => JSON.stringify(n.when ?? null)));
}

/** The mirrored value for one question, or null when this question is not a mirror. */
export function mirrorValue(n: Need, whens: Set<string>, eff: EffectiveSite): string | null {
  if (isSiteAddressAsk(n.ask)) return eff.address;
  if (!whens.has(JSON.stringify(n.when ?? null))) return null;
  const a = normAsk(n.ask);
  if (a === "city") return eff.city;
  if (a === "state") return eff.state;
  if (a === "zip" || a === "zip code" || a === "postal code") return eff.zip;
  return null;
}

/** Every mirrored answer, typed for the slot, ready to overlay onto the customer's answers.
 *  The mirror WINS over anything typed into these keys before the tick was flipped. */
export function mirrorAnswers(needs: Need[], eff: EffectiveSite): Record<string, string | number> {
  const whens = siteAddressWhens(needs);
  const out: Record<string, string | number> = {};
  for (const n of needs) {
    const v = mirrorValue(n, whens, eff);
    if (v == null || !String(v).trim()) continue;
    const t = String(v).trim();
    out[n.key] = n.slot?.type === "number" && /^\d+(\.\d+)?$/.test(t) ? Number(t) : t;
  }
  return out;
}
