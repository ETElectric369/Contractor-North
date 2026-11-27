/**
 * THE FENCE'S LIVE WATCH: ROUGH READS MAY SAY "INSIDE"; ONLY A SHARP READ MAY SAY "OUTSIDE"
 * (cn-v1208). In the shell the live watch is fed by the phone's hundred-metre read (geo.ts, every fix
 * marked `rough: true`). The live "did you leave?" sheet is the only one that can close a shift by
 * itself, and a rough fix can be wrong while it claims a small uncertainty (an out-of-date Wi-Fi
 * position indoors, where a hundred-metre read never powers GPS to correct it). So a rough fix that
 * would count as OUTSIDE is not used at all: ONE sharp read is asked instead, and only its answer is
 * counted. A fix with no mark (a browser's watch, an older shell) is counted as it always was.
 */

import { notAPosition, type GeoCoords, type GeoResult } from "@/lib/geo";

/** A watch fix as the fence takes it. `rough` only on the phone-fed watch. */
export type LiveFix = { coords: GeoCoords; accuracy: number; rough?: boolean };

/** True when this fix may NOT decide by itself: a rough fix that would count as outside the padded
 *  radius (the same "inside" test the fence uses: distance <= radius + accuracy). Pure. */
export function needsSharpProof(f: { rough?: boolean; distanceM: number; radiusM: number; accuracyM: number }): boolean {
  return f.rough === true && f.distanceM > f.radiusM + f.accuracyM;
}

/** The one console line about a sharp read that failed. Fixed words only: an error could carry a position. */
const SHARP_READ_WARNING = "[geofence] the live watch's sharp read could not be counted";

/**
 * The live watch's one door for a fix (the monitor's onFix). `alive()` is false once the effect was
 * disposed or the shift is done; `trip()` names the trip (a proof asked on one trip is dropped on
 * another). A fix rougher than `ignoreAccuracyM` is ignored, as before. A fix that needsSharpProof is
 * not used at all (nothing is handed to `count`); instead ONE sharp read is asked through `askSharp`
 * (the monitor's getPosition at Best, 10 s, no cached position),
 * at most one out at a time (`proofOut`), and an "ok" answer goes through this same door with no mark.
 * Any other answer, or an answer that comes when the effect is gone, the shift done or the trip
 * changed: nothing this round. Every other fix goes to `count` with its accuracy and distance.
 *
 * FRESH OR NOTHING. The door stamps what it counts with the time it is counted, so an answer about
 * THEN must never be counted as NOW: a phone pocketed while the sharp read is out hands its answer
 * over when the app comes back, hours later, and an old "inside" would then be written down as seen
 * at the site at that moment. So the answer is dropped when it lands more than `staleMs` after it
 * was asked (by `now`, the monitor's clock), when the fix itself is older than `staleMs` (the shell
 * does not enforce maximumAge, geo.ts), or when it is not a position (notAPosition). The slot is
 * freed whatever happens: a read that could not be asked, or one that rejects, must not hold it, or
 * no exit would ever be proved again in this page's life.
 */
export function liveFixDoor(d: {
  alive: () => boolean;
  trip: () => unknown;
  ignoreAccuracyM: number;
  radiusM: number;
  distanceM: (c: GeoCoords) => number;
  proofOut: { current: boolean };
  askSharp: () => Promise<GeoResult>;
  now: () => number;
  staleMs: number;
  count: (fix: { coords: GeoCoords; accuracy: number }, distanceM: number) => void;
}): (fix: LiveFix) => void {
  const door = (fix: LiveFix) => {
    if (!d.alive()) return;
    const acc = fix.accuracy || 0;
    if (acc > d.ignoreAccuracyM) return;
    const dist = d.distanceM(fix.coords);
    if (needsSharpProof({ rough: fix.rough, distanceM: dist, radiusM: d.radiusM, accuracyM: acc })) {
      if (d.proofOut.current) return;
      d.proofOut.current = true;
      const trip = d.trip();
      const askedAt = d.now();
      let asked: Promise<GeoResult>;
      try {
        asked = d.askSharp();
      } catch {
        d.proofOut.current = false;
        console.warn(SHARP_READ_WARNING);
        return;
      }
      void asked
        .then((r) => {
          if (d.trip() !== trip || r.status !== "ok") return;
          if (d.now() - askedAt > d.staleMs) return;
          if (typeof r.fixAgeMs === "number" && r.fixAgeMs > d.staleMs) return;
          if (notAPosition(r)) return;
          door({ coords: r.coords, accuracy: r.accuracy }); // the door's first line drops it once the effect is gone or the shift done
        })
        .catch(() => {
          console.warn(SHARP_READ_WARNING);
        })
        .finally(() => {
          d.proofOut.current = false;
        });
      return;
    }
    d.count({ coords: fix.coords, accuracy: acc }, dist);
  };
  return door;
}
