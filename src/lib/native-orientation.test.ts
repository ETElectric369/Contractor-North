import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WHICH WAY THE PHONE IS BEING HELD — the shell REPORTS it now, it does not permit it.
 *
 * This file used to test the other job: asking the shell to unlock the interface so iOS would rotate
 * the whole view. That is precisely what carried the top bar and the dock around with it (Erik, on
 * cn-v1041: "nice it rotates now on schedule but the dock and top bar rotate with it still"), so the
 * interface is locked to portrait again and the native side's job is to say which way the DEVICE is
 * held. The one rule that survives unchanged: anything we cannot read means UPRIGHT — the screen is
 * left exactly as it is today rather than guessed at.
 */

const h = vi.hoisted(() => ({ native: true }));
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => h.native }));

/** A window that is only an event target, which is all this file uses one for. */
function fakeWindow(plugins: Record<string, unknown> | null = null) {
  const target = new EventTarget() as EventTarget & { Capacitor?: unknown };
  if (plugins) target.Capacitor = { Plugins: plugins };
  (globalThis as { window?: unknown }).window = target;
  return target;
}

/** Let every queued microtask (and the ask's promise chain) finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Fire the event the shell fires, with whatever the shell would have put in it. */
function shellSays(win: EventTarget, held: unknown) {
  win.dispatchEvent(new CustomEvent("cn:phone-held", { detail: { held } }));
}

beforeEach(() => {
  h.native = true;
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.resetModules();
});

describe("heldFromWord — anything we cannot read means upright", () => {
  it("reads the two turns, and only those", async () => {
    const { heldFromWord } = await import("./native-orientation");
    expect(heldFromWord("clockwise")).toBe("clockwise");
    expect(heldFromWord("counterclockwise")).toBe("counterclockwise");
    expect(heldFromWord("upright")).toBe("upright");
  });

  it("a word nobody wrote, a missing one, a number, an object — all upright", async () => {
    // The old rule was "an unknown answer LOCKS". This is the same rule in the new shape: nothing we
    // do not recognise is ever treated as a turn, so the worst a bad message can do is leave the
    // screen as it already is.
    const { heldFromWord } = await import("./native-orientation");
    for (const junk of [undefined, null, "", "sideways", "landscape", "LANDSCAPE", 90, {}, ["clockwise"]]) {
      expect(heldFromWord(junk)).toBe("upright");
    }
  });
});

describe("watchHowThePhoneIsHeld", () => {
  it("hears every turn the shell reports, in order", async () => {
    const win = fakeWindow({ ScreenTurn: {} });
    const { watchHowThePhoneIsHeld } = await import("./native-orientation");
    const heard: string[] = [];
    const stop = watchHowThePhoneIsHeld((x) => heard.push(x));
    shellSays(win, "clockwise");
    shellSays(win, "upright");
    shellSays(win, "counterclockwise");
    expect(heard).toEqual(["clockwise", "upright", "counterclockwise"]);
    stop();
  });

  it("stops listening when the watcher is torn down — a turn after that says nothing", async () => {
    const win = fakeWindow({ ScreenTurn: {} });
    const { watchHowThePhoneIsHeld } = await import("./native-orientation");
    const heard: string[] = [];
    const stop = watchHowThePhoneIsHeld((x) => heard.push(x));
    stop();
    shellSays(win, "clockwise");
    expect(heard).toEqual([]);
  });

  it("ASKS on the way in, which is what makes a hard reload while already turned land turned", async () => {
    // A reload sideways fires no change: the phone has not moved since. Without this ask the person
    // would have to turn the phone upright and back again to get the layout they were already in.
    const win = fakeWindow({ ScreenTurn: { read: async () => ({ held: "counterclockwise" }) } });
    const { watchHowThePhoneIsHeld } = await import("./native-orientation");
    const heard: string[] = [];
    const stop = watchHowThePhoneIsHeld((x) => heard.push(x));
    await settle();
    expect(heard).toEqual(["counterclockwise"]);
    // …and it keeps listening afterwards.
    shellSays(win, "upright");
    expect(heard).toEqual(["counterclockwise", "upright"]);
    stop();
  });

  it("a read that answers AFTER the watcher was torn down is dropped", async () => {
    let answer: (v: { held: string }) => void = () => {};
    fakeWindow({ ScreenTurn: { read: () => new Promise<{ held: string }>((r) => (answer = r)) } });
    const { watchHowThePhoneIsHeld } = await import("./native-orientation");
    const heard: string[] = [];
    const stop = watchHowThePhoneIsHeld((x) => heard.push(x));
    stop();
    answer({ held: "clockwise" });
    await settle();
    expect(heard).toEqual([]);
  });

  it("an older shell with no `read` is fine — it just never hears the first one", async () => {
    const win = fakeWindow({ ScreenTurn: {} });
    const { watchHowThePhoneIsHeld, whoReportsTheTurn } = await import("./native-orientation");
    expect(whoReportsTheTurn()).toBe("nobody");
    const heard: string[] = [];
    const stop = watchHowThePhoneIsHeld((x) => heard.push(x));
    await settle();
    expect(heard).toEqual([]);
    shellSays(win, "clockwise");
    expect(heard).toEqual(["clockwise"]);
    stop();
  });

  it("a `read` that rejects never rejects out of here", async () => {
    fakeWindow({ ScreenTurn: { read: async () => { throw new Error("no such plugin in this build"); } } });
    const { watchHowThePhoneIsHeld } = await import("./native-orientation");
    const heard: string[] = [];
    const stop = watchHowThePhoneIsHeld((x) => heard.push(x));
    await settle();
    expect(heard).toEqual([]);
    stop();
  });

  it("A BROWSER IS NEVER ASKED and never reports — a tab rotates natively and always did", async () => {
    // Not a gap: in a tab the page itself turns, and the `turned:` rules in globals.css are what keep
    // the chrome where it belongs there. If this reported a turn as well, a rotated tab would be drawn
    // through a SECOND quarter turn on top of the browser's own.
    h.native = false;
    const win = fakeWindow({ ScreenTurn: { read: async () => ({ held: "clockwise" }) } });
    const { watchHowThePhoneIsHeld, whoReportsTheTurn } = await import("./native-orientation");
    expect(whoReportsTheTurn()).toBe("nobody");
    const heard: string[] = [];
    const stop = watchHowThePhoneIsHeld((x) => heard.push(x));
    await settle();
    expect(heard).toEqual([]);
    stop();
    void win;
  });

  it("on the server (no window at all) it is a quiet no-op", async () => {
    const { watchHowThePhoneIsHeld, whoReportsTheTurn } = await import("./native-orientation");
    expect(whoReportsTheTurn()).toBe("nobody");
    expect(() => watchHowThePhoneIsHeld(() => {})()).not.toThrow();
  });

  it("inside the shell with the plugin present, the shell is who answers", async () => {
    fakeWindow({ ScreenTurn: { read: async () => ({ held: "upright" }) } });
    const { whoReportsTheTurn } = await import("./native-orientation");
    expect(whoReportsTheTurn()).toBe("shell");
  });
});

describe("the bridge, not an import", () => {
  it("never imports a Capacitor package", () => {
    // The native-push / native-tap lesson: on the phone `await import("@capacitor/…")` HUNG. There is
    // no package for this one anyway — ScreenTurn is a local plugin in the shell — so reading
    // window.Capacitor.Plugins is both the only way and the better failure mode.
    const src = readFileSync(join(process.cwd(), "src/lib/native-orientation.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']@capacitor|import\(\s*["']@capacitor/);
  });

  it("the event name is spelled the same in the web half and in the shell", () => {
    // Two literals, two languages, no compiler between them: the one hand-copied string in this whole
    // mechanism. Different spellings would mean a phone that turns and a page that never hears it.
    const web = readFileSync(join(process.cwd(), "src/lib/native-orientation.ts"), "utf8");
    const swift = readFileSync(join(process.cwd(), "ios/App/App/ScreenTurnPlugin.swift"), "utf8");
    expect(web).toContain('export const HELD_EVENT = "cn:phone-held"');
    expect(swift).toContain("'cn:phone-held'");
  });
});
