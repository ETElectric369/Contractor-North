/**
 * A CLAIM ON THIS INVOICE THAT ITS OWN IMPORTER DID NOT WRITE IS TAKEN (Already Billed, wave 1).
 *
 * Erik, 2026-09-26: "i have a bill for purple sage that was already charged and i have no way to
 * associate it to the paid invoice becuase i did it manually and that will happen for people i
 * assure you". A charge made by hand is a line the importer does not own: INV-00023's "Materials"
 * ($110, typed by hand) now holds CED 8802-1101475, INV-059's and INV-060's "Labor - Brian" hold
 * Brian's shifts, and INV-060's edited materials line (keyed to one Home Depot bill) holds the two
 * Ace receipts beside it.
 *
 * THE HOLE. Every importer reads the claims with claimedSourcesOnJob(…, exceptInvoiceId): the
 * invoice being built never blocks its own refresh. That is right for the importer's OWN lines (it
 * rewrites them) and wrong for everything else on the invoice. Pressing Materials From Costs on
 * paid INV-060 offered the Ace receipts again as new lines, and the claim trigger (0258) allows a
 * repeat on one invoice, so the paid bill would reopen with a balance for work it already charged.
 *
 * THE RULE. An id on this invoice is TAKEN for the importer being run when:
 *   - its line came from anywhere else: another import source, or a line added by hand; or
 *   - its line is the importer's own and EDITED (the importer keeps an edited line as it is), and
 *     the id is not one the line's key names: the importer only ever writes the ids its key names,
 *     so any other id on that line was put there by a person (INV-060's two Ace receipts on a line
 *     keyed to the Home Depot bill; a legacy keyless labor line holding Brian's shifts).
 * An UNEDITED line of the importer's own takes nothing: the import rewrites its claims (0255).
 * An edited labor line keeps the entries of the person its key names, so the join (labor-offer:
 * new hours join the person's edited line, INV-078) reads exactly what it read before.
 *
 * The taken ids join the claim map as held by THIS invoice, so every sentence the importers already
 * say reads true: "3 already on INV-060 skipped".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClaimantInvoice, ClaimedSources } from "@/lib/unbilled-work";
import { laborPersonKey } from "@/lib/labor-billing";

export type ImportSource = "labor" | "costs" | "quote" | "change_orders";

export type HereLine = {
  import_source?: string | null;
  import_key?: string | null;
  edited?: boolean | null;
  source_ids?: readonly string[] | null;
};

/** The ids the importer itself writes on a line with this key. null = a key it never writes (or
 *  none at all), so every id on the line was put there some other way. */
export type KeyNames = (line: HereLine) => ReadonlySet<string> | null;

/** The ids on this invoice that the importer for `source` must treat as billed (see the header). */
export function heldOnThisInvoice(lines: readonly HereLine[] | null | undefined, source: ImportSource, names: KeyNames): string[] {
  const out = new Set<string>();
  for (const l of lines ?? []) {
    const ids = (l.source_ids ?? []).map((x) => String(x ?? "")).filter(Boolean);
    if (!ids.length) continue;
    if ((l.import_source ?? null) !== source) {
      for (const id of ids) out.add(id);
      continue;
    }
    if (l.edited !== true) continue;
    const named = names(l);
    for (const id of ids) if (!named?.has(id)) out.add(id);
  }
  return [...out];
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * LABOR: `labor:<person>` (or a legacy overflow `labor:<person>:n`) names that person's time
 * entries, keyed exactly the way computeJobLaborBilling keys a person (laborPersonKey). A keyless
 * labor line names nobody.
 */
export function laborKeyNames(entries: readonly any[] | null | undefined): KeyNames {
  const byPerson = new Map<string, Set<string>>();
  for (const e of entries ?? []) {
    if (!e?.id) continue;
    const k = laborPersonKey(e.profiles);
    const set = byPerson.get(k) ?? new Set<string>();
    set.add(String(e.id));
    byPerson.set(k, set);
  }
  return (line) => {
    const key = String(line.import_key ?? "");
    if (!key.startsWith("labor:")) return null;
    const person = key.slice("labor:".length).replace(/:\d+$/, "");
    return byPerson.get(person) ?? new Set<string>();
  };
}

/**
 * MATERIALS: `po:<id>` and `bill:<id>` (and its `:remainder` row) name that row; `bli:<line>` names
 * the bill the line is on; `stock:<group>` names the take's moves. A `bli:` line whose bill line
 * is gone (the receipt was read again) names the first id it holds, the one the importer wrote; a
 * take that is gone names what the line holds (its moves are nobody's candidates any more).
 */
export function costsKeyNames(opts: { billOfLine: ReadonlyMap<string, string>; movesOfTake: ReadonlyMap<string, readonly string[]> }): KeyNames {
  const direct = new RegExp(`^(?:po|bill):(${UUID})`, "i");
  const bli = new RegExp(`^bli:(${UUID})`, "i");
  return (line) => {
    const key = String(line.import_key ?? "");
    let m = direct.exec(key);
    if (m) return new Set([m[1].toLowerCase()]);
    m = bli.exec(key);
    if (m) {
      const bill = opts.billOfLine.get(m[1].toLowerCase()) ?? opts.billOfLine.get(m[1]);
      const first = line.source_ids?.[0];
      return new Set(bill ? [String(bill)] : first ? [String(first)] : []);
    }
    if (key.startsWith("stock:")) {
      const moves = opts.movesOfTake.get(key.slice("stock:".length));
      return new Set((moves ?? line.source_ids ?? []).map(String));
    }
    return null;
  };
}

/** ESTIMATE LINES and CHANGE ORDERS: `quote:<id>` / `co:<id>` name that one row. */
export function idKeyNames(prefix: "quote" | "co"): KeyNames {
  const re = new RegExp(`^${prefix}:(${UUID})`, "i");
  return (line) => {
    const m = re.exec(String(line.import_key ?? ""));
    return m ? new Set([m[1].toLowerCase()]) : null;
  };
}

/** The claim map with this invoice's taken ids added (an id another invoice holds keeps that owner). */
export function withHeldHere(claims: ClaimedSources, here: ClaimantInvoice, ids: readonly string[]): ClaimedSources {
  if (!ids.length) return claims;
  const owner = new Map(claims.owner);
  for (const id of ids) if (!owner.has(id)) owner.set(id, here);
  return { ...claims, owner };
}

/** The one select the read below makes (pinned by the importer tests' fake). */
export const HELD_HERE_COLUMNS = "invoice_number, status, created_at, job_id, invoice_items(import_source, import_key, edited, source_ids)";

/**
 * Read this invoice's lines and return the ids its importer must skip. A lost read is not "nothing
 * taken": the caller refuses, nothing written.
 */
export async function readHeldHere(
  supabase: Pick<SupabaseClient, "from">,
  invoiceId: string,
  source: ImportSource,
  names: KeyNames,
): Promise<{ ok: true; here: ClaimantInvoice; ids: string[] } | { ok: false; error: unknown }> {
  const { data, error } = await supabase.from("invoices").select(HELD_HERE_COLUMNS).eq("id", invoiceId).maybeSingle();
  if (error) return { ok: false, error };
  const row = (data ?? null) as {
    invoice_number?: string | null;
    status?: string | null;
    created_at?: string | null;
    job_id?: string | null;
    invoice_items?: HereLine[] | null;
  } | null;
  const here: ClaimantInvoice = {
    id: invoiceId,
    invoice_number: row?.invoice_number ?? null,
    status: String(row?.status ?? ""),
    created_at: String(row?.created_at ?? ""),
    job_id: row?.job_id ?? null,
  };
  return { ok: true, here, ids: heldOnThisInvoice(row?.invoice_items ?? [], source, names) };
}

/** The sentence a lost read of this invoice's own lines gets (nothing imported). */
export const HELD_HERE_READ_FAILED = "Couldn't read this invoice's lines just now, so nothing was imported - try again in a moment.";
