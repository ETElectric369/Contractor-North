import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The notification-tap listener against a fake PushNotifications plugin that behaves like
 * Capacitor's native side: listeners gone on wipe() (bridge.reset() when a navigation starts),
 * and a tap nobody is listening for HELD and delivered to the next registration
 * (pushNotificationActionPerformed is sent with retainUntilConsumed).
 */

vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => true }));

type Cb = (d: unknown) => void;
const TAP = "pushNotificationActionPerformed";

function fakePush() {
  let nextId = 0;
  const native = new Map<number, Cb>();
  const held: unknown[] = [];
  return {
    count: () => native.size,
    wipe: () => native.clear(),
    tap(url: string) {
      const data = { notification: { data: { url } } };
      if (native.size === 0) held.push(data);
      else for (const cb of Array.from(native.values())) cb(data);
    },
    plugin: {
      addListener: vi.fn(async (event: string, cb: Cb) => {
        if (event !== TAP) throw new Error(`unexpected ${event}`);
        const id = ++nextId;
        const wasEmpty = native.size === 0;
        native.set(id, cb);
        if (wasEmpty) for (const d of held.splice(0)) cb(d);
        return { remove: async () => void native.delete(id) };
      }),
    },
  };
}

let push: ReturnType<typeof fakePush>;
let doc: EventTarget & { visibilityState: string };

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function comeBack(): void {
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  push = fakePush();
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", { Capacitor: { Plugins: { PushNotifications: push.plugin } } });
  vi.stubGlobal("document", doc);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onNativePushTap", () => {
  it("opens the tapped notification after Capacitor wiped the listener under a living page", async () => {
    const { onNativePushTap } = await import("./native-push");
    const go = vi.fn();
    await onNativePushTap(go);
    push.wipe();
    // The tap that brings the app forward arrives with nobody listening: the plugin holds it.
    push.tap("/jobs/abc");
    expect(go).not.toHaveBeenCalled();
    comeBack();
    await flush();
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith("/jobs/abc");
    expect(push.count()).toBe(1);
  });

  it("keeps one registration across foregrounds, so a tap opens once", async () => {
    const { onNativePushTap } = await import("./native-push");
    const go = vi.fn();
    await onNativePushTap(go);
    comeBack();
    comeBack();
    await flush();
    expect(push.count()).toBe(1);
    push.tap("/invoices/1");
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("stops listening, and stops re-registering, once torn down", async () => {
    const { onNativePushTap } = await import("./native-push");
    const go = vi.fn();
    const off = await onNativePushTap(go);
    off();
    await flush();
    expect(push.count()).toBe(0);
    comeBack();
    await flush();
    expect(push.count()).toBe(0);
  });

  it("still only ever navigates inside the app", async () => {
    const { onNativePushTap } = await import("./native-push");
    const go = vi.fn();
    await onNativePushTap(go);
    push.tap("//evil.example/x");
    push.tap("https://evil.example/x");
    expect(go).not.toHaveBeenCalled();
  });
});
