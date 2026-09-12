/**
 * AN OFFICE EDIT MAY NEVER KILL THE ROW AN INVOICE BILLED (0255 — the claims model).
 *
 * A labor line on an invoice claims the time_entry / time_allocation ids it billed
 * (invoice_items.source_ids), and the importers skip a claimed id, so the same hour can never
 * land on two invoices. That only holds while the ids HOLD STILL. updateTimeEntry used to
 * replace a shift's whole split on every save — delete the old rows, insert new ones — so the
 * moment the office corrected a description on a paid entry, INV-061's claimed allocation ids
 * were gone, the fresh rows looked unbilled, and the next "New Invoice" billed the customer for
 * those hours a second time. The invariant is written here, as pure arithmetic, so it can be
 * pinned without a database:
 *
 *   • a submitted row that carries an id is that row, edited in place;
 *   • a submitted row without an id is matched to a stored row on the same job, in order
 *     (the timecard editor never sends ids — it round-trips {job, code, hours, description});
 *   • a matched row keeps its id, so whatever invoice claims it keeps its claim;
 *   • a stored row nothing matches is removed — unless an invoice claims it, in which case the
 *     whole edit is refused, naming that invoice (the office voids or adjusts the invoice first);
 *   • a claimed row may not move to another job (its hours were billed to THIS job's customer).
 *
 * The entry itself is a claimable row too: an un-split shift is billed by its entry id. When
 * the office splits such a shift for the first time, billing switches from "the entry, gross"
 * to "its allocation rows", so the claim has to be carried onto the new rows or they bill again
 * (entryClaimCarry decides; updateTimeEntry performs the rewrite after the insert).
 */

export type StoredAllocation = {
  id: string;
  job_id: string | null;
  job_code: string | null;
  hours: number | null;
  description: string | null;
  sort_order: number | null;
};

/** A submitted row, jobs already resolved to ids the caller may see. `id` is optional — see header. */
export type NextAllocation = {
  id?: string | null;
  job_id: string | null;
  job_code: string | null;
  hours: number;
  description: string | null;
};

/** The invoice that holds a claim on a source row. */
export type ClaimHolder = { id: string; invoice_number: string | null };

/** source row id (a time_entry or time_allocation id) → the non-void invoice that bills it. */
export type ClaimIndex = ReadonlyMap<string, ClaimHolder>;

export type PlannedRow = {
  job_id: string | null;
  job_code: string | null;
  hours: number;
  description: string | null;
  sort_order: number;
};

export type AllocationPlan =
  | {
      ok: true;
      /** Stored rows edited in place — their ids (and claims) survive. */
      update: { id: string; row: PlannedRow }[];
      /** Genuinely new rows. */
      insert: PlannedRow[];
      /** Stored rows nothing matched and no invoice claims. */
      remove: string[];
    }
  | { ok: false; error: string };

const invoiceLabel = (h: ClaimHolder | undefined): string => h?.invoice_number ?? "an invoice";
const fmtHours = (h: number | null | undefined): string => `${(Math.round((Number(h) || 0) * 100) / 100).toFixed(2)} h`;

/**
 * Decide, row by row, how a submitted split lands on a stored one. Pure. The order of `next` is
 * the office's order on screen and becomes sort_order, exactly as the old replace did.
 */
export function planAllocationEdit(stored: StoredAllocation[], next: NextAllocation[], claims: ClaimIndex): AllocationPlan {
  const byId = new Map(stored.map((s) => [s.id, s] as const));
  const pairedStored = new Set<string>();
  const pairs: { stored: StoredAllocation; nextIdx: number }[] = [];
  const unpairedNext: number[] = [];

  // 1. Rows that name their stored row are that row.
  next.forEach((n, idx) => {
    const id = n.id ? String(n.id) : "";
    if (id && byId.has(id) && !pairedStored.has(id)) {
      pairedStored.add(id);
      pairs.push({ stored: byId.get(id)!, nextIdx: idx });
    } else {
      unpairedNext.push(idx);
    }
  });

  // 2. Id-less rows match the stored rows on the same job, in order. The editor round-trips a
  //    split without ids, so "same job, same position" is the only identity it can carry —
  //    and it is enough: the claims on those rows are on this job, and order is preserved.
  const key = (jobId: string | null | undefined) => jobId ?? "";
  const storedByJob = new Map<string, StoredAllocation[]>();
  for (const s of [...stored].sort(bySortOrder)) {
    if (pairedStored.has(s.id)) continue;
    const k = key(s.job_id);
    storedByJob.set(k, [...(storedByJob.get(k) ?? []), s]);
  }
  const insert: { idx: number }[] = [];
  for (const idx of unpairedNext) {
    const queue = storedByJob.get(key(next[idx].job_id));
    const s = queue?.shift();
    if (s) {
      pairedStored.add(s.id);
      pairs.push({ stored: s, nextIdx: idx });
    } else {
      insert.push({ idx });
    }
  }

  // 3. Refusals, decided before a single write: a claimed row may neither leave its job nor go.
  for (const p of pairs) {
    const holder = claims.get(p.stored.id);
    if (holder && key(next[p.nextIdx].job_id) !== key(p.stored.job_id)) {
      return {
        ok: false,
        error: `${invoiceLabel(holder)} already bills the ${fmtHours(p.stored.hours)} part of this shift — void or adjust that invoice before moving those hours to another job. Nothing was changed.`,
      };
    }
  }
  const remove: string[] = [];
  for (const s of stored) {
    if (pairedStored.has(s.id)) continue;
    const holder = claims.get(s.id);
    if (holder) {
      return {
        ok: false,
        error: `${invoiceLabel(holder)} already bills the ${fmtHours(s.hours)} part of this shift — void or adjust that invoice before removing it from the split. Nothing was changed.`,
      };
    }
    remove.push(s.id);
  }

  const toRow = (idx: number): PlannedRow => {
    const n = next[idx];
    return {
      job_id: n.job_id ?? null,
      job_code: n.job_code || null,
      hours: Number(n.hours) || 0,
      description: n.description || null,
      sort_order: idx,
    };
  };
  return {
    ok: true,
    update: pairs.sort((a, b) => a.nextIdx - b.nextIdx).map((p) => ({ id: p.stored.id, row: toRow(p.nextIdx) })),
    insert: insert.map((i) => toRow(i.idx)),
    remove,
  };
}

function bySortOrder(a: StoredAllocation, b: StoredAllocation): number {
  const ao = a.sort_order ?? Number.MAX_SAFE_INTEGER;
  const bo = b.sort_order ?? Number.MAX_SAFE_INTEGER;
  return ao !== bo ? ao - bo : a.id.localeCompare(b.id);
}

export type EntryClaimDecision = { ok: true; carry: boolean } | { ok: false; error: string };

/**
 * The entry-level claim. An un-split shift is billed (and claimed) by its ENTRY id. Splitting it
 * for the first time moves billing onto the allocation rows, so the invoice that billed the
 * entry must also claim the rows it just became — or the same hours bill again through the
 * rows. A row headed to ANOTHER job is refused: those hours went out on this job's invoice.
 *
 * A split shift whose entry id is claimed (the 0256 backfill's shape for an entry's unlabeled
 * hours) keeps that claim untouched — its rows are governed by planAllocationEdit.
 */
export function entryClaimCarry(input: {
  entryId: string;
  /** The entry's job AFTER this edit. */
  entryJobId: string | null;
  stored: StoredAllocation[];
  next: NextAllocation[];
  claims: ClaimIndex;
}): EntryClaimDecision {
  const holder = input.claims.get(input.entryId);
  if (!holder) return { ok: true, carry: false };
  if (input.stored.length || !input.next.length) return { ok: true, carry: false };
  const leaving = input.next.find((n) => n.job_id && n.job_id !== input.entryJobId);
  if (leaving) {
    return {
      ok: false,
      error: `${invoiceLabel(holder)} already bills this whole shift — void or adjust that invoice before splitting part of it onto another job. Nothing was changed.`,
    };
  }
  return { ok: true, carry: true };
}

/** The sentence for a job move on a claimed shift — one place, so every door says the same thing. */
export function claimedMoveRefusal(holder: ClaimHolder): string {
  return `${invoiceLabel(holder)} already bills this shift — void or adjust that invoice before moving its hours to another job. Nothing was changed.`;
}
