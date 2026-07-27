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
  /** Registry key of the server action to replay. */
  action: string;
  args: unknown;
  /** When the USER did it, not when it synced. */
  createdAt: string;
  attempts: number;
  lastError?: string;
  /** Human-readable, for the "3 things waiting to sync" UI. */
  label: string;
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

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

/** Add an operation to the queue. Returns the op (its clientOpId is the idempotency key). */
export async function enqueue(action: string, args: unknown, label: string): Promise<QueuedOp> {
  const op: QueuedOp = {
    clientOpId: newOpId(),
    action,
    args,
    createdAt: new Date().toISOString(),
    attempts: 0,
    label,
  };
  await tx("readwrite", (s) => s.put(op));
  return op;
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

async function noteFailure(op: QueuedOp, message: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.put({ ...op, attempts: op.attempts + 1, lastError: message }));
  } catch {
    /* ignore */
  }
}

/** How a queued action is actually performed. Registered by the app so this module stays free of
 *  server-action imports (and therefore usable from anywhere). */
export type Replayer = (args: unknown, clientOpId: string) => Promise<{ ok: boolean; error?: string }>;

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
export async function drain(): Promise<{ sent: number; failed: number; remaining: number }> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { sent: 0, failed: 0, remaining: (await listPending()).length };
  }
  const pending = await listPending();
  let sent = 0;
  let failed = 0;
  for (const op of pending) {
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
      } else {
        await noteFailure(op, res.error ?? "failed");
        failed++;
        break; // preserve order
      }
    } catch (e) {
      await noteFailure(op, e instanceof Error ? e.message : "network");
      failed++;
      break;
    }
  }
  return { sent, failed, remaining: (await listPending()).length };
}

/** Drain now, and again whenever the connection returns. Returns an unsubscribe. */
export function startAutoDrain(onChange?: (r: { sent: number; failed: number; remaining: number }) => void): () => void {
  let stopped = false;
  const run = () => {
    if (stopped) return;
    drain().then((r) => {
      if (!stopped) onChange?.(r);
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
