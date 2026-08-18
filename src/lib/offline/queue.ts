"use client";

/**
 * THE OFFLINE WRITE QUEUE.
 *
 * Chilcoot has dead zones, and the service worker deliberately never touches /api or server
 * actions — so today a save attempted with no signal simply fails and the work is gone. The
 * inspector retypes it, or doesn't.
 *
 * This holds the intent in IndexedDB and replays it when the connection comes back. Three
 * decisions the rest of the design hangs on:
 *
 *  1. IDEMPOTENCY IS SERVER-SIDE, NOT HERE. Every operation carries a `clientOpId` minted once,
 *     before the first attempt, and reused on every retry. `runOnce` (0167) makes the second
 *     arrival a no-op. A client-only queue that retries is a duplicate generator.
 *
 *  2. THE CLIENT'S CLOCK TRAVELS WITH THE OPERATION. A note written at 7am and synced at 11am
 *     happened at 7am. Anything time-sensitive must put its own timestamp in `args` — the server
 *     cannot recover it from arrival order.
 *
 *  3. IT NEVER SILENTLY GIVES UP. An operation that fails repeatedly stays queued and visible
 *     rather than being dropped after N tries; losing a contractor's work quietly is the failure
 *     mode this exists to prevent. `listPending` is what a UI uses to say so.
 *
 * IndexedDB is used rather than localStorage because iOS evicts localStorage under pressure and
 * this is exactly the data you cannot afford to lose.
 */

const DB_NAME = "cn-offline";
const STORE = "queue";
const DB_VERSION = 1;

export type QueuedOp = {
  /** Minted once, reused on every retry — the whole idempotency story. */
  clientOpId: string;
  /**
   * WHO QUEUED IT. Without this, a shared shop phone files one person's work as another's: tech A
   * queues a 7:02 punch with no signal, signs out, tech B signs in, the drain fires on mount, and
   * clockIn resolves the actor from the CURRENT session — A's punch, A's GPS, on B's timecard,
   * with the idempotency ledger recording B so the audit trail agrees with the wrong answer.
   * Signing out clears the service-worker page cache but NOT IndexedDB, so the queue outlives the
   * session that created it. An op belonging to someone else is skipped, never dropped — it is
   * still A's work and it files when A signs back in.
   */
  ownerId: string | null;
  /** Registry key of the server action to replay. */
  action: string;
  args: unknown;
  /** When the USER did it, not when it synced. */
  createdAt: string;
  attempts: number;
  lastError?: string;
  /** Human-readable, for the "3 things waiting to sync" UI. */
  label: string;
  /**
   * Quarantined: the server REJECTED this on a replay (not a network failure), so retrying it
   * will only fail again. It stays in the queue — nothing is ever deleted — but it no longer
   * blocks everything behind it. Before this, one punch too old to file sat at the head of the
   * queue forever and silently stopped every later punch and inspection sheet from syncing.
   */
  blocked?: boolean;
  blockedReason?: string;
};

function newOpId(): string {
  // crypto.randomUUID isn't available in every WebView we run in (older iOS PWAs); the fallback
  // is still collision-safe enough for a per-device queue.
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no indexedDB"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "clientOpId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * SETTLE ON THE TRANSACTION, NOT THE REQUEST (audit 9).
 *
 * `req.onsuccess` fires when IndexedDB accepts the operation — the write is still uncommitted and
 * can be aborted afterwards (quota exhaustion on a phone near its storage ceiling is the ordinary
 * case). Resolving there let `enqueue` report a punch as held on the phone that was never
 * actually stored: the tech is told his morning is safe by the one mechanism designed to make it
 * safe. A READ can settle on the request; a WRITE waits for the commit.
 */
function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        let result: T;
        let settled = false;
        const done = (fn: () => void) => {
          if (settled) return;
          settled = true;
          try {
            db.close();
          } catch {
            /* already closing */
          }
          fn();
        };
        req.onsuccess = () => {
          result = req.result;
          if (mode === "readonly") done(() => resolve(result));
        };
        req.onerror = () => done(() => reject(req.error));
        t.oncomplete = () => done(() => resolve(result));
        t.onabort = () => done(() => reject(t.error ?? new Error("aborted")));
        t.onerror = () => done(() => reject(t.error ?? new Error("transaction failed")));
      }),
  );
}

/**
 * Add an operation to the queue. ALWAYS returns the op — `persisted` says whether it actually
 * reached IndexedDB (audit 9).
 *
 * This was the one export that could throw: on a device where IndexedDB is unavailable or wedged
 * (Safari with all cookies blocked, an iOS WKWebView with website data off, a corrupt store), the
 * rejection escaped the caller's try and killed a punch on a phone WITH FULL SIGNAL — the queue
 * that exists to make a dead zone survivable was the thing that lost the work.
 *
 * It still returns the op when the write fails, because `clientOpId` is the idempotency key the
 * LIVE call needs (0167 runOnce); dropping it would let a double-tap file two entries. The caller
 * uses `persisted` to decide what it may honestly TELL the user — "saved on your phone" is only
 * true when it is.
 */
export type EnqueueResult = { op: QueuedOp; persisted: boolean };

export async function enqueue(
  action: string,
  args: unknown,
  label: string,
  ownerId?: string | null,
): Promise<EnqueueResult> {
  const op: QueuedOp = {
    clientOpId: newOpId(),
    ownerId: ownerId ?? null,
    action,
    args,
    createdAt: new Date().toISOString(),
    attempts: 0,
    label,
  };
  try {
    await tx("readwrite", (s) => s.put(op));
    return { op, persisted: true };
  } catch {
    return { op, persisted: false };
  }
}

export async function listPending(): Promise<QueuedOp[]> {
  try {
    const all = await tx<QueuedOp[]>("readonly", (s) => s.getAll() as IDBRequest<QueuedOp[]>);
    return (all ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

export async function remove(clientOpId: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(clientOpId));
  } catch {
    /* a queue we can't reach is a queue we can't corrupt */
  }
}

export type DrainResult = { sent: number; failed: number; blocked: number; remaining: number };

/** Park an op the server refused. Kept (never deleted) so the user can still see the work and
 *  what happened to it — this is what a "waiting to sync" screen should render. */
async function quarantine(op: QueuedOp, reason: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.put({ ...op, attempts: op.attempts + 1, blocked: true, blockedReason: reason, lastError: reason }));
  } catch {
    /* ignore */
  }
}

async function noteFailure(op: QueuedOp, message: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.put({ ...op, attempts: op.attempts + 1, lastError: message }));
  } catch {
    /* ignore */
  }
}

/** How a queued action is actually performed. Registered by the app so this module stays free of
 *  server-action imports (and therefore usable from anywhere). */
/** `retryable` marks a refusal that TIME can fix (a stale auth token after hours offline, a
 *  transient DB error) — the drain waits instead of quarantining the work forever (audit 9). */
export type Replayer = (args: unknown, clientOpId: string) => Promise<{ ok: boolean; error?: string; retryable?: boolean }>;

const replayers = new Map<string, Replayer>();

export function registerReplayer(action: string, fn: Replayer): void {
  replayers.set(action, fn);
}

/**
 * Drain the queue, oldest first. Stops at the first failure so operations replay IN ORDER — two
 * edits to the same record must not land backwards.
 *
 * Returns what happened so a caller can tell the user rather than syncing invisibly.
 */
export async function drain(currentUserId?: string | null): Promise<DrainResult> {
  const summarize = async (sent: number, failed: number) => {
    const rest = await listPending();
    return { sent, failed, blocked: rest.filter((o) => o.blocked).length, remaining: rest.length };
  };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return summarize(0, 0);

  const pending = await listPending();
  let sent = 0;
  let failed = 0;
  for (const op of pending) {
    // Already quarantined — skip, don't retry, don't block what's behind it.
    if (op.blocked) continue;
    // Someone else's work. Skip it silently and leave it for them; filing it under whoever
    // happens to be signed in now is how one person's hours land on another's timecard.
    if (currentUserId && op.ownerId && op.ownerId !== currentUserId) continue;
    const fn = replayers.get(op.action);
    if (!fn) {
      // An op queued by an older build whose action this build no longer knows. Leave it —
      // deleting it would throw away the user's work to tidy a data structure.
      continue;
    }
    try {
      const res = await fn(op.args, op.clientOpId);
      if (res.ok) {
        await remove(op.clientOpId);
        sent++;
      } else if (res.retryable) {
        // The SERVER answered, but with something time will fix — an auth token that hadn't
        // refreshed yet after hours offline, a transient DB error (audit 9). Quarantining these
        // threw away a real morning's work permanently: nothing in the product ever un-blocks an
        // op. Treat it exactly like a network failure — stop, keep order, try the next drain.
        await noteFailure(op, res.error ?? "not yet");
        failed++;
        break;
      } else {
        // A REJECTION, not a connectivity problem. Retrying is pointless and it must not become
        // a permanent blockage — quarantine it and carry on with the rest.
        await quarantine(op, res.error ?? "The server wouldn't accept it.");
        failed++;
      }
    } catch (e) {
      // A real network failure. STOP here so ops replay in order — two edits to the same record
      // must not land backwards — and try again on the next drain.
      await noteFailure(op, e instanceof Error ? e.message : "network");
      failed++;
      break;
    }
  }
  return summarize(sent, failed);
}

/** Drain now, and again whenever the connection returns. Returns an unsubscribe. */
/** One drain at a time: overlapping runs replay the same op twice (audit 9). */
let draining: Promise<DrainResult> | null = null;

export function startAutoDrain(
  onChange?: (r: DrainResult) => void,
  currentUserId?: string | null,
): () => void {
  let stopped = false;
  const run = () => {
    if (stopped) return;
    // `online` and `visibilitychange` fire milliseconds apart when a phone reaches the edge of
    // coverage — without this, two drains replay the same op concurrently.
    draining = (draining ?? Promise.resolve(null as unknown as DrainResult))
      .catch(() => null as unknown as DrainResult)
      .then(() => drain(currentUserId));
    draining.then((r) => {
      if (!stopped && r) onChange?.(r);
    });
  };
  run();
  window.addEventListener("online", run);
  // Coming back to the app is the other moment a phone typically regains signal — `online` alone
  // misses the case where the radio recovered while the app was backgrounded.
  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    window.removeEventListener("online", run);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
