/**
 * NEW HOURS JOIN THE PERSON'S LINE (Erik's INV-078 rule, 2026-09-24 ~9:45 PM, refined).
 *
 * "The same two labor lines at the top with added hours." An invoice carries ONE labor line per
 * person ("Labor - Erik Taylor", 56.5 h @ $100) - the invoice line law: materials itemized, labor
 * grouped one line per person, never restructured. When the importer finds hours that person
 * worked since, they JOIN THAT LINE:
 *
 *   quantity   += the new hours
 *   source_ids += the new time entries (the claim - 0255/0258/0259 still refuse double billing)
 *   unit_price    stays what the line says (Andrew's $100, not Erik's $115 bill rate)
 *   edited        stays true when it was: the office's rate is still the office's
 *
 * cn-v994 put those hours on a SECOND line (`labor:<person>:2`) at the person's bill rate. That kept
 * the claims honest but restructured the bill: INV-078 grew ":2" lines at $115/$85 beside Andrew's
 * $100/$50 ones and Erik merged them by hand. And bumping a line's hours by hand instead is worse:
 * the entries stay off the line's claim, read as unbilled, and can be billed twice. So the join is
 * the importer's job, done here, and said: "Added 6 h to Labor - Erik Taylor at $100".
 *
 * THE PLAN, PER PERSON (the pure half; importLaborCore writes it):
 *   - The person's HOME line on this invoice is `labor:<person>`, else the lowest `labor:<person>:n`
 *     still on it (a legacy overflow line from before this rule).
 *   - No home line, key never deleted  → a new line, offered as before.
 *   - No home line, key DELETED by the office (tombstoned in dismissed_import_keys) → nothing is
 *     resurrected; the hours stay unbilled and the office is told where they are (`deleted`).
 *   - Home line not edited → offered under its key with all the person's free hours; the RPC
 *     refreshes it in place (its rate follows the person's bill rate, as it always has).
 *   - Home line edited, hours-based → offered unchanged (the RPC keeps an edited line), and the hours
 *     no edited line on this invoice holds are a JOIN onto it.
 *   - Home line edited but not in hours (a set price, "1 lot") → hours can't be added to a lump;
 *     nothing joins, and the office is told (`notHours`) - the hours stay free and unbilled.
 *   - Home line edited, but its quantity is MORE than the hours of the time entries it holds (bumped
 *     by hand to cover a shift it doesn't claim - INV-069's "Labor - Erik" reads 30.5 h over 27.5 h
 *     of entries) → nothing joins: adding the free hours on top could bill that same shift twice, on
 *     one line, and the claim trigger allows repeats on one invoice. The office is told (`drift`),
 *     checks the line, and imports again. The allowance is the quarter-hour rounding each joined run
 *     can carry (1/8 h per held entry), so a line this importer built never trips it.
 *   - Any OTHER unedited line of the person (an old ":2") is not offered, so the RPC removes it and
 *     its entries - free again - join the home line in the same run: the ":2" lines merge themselves.
 */

import type { LaborLine } from "./labor-billing";

export type OwnLaborLine = {
  id?: string | null;
  import_key: string | null;
  edited: boolean | null;
  source_ids: string[] | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
  unit?: string | null;
  description?: string | null;
};
export type LaborOffer = { importKey: string; line: LaborLine };

/** New hours onto a person's edited line - written by importLaborCore after the RPC, checked. */
export type LaborJoin = {
  lineId: string;
  importKey: string;
  /** The line's own words ("Labor - Erik Taylor"), for the sentence. */
  description: string;
  personId: string;
  name: string;
  /** The line's quantity when the plan was made - the write is guarded on it (a concurrent change
   *  makes the write land on zero rows and say so, never add on top of a number it didn't read). */
  fromQuantity: number;
  /** The claims the line holds now; the write is these plus addIds. */
  heldIds: string[];
  addHours: number;
  addIds: string[];
  /** The line's own rate - what the joined hours bill at. */
  rate: number;
};

/** Hours a person worked that this run could NOT put on the invoice, and why. */
export type LaborLeftOff = {
  personId: string;
  name: string;
  hours: number;
  why: "deleted" | "notHours" | "drift";
  lineDescription?: string;
  /** "drift": how many hours the line shows beyond the time entries it holds. */
  overBy?: number;
};

export type LaborPlan = { offer: LaborOffer[]; joins: LaborJoin[]; leftOff: LaborLeftOff[] };

const HOURS_UNITS = new Set(["hr", "hrs", "hour", "hours", "h"]);
/** A line whose quantity counts hours. An empty unit reads as hours: the importer always writes "hr". */
export function isHoursUnit(unit: string | null | undefined): boolean {
  const u = String(unit ?? "").trim().toLowerCase().replace(/\.$/, "");
  return u === "" || HOURS_UNITS.has(u);
}

/** `labor:<person>` → 0, `labor:<person>:n` → n, anything else → null. */
function suffixOf(key: string, baseKey: string): number | null {
  if (key === baseKey) return 0;
  if (!key.startsWith(`${baseKey}:`)) return null;
  const n = Number(key.slice(baseKey.length + 1));
  return Number.isInteger(n) && n > 0 ? n : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function planLaborOffer(input: {
  /** Entries free of every OTHER invoice's claims (withoutClaimedLabor's output). */
  entries: any[];
  /** This invoice's own labor lines. */
  ownLines: readonly OwnLaborLine[];
  /** invoices.dismissed_import_keys. */
  dismissed: ReadonlySet<string>;
  /** computeJobLaborBilling bound to the job's rates and codes. */
  bill: (entries: any[]) => LaborLine[];
  /** The job's entries BEFORE any claim was taken out, to measure the hours an edited line holds
   *  (its own entries are on it, so they are never "free"). Defaults to `entries`. */
  heldEntries?: any[];
}): LaborPlan {
  const heldByEdited = new Set<string>();
  for (const l of input.ownLines) if (l.edited) for (const id of l.source_ids ?? []) heldByEdited.add(String(id));

  const all = input.bill(input.entries);
  // Only computed when some person's home line is edited - the ordinary import pays nothing extra.
  let fresh: LaborLine[] | null = null;
  const plan: LaborPlan = { offer: [], joins: [], leftOff: [] };
  for (const line of all) {
    const baseKey = `labor:${line.personId}`;
    const mine = input.ownLines
      .map((l) => ({ l, n: l.import_key ? suffixOf(l.import_key, baseKey) : null }))
      .filter((x): x is { l: OwnLaborLine; n: number } => x.n !== null)
      .sort((a, b) => a.n - b.n);
    const home = mine[0]?.l ?? null;

    if (!home) {
      if (input.dismissed.has(baseKey)) {
        // The office deleted this person's line. Not brought back - and not silent either.
        if (line.quantity > 0) plan.leftOff.push({ personId: line.personId, name: line.name, hours: line.quantity, why: "deleted" });
        continue;
      }
      plan.offer.push({ importKey: baseKey, line });
      continue;
    }

    const homeKey = String(home.import_key);
    // Offered under the home key either way: an unedited line is refreshed with every free hour;
    // an edited one is kept by the RPC (its "kept" count stays honest) and joined below.
    plan.offer.push({ importKey: homeKey, line });
    if (!home.edited) continue;

    fresh ??= input.bill(input.entries.filter((e) => !heldByEdited.has(String(e?.id))));
    const add = fresh.find((r) => r.personId === line.personId);
    if (!add || add.quantity <= 0 || !add.sourceIds.length) continue; // every hour is on an edited line already
    if (!isHoursUnit(home.unit)) {
      plan.leftOff.push({ personId: line.personId, name: line.name, hours: add.quantity, why: "notHours", lineDescription: home.description ?? undefined });
      continue;
    }
    if (!home.id) continue; // no row to write to (a read without ids) - the offer above still stands
    // A HAND-BUMPED LINE TAKES NOTHING (Erik's decision 1: "the hours read as unbilled and can be
    // billed twice"). Measured against the unrounded hours of the entries it holds for this person.
    const heldHere = new Set((home.source_ids ?? []).map(String));
    const claimed = input.bill((input.heldEntries ?? input.entries).filter((e) => heldHere.has(String(e?.id)))).find((r) => r.personId === line.personId);
    const overBy = Number(home.quantity ?? 0) - (claimed?.rawHours ?? 0);
    if (overBy > 0.125 * Math.max(1, heldHere.size) + 0.01) {
      plan.leftOff.push({ personId: line.personId, name: line.name, hours: r2(add.quantity), why: "drift", lineDescription: home.description ?? undefined, overBy: r2(overBy) });
      continue;
    }
    plan.joins.push({
      lineId: String(home.id),
      importKey: homeKey,
      description: String(home.description ?? `Labor - ${line.name}`),
      personId: line.personId,
      name: line.name,
      fromQuantity: Number(home.quantity ?? 0),
      heldIds: (home.source_ids ?? []).map(String),
      addHours: r2(add.quantity),
      addIds: add.sourceIds.map(String),
      rate: Number(home.unit_price ?? 0),
    });
  }
  return plan;
}

/** "6 h", "6.5 h", "0.25 h". */
export function hoursWords(h: number): string {
  return `${r2(h)} h`;
}

/** "$100" for a whole-dollar rate, "$62.50" otherwise - the way Erik says it. */
export function rateWords(rate: number): string {
  const n = r2(rate);
  return Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The sentence for a join that landed: "Added 6 h to Labor - Erik Taylor at $100". */
export function joinedSentence(j: Pick<LaborJoin, "addHours" | "description" | "rate">): string {
  return `Added ${hoursWords(j.addHours)} to ${j.description} at ${rateWords(j.rate)}`;
}

/** The sentence for hours that could not go on: where they are and what brings them in. */
export function leftOffSentence(l: LaborLeftOff, invoiceLabel: string): string {
  const they = l.hours === 1 ? "It stays" : "They stay";
  if (l.why === "drift") {
    return `${l.lineDescription ?? `${l.name}'s labor line`} shows ${hoursWords(l.overBy ?? 0)} more than the time entries it holds, so ${l.name}'s new ${hoursWords(l.hours)} ${l.hours === 1 ? "was" : "were"} not added. ${they} unbilled on the job - check the line's hours, then Labor from Timecards again`;
  }
  if (l.why === "deleted") {
    return `${l.name}'s labor line was deleted from ${invoiceLabel}, so ${l.name}'s ${hoursWords(l.hours)} ${l.hours === 1 ? "was" : "were"} not added. ${they} unbilled on the job - Start It Over on Labor brings the line back`;
  }
  return `${l.lineDescription ?? `${l.name}'s labor line`} is a set price, not hours, so ${l.name}'s ${hoursWords(l.hours)} ${l.hours === 1 ? "was" : "were"} not added to it. ${they} unbilled on the job`;
}
