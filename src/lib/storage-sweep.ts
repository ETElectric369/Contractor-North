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
 *   · documents/<org>/bug-screenshots/ — a fourth class, found by audit v921: the reporter writes
 *     a capture of the staff member's screen on every report and NOTHING ever deleted one, so
 *     every screen anyone has ever reported from stays readable to the whole org forever.
 *
 * SQL cannot touch storage ("Direct deletion from storage tables is not allowed") — this runs on
 * the service client through the Storage API, from the daily cron. Everything gets an age guard
 * (48 hours; 30 days for bug screenshots, which are a debug trail people come back to): nothing
 * mid-flight is ever reaped, and a file must be BOTH old and unreferenced to go.
 */

const AGE_MS = 48 * 60 * 60 * 1000;
/** A bug screenshot is a debug transport, not a record: once the report it belongs to is closed
 *  (or gone), the capture of that staff screen goes at this age (audit v921). */
const BUG_SHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Refuse an intake sweep that would wipe this many files against an EMPTY reference set —
 *  that shape is a broken read, not an empty inbox (audit v800). */
const MASS_DELETE_FLOOR = 5;
const PAGE = 1000;
const MAX_PAGES = 20; // 20k objects per folder per run — a bound, not a target; the cron reruns daily

type Svc = ReturnType<typeof createServiceClient>;
type Entry = { name: string; id: string | null; created_at?: string };

/**
 * A WHOLE reference set, or none (audit v921). A single `.limit(10000)` select is a cliff:
 * PostgREST's db-max-rows (1000 by default, a project setting that lives nowhere in this repo)
 * truncates it SILENTLY — status 200, no error — so the set came back partial and every lead past
 * the cap had its still-referenced plan PDFs classified as orphans and deleted. Page it, advancing
 * by the rows ACTUALLY returned (a page can come back capped short), and stop only on an empty
 * page. Anything else — an error, or running out of pages — returns rows:null so the caller
 * fails closed, the same contract as the other reference reads here.
 */
async function readAllRefs<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ rows: T[] | null; error: unknown }> {
  const out: T[] = [];
  for (let i = 0, from = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error || !data) return { rows: null, error: error ?? new Error("no rows object") };
    if (!data.length) return { rows: out, error: null };
    out.push(...data);
    from += data.length;
  }
  return { rows: null, error: new Error(`reference set exceeded ${MAX_PAGES * PAGE} rows`) };
}

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

const oldEnough = (e: Entry, now: number, ageMs: number = AGE_MS): boolean =>
  !!e.created_at && now - new Date(e.created_at).getTime() > ageMs;

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
  const result: Record<string, number> = { intake_removed: 0, capture_removed: 0, stash_removed: 0, bug_shot_removed: 0 };

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
    //
    // AND A CAPPED READ IS NOT A WHOLE REFERENCE SET (audit v921) — see readAllRefs: the old
    // single .limit(10000) select was truncated silently by PostgREST's max-rows, which deleted
    // the live plan sets of every lead past the cap. Ordered + paged, or nothing.
    const { rows: inqs, error: inqErr } = await readAllRefs<{ intake?: unknown }>((from, to) =>
      svc
        .from("inquiries")
        .select("intake")
        .eq("org_id", org.name)
        .not("intake", "is", null)
        .order("id")
        .range(from, to),
    );
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

    // ── documents/<org>/bug-screenshots/: nothing has ever deleted one (audit v921 — 215 objects
    //    in production and only ever growing; the reporter writes, no code path removes). A shot
    //    is a capture of a staff SCREEN that every member of the org can read for as long as it
    //    sits there, and it stops being evidence the moment the report is closed. Keep every shot
    //    an OPEN report still points at, whatever its age; reap the rest after a month. Fail
    //    closed like the sweeps above: no provable reference set, no deletions.
    const shots = (await listAll(svc, "documents", `${org.name}/bug-screenshots`)).filter(
      (e) => e.id !== null && oldEnough(e, now, BUG_SHOT_AGE_MS),
    );
    if (shots.length) {
      const { rows: openBugs, error: bugErr } = await readAllRefs<{ screenshot_path: string | null }>(
        (from, to) =>
          svc
            .from("bug_reports")
            .select("screenshot_path")
            .eq("org_id", org.name)
            .eq("status", "open")
            .not("screenshot_path", "is", null)
            .order("id")
            .range(from, to),
      );
      if (bugErr || !openBugs) {
        reportError("storage-sweep:bug-shot-refs", bugErr ?? new Error("no rows object"), { org: org.name });
      } else {
        const keep = new Set(openBugs.map((r) => String(r.screenshot_path ?? "")));
        const gone = shots.map((f) => `${org.name}/bug-screenshots/${f.name}`).filter((p) => !keep.has(p));
        const removed = await removeAll(svc, "documents", gone);
        result.bug_shot_removed += removed;
        // The pointer goes with the file: a report that still claims a screenshot gets a "View
        // screenshot" button that signs a URL for an object that isn't there and silently does
        // NOTHING (bug-list.tsx:29). Clearing the column is what removes the dead one-tap.
        // A zero-row match is normal here — a shot uploaded by a report that never sent has no
        // row at all — so only a real error is worth reporting.
        for (let i = 0; removed && i < gone.length; i += 100) {
          const { error: clearErr } = await svc
            .from("bug_reports")
            .update({ screenshot_path: null })
            .eq("org_id", org.name)
            .in("screenshot_path", gone.slice(i, i + 100))
            .select("id");
          if (clearErr) reportError("storage-sweep:bug-shot-clear", clearErr, { org: org.name });
        }
      }
    }
  }

  return result;
}
