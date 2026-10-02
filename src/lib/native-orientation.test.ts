import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * MAY THIS SCREEN BE TURNED SIDEWAYS — the three places that can answer, and the one rule that
 * matters more than any of them: an unknown answer LOCKS. A screen that cannot be rotated has to
 * keep working exactly as it does today, so nothing here is ever allowed to throw.
 */

const h = vi.hoisted(() => ({ native: true }));
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => h.native }));

type Call = { turn: string };

function fakeShell(opts: { fail?: boolean } = {}) {
  const calls: Call[] = [];
  (globalThis as { window?: unknown }).window = {
    Capacitor: {
      Plugins: {
        ScreenTurn: {
          allow: async (o: Call) => {
            if (opts.fail) throw new Error("no such plugin in this build");
            calls.push(o);
            return { turn: o.turn };
          },
        },
      },
    },
  };
  return calls;
}

function fakeBrowser(opts: { lockRejects?: boolean } = {}) {
  const seen: string[] = [];
  (globalThis as { screen?: unknown }).screen = {
    orientation: {
      lock: (o: string) => {
        seen.push(`lock:${o}`);
        return opts.lockRejects ? Promise.reject(new Error("needs fullscreen")) : Promise.resolve();
      },
      unlock: () => void seen.push("unlock"),
    },
  };
  return seen;
}

beforeEach(() => {
  h.native = true;
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { screen?: unknown }).screen;
});

describe("letTheScreenTurn", () => {
  it("asks the shell, and says the shell answered", async () => {
    const calls = fakeShell();
    const { letTheScreenTurn } = await import("./native-orientation");
    expect(await letTheScreenTurn("sideways")).toBe("shell");
    expect(await letTheScreenTurn("portrait")).toBe("shell");
    expect(calls).toEqual([{ turn: "sideways" }, { turn: "portrait" }]);
  });

  it("a shell build WITHOUT the plugin says nobody could be asked — it never throws", async () => {
    // The key is simply absent in an app installed before this shipped, and a bridge call into a
    // plugin that isn't there never answers. Both land here, not on a crash.
    (globalThis as { window?: unknown }).window = { Capacitor: { Plugins: {} } };
    const { letTheScreenTurn } = await import("./native-orientation");
    expect(await letTheScreenTurn("sideways")).toBe("no");
  });

  it("a plugin call that fails falls through instead of rejecting", async () => {
    fakeShell({ fail: true });
    const { letTheScreenTurn } = await import("./native-orientation");
    expect(await letTheScreenTurn("sideways")).toBe("no");
  });

  it("a phone browser unlocks for sideways and locks back to portrait", async () => {
    h.native = false;
    const seen = fakeBrowser();
    const { letTheScreenTurn } = await import("./native-orientation");
    expect(await letTheScreenTurn("sideways")).toBe("browser");
    expect(await letTheScreenTurn("portrait")).toBe("browser");
    expect(seen).toEqual(["unlock", "lock:portrait"]);
  });

  it("a lock the browser refuses is swallowed — nothing is said and nothing rejects", async () => {
    h.native = false;
    fakeBrowser({ lockRejects: true });
    const { letTheScreenTurn } = await import("./native-orientation");
    // Chrome rejects lock() when the page isn't installed/fullscreen. Not worth a word to anyone,
    // and an unhandled rejection in a cleanup function is worse than the lock not happening.
    await expect(letTheScreenTurn("portrait")).resolves.toBe("browser");
  });

  it("iOS Safari — no Screen Orientation API at all — says nobody could be asked", async () => {
    h.native = false;
    (globalThis as { screen?: unknown }).screen = {};
    const { letTheScreenTurn } = await import("./native-orientation");
    expect(await letTheScreenTurn("sideways")).toBe("no");
  });

  it("on the server (no window, no screen) it is a quiet no", async () => {
    h.native = false;
    const { letTheScreenTurn } = await import("./native-orientation");
    expect(await letTheScreenTurn("portrait")).toBe("no");
  });
});

describe("the bridge, not an import", () => {
  it("never imports a Capacitor package", () => {
    // The native-push / native-tap lesson: on the phone `await import("@capacitor/…")` HUNG. There
    // is no package for this one anyway — ScreenTurn is a local plugin in the shell — so reading
    // window.Capacitor.Plugins is both the only way and the better failure mode.
    const src = readFileSync(join(process.cwd(), "src/lib/native-orientation.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']@capacitor|import\(\s*["']@capacitor/);
  });
});
