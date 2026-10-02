/**
 * WHOSE HOURS A LABOR LINE HOLDS (2026-09-26, labor claims by person).
 *
 * An invoice carries one labor line per person ("Labor — Erik Taylor", the invoice line law), and the
 * line claims the time entries it billed (invoice_items.source_ids, 0255). Every labor claim belongs
 * on the line of the person whose time it is. Found on ten of ET's paid invoices: "Labor — Erik Taylor"
 * on INV-050 held Brian's four J-030 shifts and Brian's line held none, and nine more like it. The money
 * was right (the lines were typed and paid); who worked what, per-person hours and the payroll
 * cross-checks read the claims, so they read Brian's hours as Erik's.
 *
 * HOW IT HAPPENED. 0256 (the one-time backfill of claims, 2026-09-11) gave a line a person only from a
 * `labor:<person>` key. Every line built before keys existed (0175, 2026-07-31) or typed by hand had
 * none, so each was "invoice-level", and its anchor rule (distinct on invoice and person, lowest
 * sort_order) kept ONE of them per invoice and handed it every person's hours. The other person's line
 * got nothing. 0256 is gone from the schema's reach (it reads the dropped split table), so it cannot
 * run again; the data is re-pointed by a guarded script, and the doors that could do it again now
 * refuse: a billed shift can't be handed to someone else (updateTimeEntry + 0361), and a line keyed to
 * a person takes only that person's hours (0361, and importLaborCore before it writes).
 *
 * THE RULE, ONE COPY:
 *   - a line's person is the one its key names (`labor:<uuid>`, or a legacy `labor:<uuid>:<n>`);
 *   - a line typed by hand names people in words: everyone whose full name is in it, and everyone
 *     whose first name is in what is left once those full names are taken out ("Labor - Brian").
 *     Exactly one person named is the line's person. Two people ("Labor - Erik & Brian Taylor": Brian
 *     in full, Erik by his first name), or nobody ("Labor - ET Electric hourly with 2 guys"), is a
 *     crew line: it bills everyone's hours and is never judged. Open: a first name that is only a
 *     customer's ("Labor - Erik Norrel's panel") still reads as the worker Erik;
 *   - a claimed id is judged only when `ownerOf` knows its person (the caller's map: a time entry by
 *     its own profile_id; a retired split id by the shift it became, when the caller can read that).
 */

/** The key's person. Lower-case hex only, exactly as 0361's trigger reads it (Postgres prints uuids so). */
const KEYED = /^labor:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::[0-9]+)?$/;

export type LaborPerson = { id: string; name?: string | null };
export type ClaimingLine = { id: string; import_key?: string | null; description?: string | null; source_ids?: readonly string[] | null };
/** Time row id → the id of the person it belongs to. */
export type OwnerOf = ReadonlyMap<string, string>;

/** `labor:<uuid>` or `labor:<uuid>:<n>` → the uuid; a hand-typed line, `labor:unknown`, a cost key → null. */
export function laborKeyPerson(importKey: unknown): string | null {
  const m = KEYED.exec(String(importKey ?? ""));
  return m ? m[1] : null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `word` stands alone in `text` (letters and digits either side end it): "Erik" is in "Labor - Erik ", not in "Eriksen". */
const standsIn = (word: string, text: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}($|[^\\p{L}\\p{N}])`, "u").test(text);
/** `text` with every place `word` stands in it (as standsIn reads it) turned into a space. */
const takeOut = (word: string, text: string) => text.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}(?=$|[^\\p{L}\\p{N}])`, "gu"), "$1 ");

/** The person a labor line bills, or null for a crew line (nobody, or more than one person, named). */
export function laborLinePerson(line: Pick<ClaimingLine, "import_key" | "description">, people: readonly LaborPerson[]): string | null {
  const keyed = laborKeyPerson(line.import_key);
  if (keyed) return keyed;
  const words = String(line.description ?? "").toLowerCase();
  const byId = new Map<string, string>();
  for (const p of people) {
    const n = String(p.name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (p.id && n) byId.set(p.id, n);
  }
  // Everyone named: by full name, then by first name in what the full names leave. A full name found
  // doesn't end the search: "Labor - Erik & Brian Taylor" names Brian in full and Erik by his first
  // name, two people, a crew line.
  const full = [...byId].filter(([, n]) => standsIn(n, words));
  const rest = full.reduce((text, [, n]) => takeOut(n, text), words);
  const named = new Set([...full.map(([id]) => id), ...[...byId].filter(([, n]) => standsIn(n.split(" ")[0], rest)).map(([id]) => id)]);
  return named.size === 1 ? [...named][0] : null;
}

export type CrossedClaim = { lineId: string; person: string; ids: string[] };

/** The lines holding hours that are someone else's, and which ids. A crew line is never on it. */
export function claimsOffTheirPerson(lines: readonly ClaimingLine[], people: readonly LaborPerson[], ownerOf: OwnerOf): CrossedClaim[] {
  const out: CrossedClaim[] = [];
  for (const l of lines) {
    const person = laborLinePerson(l, people);
    if (!person) continue;
    const ids = (l.source_ids ?? []).map(String).filter((id) => {
      const owner = ownerOf.get(id);
      return !!owner && owner !== person;
    });
    if (ids.length) out.push({ lineId: l.id, person, ids });
  }
  return out;
}

export type ClaimMove = { lineId: string; before: string[]; after: string[] };
export type ClaimPlan = { ok: true; moves: ClaimMove[] } | { ok: false; why: string };

/**
 * ONE INVOICE'S LABOR LINES, EACH CLAIM ONTO ITS OWN PERSON'S LINE. Nothing is added or dropped: an id
 * leaves the line it is on for the line of the person it belongs to, on the same invoice, so the
 * invoice holds exactly what it held (the claim trigger never sees a new id). A line keeps its own
 * ids in their order and takes the incoming ones after them, in the order they sat.
 *
 * `moves` lists only the lines that change. Refused, with why, whenever the answer is not certain:
 * a labor line that names nobody or two people, a person with two lines, or hours whose person has
 * no line on the invoice. Nothing crossed is always ok with no moves, crew lines and all.
 */
export function planClaimsByPerson(lines: readonly ClaimingLine[], people: readonly LaborPerson[], ownerOf: OwnerOf): ClaimPlan {
  const crossed = claimsOffTheirPerson(lines, people, ownerOf);
  if (!crossed.length) return { ok: true, moves: [] };

  const lineOf = new Map<string, ClaimingLine>();
  for (const l of lines) {
    const person = laborLinePerson(l, people);
    const label = `"${String(l.description ?? "").trim() || "a labor line"}"`;
    if (!person) return { ok: false, why: `${label} names nobody, or more than one person, so whose hours it holds is not certain` };
    const twin = lineOf.get(person);
    if (twin) return { ok: false, why: `${label} and "${String(twin.description ?? "").trim()}" are both the same person's line` };
    lineOf.set(person, l);
  }

  const stays = (id: string, person: string) => {
    const owner = ownerOf.get(id);
    return !owner || owner === person;
  };
  const incoming = new Map<string, string[]>(lines.map((l) => [l.id, []]));
  for (const l of lines) {
    const person = laborLinePerson(l, people)!;
    for (const id of (l.source_ids ?? []).map(String)) {
      if (stays(id, person)) continue;
      const home = lineOf.get(ownerOf.get(id)!);
      if (!home) return { ok: false, why: `"${String(l.description ?? "").trim()}" holds hours of a person with no line on this invoice` };
      // Already on its own line too (one invoice may hold an id on two of its lines): it just leaves this one.
      const into = incoming.get(home.id)!;
      if (!(home.source_ids ?? []).map(String).includes(id) && !into.includes(id)) into.push(id);
    }
  }
  // Each line's own ids first (in their order), then what moved in (in the order it sat).
  const moves: ClaimMove[] = [];
  for (const l of lines) {
    const before = (l.source_ids ?? []).map(String);
    const person = laborLinePerson(l, people)!;
    const after = [...before.filter((id) => stays(id, person)), ...incoming.get(l.id)!];
    if (after.length !== before.length || after.some((id, i) => id !== before[i])) moves.push({ lineId: l.id, before, after });
  }
  return { ok: true, moves };
}
