"use client";

import { fetchClip, playClip, speakSmart, startBargeInMonitor, stopSpeaking } from "@/lib/tts";
import { GREETING_CLIP_V } from "@/lib/nort/greeting";

/**
 * PLAY THE GREETING THE INSTANT THE MIC IS LIVE, from a clip kept on the phone.
 *
 * The first time a phrase is needed it is synthesized once (/api/tts) and stored in IndexedDB;
 * every later open plays it with no round trip. THE GREETING MUST NEVER ADD TO THE WAIT IT EXISTS
 * TO END: getting a clip (the store, or the network for a cold phrase) is raced against
 * ACQUIRE_MAX_MS — past it the greeting is skipped and the turn begins, while the fetch keeps
 * going in the background to fill the store for next time. Playback itself is capped too, and a
 * cap or a cut STOPS the sound (a greeting still playing into the first turn would be recorded
 * and sent as the person's words). His voice wins: the barge-in monitor (tts.ts, the one the
 * replies use) is armed once audio is audible and after a short grace, so the phone's own
 * speaker cannot cut the greeting in its first syllable. Resolves TRUE only when the greeting
 * was heard to its end — the caller marks "the greeting asked" on that and nothing less.
 */
const DB = "cn-nort";
const STORE = "clips";
const ACQUIRE_MAX_MS = 2_000;
const GREETING_MAX_MS = 8_000;
const BARGE_GRACE_MS = 900;
const SHELF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

type Entry = { blob: Blob; at: number };

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      if (typeof indexedDB === "undefined") return res(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch {} };
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
      req.onblocked = () => res(null);
    } catch {
      res(null);
    }
  });
}
async function cacheGet(key: string): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((res) => {
    try {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      r.onsuccess = () => {
        const e = r.result as Entry | undefined;
        db.close();
        res(e && e.blob instanceof Blob && Date.now() - (e.at || 0) < SHELF_LIFE_MS ? e.blob : null);
      };
      r.onerror = () => { db.close(); res(null); };
    } catch {
      try { db.close(); } catch {}
      res(null);
    }
  });
}
async function cachePut(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ blob, at: Date.now() } as Entry, key);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  } catch {
    try { db.close(); } catch {}
  }
}
async function cacheDelete(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  } catch {
    try { db.close(); } catch {}
  }
}

export const clipKey = (text: string) => `${GREETING_CLIP_V}:${text}`;

/** The clip for a phrase: the store first, else synthesized once and stored. Never throws. */
async function acquire(text: string): Promise<{ blob: Blob | null; fromCache: boolean }> {
  try {
    const cached = await cacheGet(clipKey(text));
    if (cached) return { blob: cached, fromCache: true };
    const fresh = await fetchClip(text);
    if (fresh) void cachePut(clipKey(text), fresh);
    return { blob: fresh, fromCache: false };
  } catch {
    return { blob: null, fromCache: false };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How the greeting went: "heard" to its end; "cut" by the person's own voice once it was audible
 *  (they answered over it — that IS hearing it; Erik's first night: "i said sure, it repeated");
 *  "skipped" when it never became audible (no clip in time, no mic, stopped, capped before a sound).
 *  `rms` is the live mic level (speech.analyserRms); null (the shell drops the capture while Nort
 *  speaks) means no barge-in, as with every reply. */
export type GreetingOutcome = "heard" | "cut" | "skipped";

export async function playGreeting(text: string, rms: () => number | null): Promise<GreetingOutcome> {
  const t = text.trim();
  if (!t) return "skipped";
  // Bounded: a cold phrase on bad signal, or a store that will not open, must not hold the mic.
  const got = await Promise.race([acquire(t), sleep(ACQUIRE_MAX_MS).then(() => null)]);
  if (got === null) return "skipped"; // acquire() keeps running and fills the store
  return new Promise<GreetingOutcome>((res) => {
    let settled = false;
    let audible = false;
    let stopBarge: () => void = () => {};
    let cutSound: () => void = () => {};
    const settle = (o: GreetingOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      stopBarge();
      if (o !== "heard") cutSound(); // a cap or a cut must not leave Nort talking into the first turn
      res(o);
    };
    const cap = setTimeout(() => settle(audible ? "cut" : "skipped"), GREETING_MAX_MS);
    // Arm the barge-in only once audio is audible and a grace has passed: the first syllable out
    // of a cold capture through the phone's own speaker is not the person talking over Nort.
    const armBarge = () => {
      if (settled) return;
      audible = true;
      const armAt = Date.now() + BARGE_GRACE_MS;
      stopBarge = startBargeInMonitor(rms, () => { if (Date.now() >= armAt) settle("cut"); });
    };
    if (got.blob) {
      const clip = playClip(got.blob, t);
      cutSound = clip.stop;
      clip.done.then((o) => {
        if (o === "failed" && got.fromCache) void cacheDelete(clipKey(t)); // a poisoned clip is dropped, not replayed
        settle(o === "ended" ? "heard" : o === "stopped" && audible ? "cut" : "skipped");
      }, () => settle("skipped"));
      void clip.playing.then(armBarge);
    } else {
      cutSound = stopSpeaking;
      armBarge();
      speakSmart(t, () => settle("heard"));
    }
  });
}
