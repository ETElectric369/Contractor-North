import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE NATIVE SCREENS HOLD A RELEASE RELOAD FOR AS LONG AS THEIR RESULT IS ON ITS WAY (cn-v1205,
 * skeptic #101's finding 4). The hold is fifteen minutes from a line, not "while the screen is up":
 * so the scan and the measure hold again the moment their screen closes, and the Tap to Pay Settings
 * door holds from its first statement (Apple's terms sheet can take minutes). Fake plugins; the
 * clock is moved inside the native call, as a long walk would move it.
 */
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => true }));
vi.mock("@/app/(app)/billing/tap-actions", () => ({ ensureTerminalLocation: vi.fn(), tapToPayContext: vi.fn() }));
vi.mock("@/app/report-client-error", () => ({ reportClientError: vi.fn() }));

import { clearReleaseHold, releaseReloadHeld } from "@/lib/release-on-return";
import { scan3dNative } from "@/lib/native-scan";
import { measureNative } from "@/lib/native-measure";
import { enableTapToPay } from "@/lib/native-tap";

const START = Date.UTC(2026, 0, 1, 8, 0, 0);
const TWENTY_MIN = 20 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  clearReleaseHold();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function plugins(p: Record<string, unknown>) {
  vi.stubGlobal("window", { Capacitor: { Plugins: p } });
}

describe("a screen that stays up past fifteen minutes", () => {
  it("3D Scan: held again when the screen closes, so the pull starts under a fresh hold", async () => {
    plugins({
      Scan: {
        scan3d: async () => {
          vi.setSystemTime(START + TWENTY_MIN); // the walk outlasted the first hold
          expect(releaseReloadHeld(Date.now())).toBe(false);
          return { ok: false };
        },
      },
    });
    await scan3dNative(START);
    expect(releaseReloadHeld(Date.now())).toBe(true);
    expect(releaseReloadHeld(START + TWENTY_MIN + 15 * 60_000 - 1)).toBe(true);
  });

  it("Measure: held again when the screen closes", async () => {
    plugins({
      Measure: {
        measure: async () => {
          vi.setSystemTime(START + TWENTY_MIN);
          return { ok: false };
        },
      },
    });
    await measureNative("length");
    expect(releaseReloadHeld(Date.now())).toBe(true);
  });

  it("each still holds before its screen opens", async () => {
    const heldInside: boolean[] = [];
    plugins({
      Scan: { scan3d: async () => (heldInside.push(releaseReloadHeld(Date.now())), { ok: false }) },
      Measure: { measure: async () => (heldInside.push(releaseReloadHeld(Date.now())), { ok: false }) },
    });
    await scan3dNative(START);
    clearReleaseHold();
    await measureNative("area");
    expect(heldInside).toEqual([true, true]);
  });
});

describe("Tap to Pay's Settings door", () => {
  it("holds from its first statement, even where the plugin is not in the build", async () => {
    plugins({});
    await enableTapToPay();
    expect(releaseReloadHeld(Date.now())).toBe(true);
    expect(releaseReloadHeld(START + 15 * 60_000)).toBe(false);
  });
});
