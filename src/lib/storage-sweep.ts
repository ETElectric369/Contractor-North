import { createServiceClient } from "@/lib/supabase/server";
import { INTAKE_BUCKET, intakePaths } from "@/lib/playbook/uploads";
import { reportError } from "@/lib/observe";

/**
 * THE JANITOR (Erik: "we shouldnt hold onto old orphaned data anyway right?").
 *
 * Storage only ever grew. Three leak classes surfaced the day the plan brief shipped, all found
 * by walking Andrew's own test trail:
 *   · intake-uploads — a deleted lead's plan set stayed forever (deleteInquiry cleans its own
 *     files now, but everything orphaned BEFORE that shipped, or by a failed best-effort remove,
 *     stays until something sweeps). Seven files, ~22MB, on day one.
 *   · documents/<org>/appointments/<id>/ — a deleted appointment's capture photos linger.
 *   · documents/<org>/ai-uploads/ — the estimator stash is delete-on-read BEST-EFFORT; any
 *     survivor is a dead transport (and audit 7's reason for delete-on-read — a CED quote's net
 *     pricing sitting where any org member can read it — applies doubly to a leak).
 *
 * SQL cannot touch storage ("Direct deletion from storage tables is not allowed") — this runs on
 * the service client through the Storage API, from the daily cron. Everything gets a 48-hour age
 * guard: nothing mid-flight is ever reaped, and a file must be BOTH old and unreferenced to go.
 */

const AGE_MS = 48 * 60 * 60 * 1000;
/** Refuse an intake sweep that would wipe this many files against an EMPTY reference set —
 *  that shape is a broken read, not an empty inbox (audit v800). */
const MASS_DELETE_FLOOR = 5;
const PAGE = 1000;
const MAX_PAGES = 20; // 20k objects per folder per run — a bound, not a target; the cron reruns daily

type Svc = ReturnType<typeof createServiceClient>;
type Entry = { name: string; id: string | null; created_at?: string };

/** Every entry under a prefix, paginated. Folders come back with id=null. */
async function listAll(svc: Svc, bucket: string, prefix: string): Promise<Entry[]> {
  const out: Entry[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await svc.storage.from(bucket).list(prefix, { limit: PAGE, offset: page * PAGE });
    if (error || !data) break;
    out.push(...(data as Entry[]));
    if (data.length < PAGE) break;
  }
  return out;
}

const oldEnough = (e: Entry, now: number): boolean =>
  !!e.created_at && now - new Date(e.created_at).getTime() > AGE_MS;

/** Batch-remove with a hard result: how many actually went. */
async function removeAll(svc: Svc, bucket: string, paths: string[]): Promise<number> {
  let removed = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const { error } = await svc.storage.from(bucket).remove(batch);
    if (!error) removed += batch.length;
  }
  return removed;
}

export async function sweepOrphanedUploads(): Promise<Record<string, number>> {
  const svc = createServiceClient();
  const now = Date.now();
  const result: Record<string, number> = { intake_removed: 0, capture_removed: 0, stash_removed: 0 };

  // ── intake-uploads: files no live inquiry references ────────────────────────────────────
  const intakeOrgs = (await listAll(svc, INTAKE_BUCKET, "")).filter((e) => e.id === null);
  for (const org of intakeOrgs) {
    const files = (await listAll(svc, INTAKE_BUCKET, `${org.name}/intake`)).filter((e) => e.id !== null);
    if (!files.length) continue;
    // What this org's leads still point at — the whole reference set in one query.
    //
    // A FAILED READ IS NOT AN EMPTY REFERENCE SET (audit v800). supabase-js returns data:null on
    // ANY error — a statement timeout, a transient 5xx — and `inqs ?? []` turned that into "no
    // lead references anything", which made every plan set in the org an orphan and deleted the
    // lot. A janitor must fail CLOSED: when we cannot prove a file is unreferenced, it stays.
    const { data: inqs, error: inqErr } = await svc
      .from("inquiries")
      .select("intake")
      .eq("org_id", org.name)
      .not("intake", "is", null)
      .limit(10000);
    if (inqErr || !inqs) {
      reportError("storage-sweep:intake-refs", inqErr ?? new Error("no rows object"), { org: org.name });
      continue;
    }
    const referenced = new Set<string>();
    for (const r of inqs) for (const p of intakePaths((r as { intake?: unknown }).intake)) referenced.add(p);
    const aged = files.filter((f) => oldEnough(f, now));
    const orphans = aged.map((f) => `${org.name}/intake/${f.name}`).filter((p) => !referenced.has(p));
    // Second belt: an org whose leads reference NOTHING while holding aged files is far more
    // likely a broken read than a genuinely empty inbox. Refuse the mass delete and say so.
    if (referenced.size === 0 && orphans.length >= MASS_DELETE_FLOOR) {
      reportError(
        "storage-sweep:refused-mass-delete",
        new Error(`intake sweep would delete ${orphans.length} files with an empty reference set`),
        { org: org.name },
      );
      continue;
    }
    result.intake_removed += await removeAll(svc, INTAKE_BUCKET, orphans);
  }

  // ── documents/<org>/appointments/<id>/: folders whose appointment row is gone ───────────
  const docOrgs = (await listAll(svc, "documents", "")).filter((e) => e.id === null);
  for (const org of docOrgs) {
    const apptFolders = (await listAll(svc, "documents", `${org.name}/appointments`)).filter(
      (e) => e.id === null && /^[0-9a-f-]{36}$/i.test(e.name),
    );
    if (apptFolders.length) {
      const ids = apptFolders.map((f) => f.name);
      // CHUNKED AND FAIL-CLOSED (audit v800). PostgREST selects are GET requests, so .in() with
      // every folder id becomes a URL ~38 bytes per uuid — a few hundred inspections and the
      // request line blows the proxy's limit and errors. `alive ?? []` then read as "no
      // appointment exists", and the sweep deleted the capture photos of LIVE walk-throughs.
      const aliveSet = new Set<string>();
      let refsOk = true;
      for (let i = 0; i < ids.length && refsOk; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const { data: alive, error } = await svc.from("appointments").select("id").in("id", chunk).limit(chunk.length);
        if (error || !alive) {
          reportError("storage-sweep:appt-refs", error ?? new Error("no rows object"), { org: org.name });
          refsOk = false;
          break;
        }
        for (const a of alive as { id: string }[]) aliveSet.add(String(a.id));
      }
      if (!refsOk) continue; // cannot prove liveness → delete nothing for this org
      for (const folder of apptFolders) {
        if (aliveSet.has(folder.name)) continue;
        const files = (await listAll(svc, "documents", `${org.name}/appointments/${folder.name}`)).filter(
          (e) => e.id !== null && oldEnough(e, now),
        );
        result.capture_removed += await removeAll(
          svc,
          "documents",
          files.map((f) => `${org.name}/appointments/${folder.name}/${f.name}`),
        );
      }
    }

    // ── documents/<org>/ai-uploads/: the estimator stash is delete-on-read — a survivor this
    //    old is a leaked transport, never a record. No reference check needed by design.
    const stash = (await listAll(svc, "documents", `${org.name}/ai-uploads`)).filter(
      (e) => e.id !== null && oldEnough(e, now),
    );
    result.stash_removed += await removeAll(
      svc,
      "documents",
      stash.map((f) => `${org.name}/ai-uploads/${f.name}`),
    );
  }

  return result;
}
