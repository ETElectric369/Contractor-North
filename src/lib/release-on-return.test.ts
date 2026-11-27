import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "@/lib/version";
import {
  AWAY_MIN_MS,
  CHECK_CAP_MS,
  HOLD_MS,
  LIVE_VERSION_URL,
  RELOADED_FOR_KEY,
  clearReleaseHold,
  clearReloadChecks,
  fieldFocused,
  hasText,
  holdReleaseReload,
  holdReloadWhile,
  installReleaseOnReturn,
  isFileInput,
  isTextField,
  liveVersionOf,
  midTyping,
  modalOpen,
  releaseReloadHeld,
  reloadWouldLoseWork,
  unsafeToReloadNow,
  verdictOnReturn,
  type ReturnVerdict,
} from "@/lib/release-on-return";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");

const SHELL_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 CNShell/7 (iOS)";
const BROWSER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const worker = (v: string) => `// the worker\nconst VERSION = "${v}";\nconst STATIC_CACHE = \`static-\${VERSION}\`;\n`;
const NEXT = "cn-v9999";

type Handler = (e: { target?: unknown }) => void;
type Options = { capture?: boolean; passive?: boolean } | undefined;

/** A page with no DOM: just what the rule reads, and a way to fire the events it listens for. */
function fakePage() {
  const handlers = new Map<string, Set<Handler>>();
  const classes = new Set<string>();
  const added: Options[] = [];
  const removed: Options[] = [];
  const page = {
    visibilityState: "visible",
    body: { classList: { contains: (c: string) => classes.has(c) } },
    activeElement: null as unknown,
    addEventListener(type: string, fn: Handler, options?: Options) {
      added.push(options);
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Handler, options?: Options) {
      removed.push(options);
      handlers.get(type)?.delete(fn);
    },
  };
  return {
    page,
    classes,
    added,
    removed,
    fire(type: string, target?: unknown) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn({ target });
    },
    listening: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    types: () => [...handlers.entries()].filter(([, s]) => s.size > 0).map(([t]) => t).sort(),
  };
}

function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

/** The whole rule wired to fakes: a clock the test moves, a live version the test sets. */
function setup(over: { ua?: string; serviceWorker?: boolean; live?: string | null; store?: ReturnType<typeof fakeStore> | null; hidden?: boolean } = {}) {
  const p = fakePage();
  if (over.hidden) p.page.visibilityState = "hidden";
  let t = 1_000_000;
  let live: string | null = over.live === undefined ? NEXT : over.live;
  const verdicts: ReturnVerdict[] = [];
  let settle: (() => void) | null = null;
  const reload = vi.fn();
  const fetchText = vi.fn(async (_url: string, _cap: number) => (live === null ? null : worker(live)));
  const store = over.store === undefined ? fakeStore() : over.store;
  const nav: { userAgent: string; serviceWorker?: object } = { userAgent: over.ua ?? SHELL_UA };
  if (over.serviceWorker) nav.serviceWorker = {};
  const stop = installReleaseOnReturn({
    doc: p.page,
    nav,
    now: () => t,
    mine: APP_VERSION,
    fetchText,
    storage: store,
    reload,
    onVerdict: (v) => {
      verdicts.push(v);
      settle?.();
    },
  });
  /** Out of sight for `ms`, then back; resolves once the rule has given its verdict (or at once when it asks nothing). */
  const awayFor = async (ms: number, duringFetch?: () => void): Promise<ReturnVerdict | null> => {
    p.page.visibilityState = "hidden";
    p.fire("visibilitychange");
    t += ms;
    p.page.visibilityState = "visible";
    const before = verdicts.length;
    const done = new Promise<void>((r) => (settle = r));
    p.fire("visibilitychange");
    duringFetch?.();
    if (ms < AWAY_MIN_MS) return null;
    await done;
    settle = null;
    return verdicts[before] ?? null;
  };
  return {
    ...p,
    stop,
    reload,
    fetchText,
    store,
    verdicts,
    awayFor,
    /** Resolves at the next verdict. */
    nextVerdict: () => new Promise<ReturnVerdict>((r) => (settle = () => r(verdicts[verdicts.length - 1]))),
    tick: (ms: number) => void (t += ms),
    now: () => t,
    setLive: (v: string | null) => void (live = v),
  };
}

beforeEach(() => {
  clearReleaseHold();
  clearReloadChecks();
});

describe("the live release is read from the worker file's own VERSION line", () => {
  it("reads today's public/sw.js, and it is the build's own version", () => {
    expect(liveVersionOf(src("public/sw.js"))).toBe(APP_VERSION);
  });

  it("answers null for anything else: no line, another shape, a page of html", () => {
    expect(liveVersionOf("")).toBeNull();
    expect(liveVersionOf("<!doctype html><title>Sign In</title>")).toBeNull();
    expect(liveVersionOf('const VERSION = "v12";')).toBeNull();
    expect(liveVersionOf('  const VERSION = "cn-v12";')).toBeNull();
    expect(liveVersionOf('// const VERSION = "cn-v12";')).toBeNull();
    expect(liveVersionOf(worker("cn-v12"))).toBe("cn-v12");
  });

  it("the check asks for that file, with a four second cap, after ten seconds away, and holds for fifteen minutes", () => {
    expect(LIVE_VERSION_URL).toBe("/sw.js");
    expect(CHECK_CAP_MS).toBe(4000);
    expect(AWAY_MIN_MS).toBe(10_000);
    expect(HOLD_MS).toBe(15 * 60_000);
  });
});

describe("the verdict on a return", () => {
  const clear = {
    mine: "cn-v1",
    live: "cn-v2" as string | null,
    reloadedFor: null as string | null,
    visible: true,
    held: false,
    busy: false,
    modalOpen: false,
    fieldFocused: false,
    typedOnScreen: false,
    touchedSinceBack: false,
  };

  it("reloads only when the live release is another one and nothing stands in the way", () => {
    expect(verdictOnReturn(clear)).toBe("reload");
    expect(verdictOnReturn({ ...clear, live: "cn-v0" })).toBe("reload"); // a roll back is taken too
  });

  it("names the one thing that stood in the way", () => {
    expect(verdictOnReturn({ ...clear, live: null })).toBe("unknown");
    expect(verdictOnReturn({ ...clear, live: "cn-v1" })).toBe("same");
    expect(verdictOnReturn({ ...clear, reloadedFor: "cn-v2" })).toBe("looped");
    expect(verdictOnReturn({ ...clear, visible: false })).toBe("hidden");
    expect(verdictOnReturn({ ...clear, held: true })).toBe("held");
    expect(verdictOnReturn({ ...clear, busy: true })).toBe("busy");
    expect(verdictOnReturn({ ...clear, modalOpen: true })).toBe("modal");
    expect(verdictOnReturn({ ...clear, fieldFocused: true })).toBe("focused");
    expect(verdictOnReturn({ ...clear, typedOnScreen: true })).toBe("typed");
    expect(verdictOnReturn({ ...clear, touchedSinceBack: true })).toBe("touched");
  });

  it("work only this page holds stands after a hold and before a sheet", () => {
    expect(verdictOnReturn({ ...clear, held: true, busy: true })).toBe("held");
    expect(verdictOnReturn({ ...clear, busy: true, modalOpen: true })).toBe("busy");
  });

  it("a reload for an older live release does not stop the next one", () => {
    expect(verdictOnReturn({ ...clear, reloadedFor: "cn-v1" })).toBe("reload");
  });
});

describe("the hold: a native screen or a file picker was opened", () => {
  it("holds for fifteen minutes from the call, and not a moment longer", () => {
    expect(releaseReloadHeld(5000)).toBe(false);
    holdReleaseReload(5000);
    expect(releaseReloadHeld(5000)).toBe(true);
    expect(releaseReloadHeld(5000 + HOLD_MS - 1)).toBe(true);
    expect(releaseReloadHeld(5000 + HOLD_MS)).toBe(false);
  });

  it("a later, shorter hold never shortens an earlier one", () => {
    holdReleaseReload(0, 60_000);
    holdReleaseReload(1000, 10);
    expect(releaseReloadHeld(59_999)).toBe(true);
    expect(releaseReloadHeld(60_000)).toBe(false);
  });

  it("each of the four native doors holds before it opens", () => {
    for (const [file, fn] of [
      ["src/lib/native-scan.ts", "export async function scan3dNative("],
      ["src/lib/native-measure.ts", "export async function measureNative("],
      ["src/lib/native-tap.ts", "export async function collectTapPayment("],
      ["src/lib/native-tap.ts", "export async function enableTapToPay("],
    ] as const) {
      const text = src(file);
      expect(text, file).toContain('import { holdReleaseReload } from "@/lib/release-on-return";');
      const body = text.slice(text.indexOf(fn));
      const open = body.indexOf("{\n", body.indexOf("): Promise<"));
      // The hold is the function's first statement: before the plugin is asked for anything.
      expect(body.slice(open + 2, open + 2 + 80).trimStart().startsWith("holdReleaseReload();"), file).toBe(true);
    }
  });
});

describe("work only this page holds: the screens register it", () => {
  it("nothing registered: nothing would be lost", () => {
    expect(reloadWouldLoseWork()).toBe(false);
  });

  it("answers what the check answers, at the moment it is asked", () => {
    let busy = false;
    holdReloadWhile(() => busy);
    expect(reloadWouldLoseWork()).toBe(false);
    busy = true;
    expect(reloadWouldLoseWork()).toBe(true);
  });

  it("a check that throws counts as work that would be lost", () => {
    holdReloadWhile(() => {
      throw new Error("not ready");
    });
    expect(reloadWouldLoseWork()).toBe(true);
  });

  it("a check taken back no longer counts, and several are each their own", () => {
    let a = true;
    let b = false;
    const backA = holdReloadWhile(() => a);
    const backB = holdReloadWhile(() => b);
    expect(reloadWouldLoseWork()).toBe(true);
    backA();
    expect(reloadWouldLoseWork()).toBe(false);
    b = true;
    expect(reloadWouldLoseWork()).toBe(true);
    backB();
    a = true;
    expect(reloadWouldLoseWork()).toBe(false);
  });

  it("the same check registered twice is two holds, each taken back alone", () => {
    const check = () => true;
    const one = holdReloadWhile(check);
    const two = holdReloadWhile(check);
    one();
    expect(reloadWouldLoseWork()).toBe(true);
    two();
    expect(reloadWouldLoseWork()).toBe(false);
  });
});

describe("what counts as a field, as typed text, and as mid-typing", () => {
  it("a text field is an input that takes text, a textarea, or an editable block", () => {
    expect(isTextField({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextField({ tagName: "INPUT" })).toBe(true);
    expect(isTextField({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTextField({ tagName: "INPUT", type: "password" })).toBe(true);
    expect(isTextField({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(isTextField({ tagName: "DIV", isContentEditable: true })).toBe(true);
    for (const type of ["checkbox", "radio", "file", "button", "submit", "reset", "range", "color", "image", "hidden", "FILE"]) {
      expect(isTextField({ tagName: "INPUT", type }), type).toBe(false);
    }
    expect(isTextField({ tagName: "SELECT" })).toBe(false);
    expect(isTextField({ tagName: "DIV" })).toBe(false);
    expect(isTextField(null)).toBe(false);
    expect(isTextField("INPUT")).toBe(false);
  });

  it("a file input is told apart from every other", () => {
    expect(isFileInput({ tagName: "INPUT", type: "file" })).toBe(true);
    expect(isFileInput({ tagName: "INPUT", type: "FILE" })).toBe(true);
    expect(isFileInput({ tagName: "INPUT", type: "text" })).toBe(false);
    expect(isFileInput({ tagName: "INPUT" })).toBe(false);
    expect(isFileInput({ tagName: "BUTTON", type: "file" })).toBe(false);
    expect(isFileInput(null)).toBe(false);
  });

  it("text is text: spaces alone are not", () => {
    expect(hasText({ tagName: "INPUT", value: "panel" })).toBe(true);
    expect(hasText({ tagName: "INPUT", value: "   " })).toBe(false);
    expect(hasText({ tagName: "INPUT", value: "" })).toBe(false);
    expect(hasText({ tagName: "TEXTAREA", value: "a\nb" })).toBe(true);
    expect(hasText({ tagName: "DIV", isContentEditable: true, textContent: " note " })).toBe(true);
    expect(hasText({ tagName: "DIV", isContentEditable: true, textContent: "" })).toBe(false);
  });

  it("mid-typing is a sheet up or a field with focus, the rule the browser's reload already had", () => {
    const page = (classes: string[], activeElement: unknown) => ({
      body: { classList: { contains: (c: string) => classes.includes(c) } },
      activeElement,
    });
    expect(midTyping(page([], null))).toBe(false);
    expect(midTyping(page([], { tagName: "BODY" }))).toBe(false);
    expect(midTyping(page(["modal-open"], null))).toBe(true);
    expect(modalOpen(page(["modal-open"], null))).toBe(true);
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(fieldFocused(page([], { tagName })), tagName).toBe(true);
      expect(midTyping(page([], { tagName })), tagName).toBe(true);
    }
    expect(midTyping(page([], { tagName: "DIV", isContentEditable: true }))).toBe(true);
    expect(midTyping(page([], { tagName: "BUTTON" }))).toBe(false);
  });

  it("the browser's reload rule reads the lib's one question and keeps no copy of its own", () => {
    const pwa = src("src/components/pwa-register.tsx");
    expect(pwa).toContain('import { unsafeToReloadNow } from "@/lib/release-on-return";');
    expect(pwa).not.toContain("const midTyping");
    expect(pwa).not.toContain("midTyping()");
    expect(pwa).not.toContain('classList.contains("modal-open")');
    expect(pwa).toContain("if (!unsafeToReloadNow()) {");
    expect(pwa).toContain("if (unsafeToReloadNow()) return;");
  });

  it("unsafe to reload: a sheet or a focused field, a hold, or work only this page holds", () => {
    const page = (classes: string[], activeElement: unknown) => ({
      body: { classList: { contains: (c: string) => classes.includes(c) } },
      activeElement,
    });
    expect(unsafeToReloadNow(page([], null), 5000)).toBe(false);
    expect(unsafeToReloadNow(page(["modal-open"], null), 5000)).toBe(true);
    expect(unsafeToReloadNow(page([], { tagName: "INPUT" }), 5000)).toBe(true);
    holdReleaseReload(5000, 1000);
    expect(unsafeToReloadNow(page([], null), 5999)).toBe(true);
    expect(unsafeToReloadNow(page([], null), 6000)).toBe(false);
    const back = holdReloadWhile(() => true);
    expect(unsafeToReloadNow(page([], null), 6000)).toBe(true);
    back();
    expect(unsafeToReloadNow(page([], null), 6000)).toBe(false);
  });
});

describe("where the rule runs: the phone app, and only where no service worker does the job", () => {
  it("does nothing in a browser", () => {
    const s = setup({ ua: BROWSER_UA });
    expect(s.listening()).toBe(0);
  });

  it("does nothing in a shell that has a service worker: that one reloads itself", () => {
    const s = setup({ serviceWorker: true });
    expect(s.listening()).toBe(0);
  });

  it("does nothing where it cannot remember what it reloaded for", () => {
    const s = setup({ store: null });
    expect(s.listening()).toBe(0);
  });

  it("in the phone app it listens, and stopping it takes every listener away", () => {
    const s = setup();
    expect(s.types()).toEqual(["change", "click", "input", "keydown", "pointerdown", "touchstart", "visibilitychange"]);
    s.stop();
    expect(s.listening()).toBe(0);
  });

  it("every listener is added and taken away in the capture phase, passive: a field that stops its own events still counts", () => {
    const s = setup();
    s.stop();
    expect(s.added.length).toBe(7);
    expect(s.removed.length).toBe(7);
    for (const o of [...s.added, ...s.removed]) expect(o).toEqual({ capture: true, passive: true });
  });

  it("the guard is kept in session storage, so it ends with the app", () => {
    const lib = src("src/lib/release-on-return.ts");
    expect(lib).toContain("window.sessionStorage");
    expect(lib).not.toContain("localStorage");
  });

  it("is mounted once, in the root layout, beside the browser's rule", () => {
    const layout = src("src/app/layout.tsx");
    expect(layout).toContain('import { ReleaseOnReturn } from "@/components/release-on-return";');
    expect(layout.split("<ReleaseOnReturn />").length).toBe(2);
    expect(layout.split("<PwaRegister />").length).toBe(2);
    const comp = src("src/components/release-on-return.tsx");
    expect(comp.startsWith('"use client";')).toBe(true);
    expect(comp).toContain("useEffect(() => installReleaseOnReturn(), []);");
  });

  it("the real check carries no cookie, skips every cache, and has its cap", () => {
    const lib = src("src/lib/release-on-return.ts");
    expect(lib).toContain('fetch(url, { cache: "no-store", credentials: "omit", signal: ctl.signal })');
    expect(lib).toContain("setTimeout(() => ctl.abort(), capMs)");
    expect(lib).toContain("window.location.reload()");
  });
});

describe("the return itself", () => {
  it("a short look away asks nothing", async () => {
    const s = setup();
    expect(await s.awayFor(AWAY_MIN_MS - 1)).toBeNull();
    expect(s.fetchText).not.toHaveBeenCalled();
    expect(s.reload).not.toHaveBeenCalled();
  });

  it("ten seconds away asks once, for the worker file, with the cap", async () => {
    const s = setup({ live: APP_VERSION });
    expect(await s.awayFor(AWAY_MIN_MS)).toBe("same");
    expect(s.fetchText).toHaveBeenCalledTimes(1);
    expect(s.fetchText).toHaveBeenCalledWith("/sw.js", CHECK_CAP_MS);
    expect(s.reload).not.toHaveBeenCalled();
    expect(s.store!.data.size).toBe(0);
  });

  it("another release is live: one reload, and the release it reloaded for is remembered first", async () => {
    const s = setup();
    const order: string[] = [];
    s.reload.mockImplementation(() => order.push(`reload:${s.store!.getItem(RELOADED_FOR_KEY)}`));
    expect(await s.awayFor(AWAY_MIN_MS)).toBe("reload");
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(order).toEqual([`reload:${NEXT}`]);
  });

  it("never twice for one release: the page that came up is still the old build", async () => {
    const s = setup({ store: fakeStore({ [RELOADED_FOR_KEY]: NEXT }) });
    expect(await s.awayFor(60_000)).toBe("looped");
    expect(s.reload).not.toHaveBeenCalled();
    // …and a release after that one is taken.
    s.setLive("cn-v10000");
    expect(await s.awayFor(60_000)).toBe("reload");
    expect(s.store!.getItem(RELOADED_FOR_KEY)).toBe("cn-v10000");
  });

  it("the file could not be read, or was not the worker: nothing happens, and the next return asks again", async () => {
    const s = setup({ live: null });
    expect(await s.awayFor(60_000)).toBe("unknown");
    expect(s.reload).not.toHaveBeenCalled();
    s.fetchText.mockResolvedValueOnce("<!doctype html><title>Sign In</title>");
    expect(await s.awayFor(60_000)).toBe("unknown");
    s.fetchText.mockRejectedValueOnce(new Error("offline"));
    expect(await s.awayFor(60_000)).toBe("unknown");
    expect(s.reload).not.toHaveBeenCalled();
    s.setLive(NEXT);
    expect(await s.awayFor(60_000)).toBe("reload");
  });

  it("a sheet is open: no reload", async () => {
    const s = setup();
    s.classes.add("modal-open");
    expect(await s.awayFor(60_000)).toBe("modal");
    expect(s.reload).not.toHaveBeenCalled();
    s.classes.delete("modal-open");
    expect(await s.awayFor(60_000)).toBe("reload");
  });

  it("a field has focus: no reload", async () => {
    const s = setup();
    s.page.activeElement = { tagName: "TEXTAREA" };
    expect(await s.awayFor(60_000)).toBe("focused");
    expect(s.reload).not.toHaveBeenCalled();
  });

  it("text the person typed is still on the screen: no reload, until it is gone", async () => {
    const s = setup();
    const note = { tagName: "TEXTAREA", value: "meet at the gate", isConnected: true };
    s.fire("input", note);
    expect(await s.awayFor(60_000)).toBe("typed");
    expect(s.reload).not.toHaveBeenCalled();
    // Saved and cleared in place: nothing typed is left.
    note.value = "";
    expect(await s.awayFor(60_000)).toBe("reload");
  });

  it("a typed field that left the screen no longer counts", async () => {
    const s = setup();
    const note = { tagName: "INPUT", type: "text", value: "Larkspur", isConnected: true };
    s.fire("input", note);
    note.isConnected = false;
    expect(await s.awayFor(60_000)).toBe("reload");
  });

  it("a ticked box or a picked option is not typed text", async () => {
    const s = setup();
    s.fire("input", { tagName: "INPUT", type: "checkbox", value: "on", isConnected: true });
    s.fire("input", { tagName: "SELECT", value: "tech", isConnected: true });
    expect(await s.awayFor(60_000)).toBe("reload");
  });

  it("the person touched the screen after coming back, before the answer: no reload", async () => {
    for (const type of ["pointerdown", "touchstart", "keydown"]) {
      const s = setup();
      expect(
        await s.awayFor(60_000, () => {
          s.fire(type);
          s.tick(5); // the answer lands a moment after the touch
        }),
        type,
      ).toBe("touched");
      expect(s.reload, type).not.toHaveBeenCalled();
    }
  });

  it("a touch from before they left does not count", async () => {
    const s = setup();
    s.fire("pointerdown");
    s.tick(5);
    expect(await s.awayFor(60_000)).toBe("reload");
  });

  it("the page went out of sight again before the answer: no reload", async () => {
    const s = setup();
    expect(await s.awayFor(60_000, () => (s.page.visibilityState = "hidden"))).toBe("hidden");
    expect(s.reload).not.toHaveBeenCalled();
  });

  it("a file picker was opened: no question is even asked for fifteen minutes", async () => {
    for (const type of ["click", "change"]) {
      clearReleaseHold();
      const s = setup();
      s.fire(type, { tagName: "INPUT", type: "file" });
      expect(await s.awayFor(60_000), type).toBe("held");
      expect(s.fetchText, type).not.toHaveBeenCalled();
      expect(await s.awayFor(HOLD_MS), type).toBe("reload");
    }
  });

  it("a click anywhere else holds nothing", async () => {
    const s = setup();
    s.fire("click", { tagName: "BUTTON", type: "button" });
    s.fire("change", { tagName: "INPUT", type: "checkbox" });
    s.tick(5);
    expect(await s.awayFor(60_000)).toBe("reload");
  });

  it("a native screen opened while the answer was on its way: no reload", async () => {
    const s = setup();
    expect(await s.awayFor(60_000, () => holdReleaseReload(s.now()))).toBe("held");
    expect(s.fetchText).toHaveBeenCalledTimes(1);
    expect(s.reload).not.toHaveBeenCalled();
  });

  it("a second return while the first is still asking asks nothing more", async () => {
    const s = setup({ live: APP_VERSION });
    let release: (v: string) => void = () => {};
    s.fetchText.mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    const first = s.awayFor(60_000);
    // Out and back again while the first question is open.
    s.page.visibilityState = "hidden";
    s.fire("visibilitychange");
    s.tick(60_000);
    s.page.visibilityState = "visible";
    s.fire("visibilitychange");
    expect(s.fetchText).toHaveBeenCalledTimes(1);
    release(worker(APP_VERSION));
    expect(await first).toBe("same");
    expect(s.verdicts).toEqual(["same"]);
  });

  it("the answer could not be remembered: no reload, because nothing would stop the next one", async () => {
    const store = fakeStore();
    store.setItem = () => {
      throw new Error("full");
    };
    const s = setup({ store });
    expect(await s.awayFor(60_000)).toBe("unguarded");
    expect(s.reload).not.toHaveBeenCalled();
  });

  it("a long return, then a short look away, asks nothing more", async () => {
    const s = setup({ live: APP_VERSION });
    expect(await s.awayFor(60_000)).toBe("same");
    expect(await s.awayFor(2_000)).toBeNull();
    expect(s.fetchText).toHaveBeenCalledTimes(1);
  });

  it("a page that loads out of sight asks on its first return", async () => {
    const s = setup({ hidden: true });
    s.tick(AWAY_MIN_MS);
    s.page.visibilityState = "visible";
    const v = s.nextVerdict();
    s.fire("visibilitychange");
    expect(await v).toBe("reload");
    expect(s.fetchText).toHaveBeenCalledTimes(1);
  });

  it("a screen holds work only this page has when the answer lands: no reload, until it lets go", async () => {
    const s = setup();
    let busy = false;
    holdReloadWhile(() => busy);
    expect(await s.awayFor(60_000, () => (busy = true))).toBe("busy");
    expect(s.reload).not.toHaveBeenCalled();
    busy = false;
    expect(await s.awayFor(60_000)).toBe("reload");
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it("after it is stopped a return does nothing", async () => {
    const s = setup();
    s.stop();
    expect(await s.awayFor(AWAY_MIN_MS - 1)).toBeNull();
    s.page.visibilityState = "hidden";
    s.fire("visibilitychange");
    s.tick(60_000);
    s.page.visibilityState = "visible";
    s.fire("visibilitychange");
    expect(s.fetchText).not.toHaveBeenCalled();
  });
});
