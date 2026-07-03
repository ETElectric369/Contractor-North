import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBargeInMonitor, BARGE_IN_RMS, BARGE_IN_SUSTAIN_MS } from "@/lib/tts";

/**
 * CHANGE 2 — barge-in. During TTS playback we poll a coarse RMS off the already-live analyser; when
 * input energy stays above BARGE_IN_RMS for BARGE_IN_SUSTAIN_MS CONTINUOUSLY, we treat it as the user
 * talking over Nort and fire onBargeIn (which stops playback + re-arms the mic). The gate is set well
 * above the echo-cancelled TTS bleed and any uncertainty (a null RMS) defaults to NOT interrupting.
 */
describe("startBargeInMonitor — sustained talk-over detection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const ABOVE = BARGE_IN_RMS + 0.05;
  const BELOW = BARGE_IN_RMS - 0.05;

  it("fires after sustained energy above the gate", () => {
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => ABOVE, onBarge);
    // Needs SUSTAIN plus a couple of poll intervals (aboveSince is stamped on the first over-gate tick).
    vi.advanceTimersByTime(BARGE_IN_SUSTAIN_MS + 300);
    expect(onBarge).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does NOT fire on brief energy that drops back below the gate", () => {
    let rms = ABOVE;
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => rms, onBarge);
    // Above for less than the sustain window, then quiet — the run must be CONTINUOUS.
    vi.advanceTimersByTime(Math.max(0, BARGE_IN_SUSTAIN_MS - 100));
    rms = BELOW;
    vi.advanceTimersByTime(2000);
    expect(onBarge).not.toHaveBeenCalled();
    stop();
  });

  it("does NOT fire while energy stays below the gate (Nort's own bleed)", () => {
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
    let rms: number | null = ABOVE;
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => rms, onBarge);
    vi.advanceTimersByTime(Math.max(0, BARGE_IN_SUSTAIN_MS - 100));
    rms = null; // analyser blip → can't judge → reset
    vi.advanceTimersByTime(100);
    rms = ABOVE;
    vi.advanceTimersByTime(100); // not yet a full fresh sustain window
    expect(onBarge).not.toHaveBeenCalled();
    stop();
  });

  it("fires at most once, then stops polling", () => {
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => ABOVE, onBarge);
    vi.advanceTimersByTime(5000);
    expect(onBarge).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stop() before the window elapses prevents any fire", () => {
    const onBarge = vi.fn();
    const stop = startBargeInMonitor(() => ABOVE, onBarge);
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
