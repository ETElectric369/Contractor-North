import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Tap to Pay bridge against a fake StripeTerminal plugin (2026-09-23 sweep). The fake keeps
 * its listeners the way Capacitor's native side does — a registration per addListener, gone on
 * remove, ALL gone on wipe() (bridge.reset() at the start of any main-frame navigation) — so
 * "the page survived a failed navigation" is one call. Module state is per page load, so every
 * test imports a fresh copy.
 */

const h = vi.hoisted(() => ({
  ctx: {
    ok: true,
    identity: "org-1:user-1",
    canAccept: true,
    canEnable: true,
    livemode: false,
    locationId: "tml_1",
    merchantDisplayName: "ET Electric",
  } as Record<string, unknown>,
  loc: { ok: true, identity: "org-1:user-1", locationId: "tml_1", merchantDisplayName: "ET Electric", livemode: false } as Record<string, unknown>,
  report: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => true }));
vi.mock("@/app/(app)/billing/tap-actions", () => ({
  tapToPayContext: async () => h.ctx,
  ensureTerminalLocation: async () => h.loc,
}));
vi.mock("@/app/report-client-error", () => ({ reportClientError: h.report }));

type Cb = (d: unknown) => void;
type Reader = { serialNumber: string };

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeTerminal() {
  let nextId = 0;
  const native = new Map<string, Map<number, Cb>>();
  const log: string[] = [];
  let connected: Reader | null = null;
  const t = {
    log,
    connect: async (): Promise<void> => {
      connected = { serialNumber: "tap-1" };
    },
    collect: async (): Promise<void> => {},
    fire(event: string, d?: unknown) {
      for (const cb of Array.from(native.get(event)?.values() ?? [])) cb(d);
    },
    count: (event: string) => native.get(event)?.size ?? 0,
    /** Capacitor's bridge.reset(): every native listener gone, the page none the wiser. */
    wipe: () => native.clear(),
    markConnected: () => {
      connected = { serialNumber: "tap-1" };
    },
    plugin: {
      initialize: vi.fn(async () => {}),
      setConnectionToken: vi.fn(async (_o: { token: string }) => {}),
      discoverReaders: vi.fn(async () => ({ readers: [{ serialNumber: "tap-1" }] })),
      cancelDiscoverReaders: vi.fn(async () => {}),
      connectReader: vi.fn(() => t.connect()),
      getConnectedReader: vi.fn(async () => ({ reader: connected })),
      disconnectReader: vi.fn(async () => {
        connected = null;
      }),
      collectPaymentMethod: vi.fn(() => t.collect()),
      cancelCollectPaymentMethod: vi.fn(async () => {}),
      confirmPaymentIntent: vi.fn(async () => {}),
      isTapToPayAccountLinked: vi.fn(async () => ({ isLinked: true })),
      addListener: vi.fn(async (event: string, cb: Cb) => {
        const id = ++nextId;
        if (!native.has(event)) native.set(event, new Map());
        native.get(event)!.set(id, cb);
        log.push(`add ${event}`);
        return {
          remove: async () => {
            native.get(event)?.delete(id);
            log.push(`remove ${event}`);
          },
        };
      }),
    },
  };
  return t;
}

const TOKEN = "terminalRequestedConnectionToken";
const STATUS_EVENTS = [
  "terminalStartInstallingUpdate",
  "terminalReaderSoftwareUpdateProgress",
  "terminalFinishInstallingUpdate",
  "terminalConnectionStatusChange",
  "terminalReaderReconnectStarted",
  "terminalReaderReconnectSucceeded",
  "terminalReaderReconnectFailed",
  "terminalUnexpectedReaderDisconnect",
];
const NINE_O_FIVE_TWO = "Your app's ConnectionTokenProvider did not call the provided completion block within 60 seconds.";
const PI = { clientSecret: "pi_1_secret_x", paymentIntentId: "pi_1", amount: 123 };

/** Let every queued promise and zero-delay timer run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

let t: ReturnType<typeof fakeTerminal>;
async function freshBridge() {
  vi.resetModules();
  return import("./native-tap");
}

beforeEach(() => {
  t = fakeTerminal();
  vi.stubGlobal("window", { Capacitor: { Plugins: { StripeTerminal: t.plugin }, getPlatform: () => "ios" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ secret: "pst_test_1" }) })),
  );
  h.report.mockReset();
  h.report.mockImplementation(async () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the listeners are registered again on every SDK turn", () => {
  it("keeps exactly one native registration per event, removing the old one before adding", async () => {
    const tap = await freshBridge();
    expect(await tap.prepareTapToPay()).toEqual({ ok: true });
    expect(await tap.prepareTapToPay()).toEqual({ ok: true });
    expect(t.count(TOKEN)).toBe(1);
    for (const e of STATUS_EVENTS) expect(t.count(e)).toBe(1);
    // The second turn let go of the first token registration before it made the next one.
    const tokenLines = t.log.filter((l) => l.endsWith(TOKEN));
    expect(tokenLines).toEqual([`add ${TOKEN}`, `remove ${TOKEN}`, `add ${TOKEN}`]);
  });

  it("hears the SDK's token request again after Capacitor wiped the listeners under a living page", async () => {
    const tap = await freshBridge();
    await tap.prepareTapToPay();
    t.wipe();
    // Before this fix the page never registered again: the request went to nobody.
    t.fire(TOKEN);
    await flush();
    expect(t.plugin.setConnectionToken).not.toHaveBeenCalled();
    // The next turn (any warm-up, probe or press) registers again.
    await tap.prepareTapToPay();
    expect(t.count(TOKEN)).toBe(1);
    t.fire(TOKEN);
    await flush();
    // Answered, and answered ONCE: a second answer would land on the next request.
    expect(t.plugin.setConnectionToken).toHaveBeenCalledTimes(1);
    expect(t.plugin.setConnectionToken).toHaveBeenCalledWith({ token: "pst_test_1" });
  });
});

describe("a 60-second token wait this page never heard", () => {
  it("is told as a lost reader with a retry first, not as the internet", async () => {
    const tap = await freshBridge();
    t.connect = async () => {
      throw new Error(NINE_O_FIVE_TWO);
    };
    const r = await tap.collectTapPayment(PI);
    expect(r.ok).toBe(false);
    const error = (r as { error: string }).error;
    expect(error).toBe(
      "This phone lost track of the card reader. Try again, and if the same thing happens, close the North app fully, reopen it, and try once more.",
    );
    expect(error).not.toMatch(/internet/i);
    expect(error).not.toContain("—");
  });

  it("still names the fetch's own reason when this page did fetch and it failed", async () => {
    const tap = await freshBridge();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: "Sign in first." }) })),
    );
    t.connect = async () => {
      // The SDK asked, this page heard it and the fetch said 401; then the SDK timed out anyway.
      t.fire(TOKEN);
      await flush();
      throw new Error(NINE_O_FIVE_TWO);
    };
    const r = await tap.collectTapPayment(PI);
    expect((r as { error: string }).error).toMatch(/Sign in to the North app again on this phone/);
  });
});

describe("the warm-up reports its failures to ops", () => {
  it("tags an unheard token request as a lost listener, once per page load", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const tap = await freshBridge();
    t.connect = async () => {
      throw new Error(NINE_O_FIVE_TWO);
    };
    const r = await tap.prepareTapToPay();
    expect(r.ok).toBe(false);
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(
      "tap-to-pay",
      "warm-up failed: token listener lost",
      expect.objectContaining({ stage: "connecting the reader", sdk_said: NINE_O_FIVE_TWO }),
    );
    // Past the 30 s retry throttle the warm-up runs again and fails the same way: not reported again.
    vi.setSystemTime(Date.now() + 31_000);
    await tap.prepareTapToPay();
    expect(t.plugin.connectReader).toHaveBeenCalledTimes(2);
    expect(h.report).toHaveBeenCalledTimes(1);
  });

  it("tries the report again when the last one never reached the server", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const tap = await freshBridge();
    t.connect = async () => {
      throw new Error("The operation couldn't be completed. (SCPTapToPayReaderErrorDomain error 9.)");
    };
    h.report.mockRejectedValueOnce(new Error("Load failed"));
    await tap.prepareTapToPay();
    await flush();
    vi.setSystemTime(Date.now() + 31_000);
    await tap.prepareTapToPay();
    expect(h.report).toHaveBeenCalledTimes(2);
    expect(h.report).toHaveBeenLastCalledWith("tap-to-pay", "warm-up failed: network", expect.anything());
  });

  it("does not report Apple's not-enabled answer, which is a skip", async () => {
    const tap = await freshBridge();
    t.plugin.isTapToPayAccountLinked.mockResolvedValue({ isLinked: false });
    const r = await tap.prepareTapToPay();
    expect(r).toMatchObject({ ok: false, notEnabled: true });
    expect(h.report).not.toHaveBeenCalled();
  });
});

describe("Cancel while the reader is still connecting", () => {
  it("answers at once, never arms the reader, and says the last attempt is finishing until it has", async () => {
    const tap = await freshBridge();
    const connect = deferred();
    t.connect = () => connect.promise.then(() => t.markConnected());
    const press = tap.collectTapPayment(PI);
    await vi.waitFor(() => expect(t.plugin.connectReader).toHaveBeenCalled());

    await tap.cancelTapPayment();
    expect(await press).toEqual({ ok: false, cancelled: true, error: "Cancelled. Nothing was charged." });

    // The connect is still settling natively: a press now is told so, in words that are true.
    const again = await tap.collectTapPayment(PI);
    expect((again as { error: string }).error).toBe(
      "The last Tap to Pay on iPhone attempt on this phone is still finishing. Wait a moment, then try again. The first connect can take a minute.",
    );

    // The connect succeeds after the Cancel: the reader must NOT be armed for a card.
    connect.resolve();
    await flush();
    expect(t.plugin.collectPaymentMethod).not.toHaveBeenCalled();

    // And the attempt has let go: the next press goes straight to the (connected) reader.
    expect(await tap.collectTapPayment(PI)).toEqual({ ok: true });
    expect(t.plugin.collectPaymentMethod).toHaveBeenCalledTimes(1);
    expect(t.plugin.confirmPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("once the reader is armed, waits for the card's own answer: a card read before the Cancel is never called uncharged", async () => {
    const tap = await freshBridge();
    t.markConnected();
    const collect = deferred();
    t.collect = () => collect.promise;
    let settled = false;
    const press = tap.collectTapPayment(PI).then((r) => {
      settled = true;
      return r;
    });
    await vi.waitFor(() => expect(t.plugin.collectPaymentMethod).toHaveBeenCalled());

    // A payment in Apple's hands is called a payment.
    const again = await tap.collectTapPayment(PI);
    expect((again as { error: string }).error).toBe("A card payment is already in progress on this phone.");

    await tap.cancelTapPayment();
    await flush();
    expect(settled).toBe(false);
    // The card had already been read when the Cancel reached the reader: Stripe confirms it.
    collect.resolve();
    expect(await press).toEqual({ ok: true });
    expect(t.plugin.confirmPaymentIntent).toHaveBeenCalledTimes(1);
  });
});
