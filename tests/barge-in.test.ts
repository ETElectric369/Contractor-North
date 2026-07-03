import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBargeInMonitor, BARGE_IN_FLOOR, BARGE_IN_MARGIN, BARGE_IN_SUSTAIN_MS, BARGE_IN_BASELINE_MS } from "@/lib/tts";

/**
 * CHANGE 2 — barge-in, now ADAPTIVE (cn-v339). During TTS playback we poll a coarse RMS off the
 * already-live analyser. For the first BASELINE_MS we LEARN the ambient (engine/road/echo bleed) and
 * never fire; after that the gate = max(FLOOR, ambient + MARGIN), and a run staying above it for
 * SUSTAIN_MS CONTINUOUSLY fires onBargeIn (stops playback + re-arms the mic). A null RMS = uncertainty
 * = never interrupt. Constant loud noise becomes the ambient and therefore does NOT trip it.
 */
describe("startBargeInMonitor — adaptive sustained talk-over detection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // With a SILENT baseline (ambient learned as 0), the gate settles to the floor.
  const GATE = Math.max(BARGE_IN_FLOOR, 0 + BARGE_IN_MARGIN);
  const ABOVE = GATE + 0.05;
  const BELOW = Math.max(0, GATE - 0.03);
  const PAST_BASELINE = BARGE_IN_BASELINE_MS + 120; // safely past the calibration window

  it("fires after a talk-over sustained past the calibration window", () => {
    let rms = 0; // quiet during calibration
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => rms, onBarge);
    vi.advanceTimersByTime(PAST_BASELINE); // let it learn ambient ≈ 0
    rms = ABOVE; // now Erik talks over it
    vi.advanceTimersByTime(BARGE_IN_SUSTAIN_MS + 200);
    expect(onBarge).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does NOT fire DURING calibration even if it's loud (that IS the ambient)", () => {
    // Constant loud from t=0 → learned as ambient → gate rises above it → never trips.
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => ABOVE, onBarge);
    vi.advanceTimersByTime(5000);
    expect(onBarge).not.toHaveBeenCalled();
    stop();
  });

  it("does NOT fire on brief energy that drops back below the gate", () => {
    let rms = 0;
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => rms, onBarge);
    vi.advanceTimersByTime(PAST_BASELINE);
    rms = ABOVE;
    vi.advanceTimersByTime(Math.max(0, BARGE_IN_SUSTAIN_MS - 100)); // not long enough
    rms = BELOW;
    vi.advanceTimersByTime(2000);
    expect(onBarge).not.toHaveBeenCalled();
    stop();
  });

  it("does NOT fire while energy stays at the ambient floor (Nort's own bleed)", () => {
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => BELOW, onBarge);
    vi.advanceTimersByTime(3000);
    expect(onBarge).not.toHaveBeenCalled();
    stop();
  });

  it("NEVER interrupts when RMS is null (no live analyser — uncertainty → no interrupt)", () => {
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => null, onBarge);
    vi.advanceTimersByTime(3000);
    expect(onBarge).not.toHaveBeenCalled();
    stop();
  });

  it("a null in the middle of a loud run resets the sustain counter (no interrupt)", () => {
    let rms: number | null = 0;
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => rms, onBarge);
    vi.advanceTimersByTime(PAST_BASELINE);
    rms = ABOVE;
    vi.advanceTimersByTime(Math.max(0, BARGE_IN_SUSTAIN_MS - 100));
    rms = null; // analyser blip → can't judge → reset
    vi.advanceTimersByTime(100);
    rms = ABOVE;
    vi.advanceTimersByTime(100); // not yet a full fresh sustain window
    expect(onBarge).not.toHaveBeenCalled();
    stop();
  });

  it("fires at most once, then stops polling", () => {
    let rms = 0;
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => rms, onBarge);
    vi.advanceTimersByTime(PAST_BASELINE);
    rms = ABOVE;
    vi.advanceTimersByTime(5000);
    expect(onBarge).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stop() before the window elapses prevents any fire", () => {
    let rms = 0;
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => rms, onBarge);
    vi.advanceTimersByTime(PAST_BASELINE);
    rms = ABOVE;
    vi.advanceTimersByTime(Math.max(0, BARGE_IN_SUSTAIN_MS - 50));
    stop();
    vi.advanceTimersByTime(5000);
    expect(onBarge).not.toHaveBeenCalled();
  });

  it("an rmsFn that throws is treated as uncertainty (no interrupt)", () => {
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => { throw new Error("read failed"); }, onBarge);
    vi.advanceTimersByTime(3000);
    expect(onBarge).not.toHaveBeenCalled();
    stop();
  });
});
