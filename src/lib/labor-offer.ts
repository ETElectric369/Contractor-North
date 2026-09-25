/**
 * NEW HOURS BESIDE A NEGOTIATED LINE (J-011, INV-078, 2026-09-24).
 *
 * The labor importer keys one line per person (`labor:<personId>`) and the RPC leaves an EDITED
 * line entirely alone, claims included (0175/0255) - a negotiated figure is the office's, not the
 * importer's. That is right for the hours the line was negotiated over. It was wrong for the hours
 * worked AFTER: they were offered under the same key, the RPC kept the edited line, and the new
 * shifts landed nowhere. The comment said they "stay free for the next bill" - but on a job billed
 * through one long-running draft (Andrew's INV-078, where all three labor lines carry his personal
 * rates) there is no next bill, and one open draft per job means there can't be. Six of Brian's
 * hours and six of Erik's were stranded behind "Add to INV-078", which the card priced and the
 * import could not deliver.
 *
 * So the new hours get their OWN line, beside the negotiated one: `labor:<personId>:2` (then :3
 * if that one is edited too). It carries only the entries no edited line on this invoice holds,
 * at the person's bill rate - the figure the card showed - and it is an ordinary imported line:
 * refreshed while untouched, left alone once edited, and never resurrected once deleted (a deleted
 * key in the chain stops it, exactly as a deleted base line stops the base). The negotiated line
 * is still offered under its own key so the RPC's "kept" count stays honest; it changes nothing.
 *
 * A person with no edited line is offered exactly as before - one line, one key.
 */

import type { LaborLine } from "./labor-billing";

export type OwnLaborLine = { import_key: string | null; edited: boolean | null; source_ids: string[] | null };
export type LaborOffer = { importKey: string; line: LaborLine };

export function planLaborOffer(input: {
  /** Entries free of every OTHER invoice's claims (withoutClaimedLabor's output). */
  entries: any[];
  /** This invoice's own labor lines. */
  ownLines: readonly OwnLaborLine[];
  /** invoices.dismissed_import_keys. */
  dismissed: ReadonlySet<string>;
  /** computeJobLaborBilling bound to the job's rates and codes. */
  bill: (entries: any[]) => LaborLine[];
}): LaborOffer[] {
  const byKey = new Map<string, OwnLaborLine>();
  for (const l of input.ownLines) if (l.import_key) byKey.set(l.import_key, l);
  const heldByEdited = new Set<string>();
  for (const l of input.ownLines) if (l.edited) for (const id of l.source_ids ?? []) heldByEdited.add(String(id));

  const all = input.bill(input.entries);
  // Only computed when some person's line is edited — the ordinary import pays nothing extra.
  let rest: LaborLine[] | null = null;
  const out: LaborOffer[] = [];
  for (const line of all) {
    const baseKey = `labor:${line.personId}`;
    out.push({ importKey: baseKey, line });
    if (!byKey.get(baseKey)?.edited) continue;
    rest ??= input.bill(input.entries.filter((e) => !heldByEdited.has(String(e?.id))));
    const fresh = rest.find((r) => r.personId === line.personId);
    if (!fresh) continue; // every hour is on a negotiated line already
    let n = 2;
    let key: string | null = null;
    for (;;) {
      const k = `${baseKey}:${n}`;
      if (input.dismissed.has(k)) break; // the office deleted that line: never bring it back
      if (byKey.get(k)?.edited) {
        n++;
        continue;
      }
      key = k;
      break;
    }
    if (key) out.push({ importKey: key, line: fresh });
  }
  return out;
}
