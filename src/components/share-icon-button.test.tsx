import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { words as qt } from "@/lib/words/quotes";
import { titleCaseIn } from "../../tests/title-case-words";

/**
 * SHARE NEVER LOSES THE TAP (cn-v1174). The owner, on a sent invoice in Safari on a Mac: "when I click
 * the share button then messages the first time never opens messages and but the second time does".
 * A server action sat between the tap and navigator.share; Safari and iOS drop the tap's permission
 * during that wait. The door now fetches ahead, and a tap calls navigator.share with NOTHING awaited.
 *
 * The door's state lives outside React (createShareDoor), so it is driven here with a stand-in
 * navigator and a stand-in load: no DOM needed, and "nothing awaited" is checked as "share was called
 * before tap() returned", in the same tick as the click.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));

const { createShareDoor, ShareIconButton, SHARE_STALE_MS } = await import("./share-icon-button");
type Payload = import("./share-icon-button").SharePayload;
type View = import("./share-icon-button").ShareDoorView;

const SENT: Payload = { ok: true, title: "Invoice INV-900 — Snowbell Electric", text: "Snowbell Electric: Invoice INV-900, balance $100.00. View/pay:", url: "https://example.test/i/tok" };
const DRAFT: Payload = { ok: false, needsSend: true, error: "Sharing marks INV-900 as sent.", title: SENT.title, text: SENT.text, url: SENT.url };

/** A promise the test settles by hand. */
function later<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const named = (name: string) => Object.assign(new Error(name), { name });

function setup(opts: { ahead?: () => Promise<Payload>; stamp?: () => Promise<Payload>; plain?: () => Promise<Payload>; share?: boolean; clip?: "ok" | "fail" | "none" } = {}) {
  const log: string[] = [];
  const calls: (Record<string, unknown> | undefined)[] = [];
  const load = vi.fn((o?: { sendIt?: boolean; ahead?: boolean }) => {
    calls.push(o);
    log.push(o?.ahead ? "load:ahead" : o?.sendIt ? "load:sendIt" : "load:plain");
    if (o?.ahead) return (opts.ahead ?? (async () => SENT))();
    if (o?.sendIt) return (opts.stamp ?? (async () => SENT))();
    return (opts.plain ?? (async () => SENT))();
  });
  const sharing = { next: null as null | ReturnType<typeof later<void>> };
  const share = vi.fn((_d: unknown) => {
    log.push("share");
    sharing.next = later<void>();
    return sharing.next.promise;
  });
  const writeText = vi.fn(async (_s: string) => {
    log.push("writeText");
    if (opts.clip === "fail") throw named("NotAllowedError");
  });
  const nav = {
    ...(opts.share === false ? {} : { share }),
    ...(opts.clip === "none" ? {} : { clipboard: { writeText } }),
  };
  const said: [string, string][] = [];
  const renders: View[] = [];
  const refresh = vi.fn();
  let now = 1_000_000;
  const door = createShareDoor({
    load: () => load,
    nav: () => nav,
    say: (m, k) => said.push([m, k]),
    words: (k) => k,
    refresh,
    render: (v) => renders.push(v),
    now: () => now,
  });
  return { door, load, calls, share, sharing, writeText, said, renders, refresh, log, advance: (ms: number) => (now += ms) };
}

describe("a document that can be shared as it stands: the tap goes straight to the sheet", () => {
  it("fetches ahead on mount, then the tap calls navigator.share in the same tick, with nothing awaited", async () => {
    const s = setup();
    s.door.start();
    expect(s.calls).toEqual([{ ahead: true }]);
    await tick();
    expect(s.door.view().prep.state).toBe("ready");
    s.door.tap();
    // SAME TICK: no await ran between the tap and the sheet.
    expect(s.share).toHaveBeenCalledTimes(1);
    expect(s.share).toHaveBeenCalledWith({ title: SENT.title, text: SENT.text, url: SENT.url });
    expect(s.load).toHaveBeenCalledTimes(1); // the tap fetched nothing
    // Nothing is redrawn while the sheet is up.
    const drawn = s.renders.length;
    s.door.tap(); // a second tap while the sheet is up does nothing
    expect(s.share).toHaveBeenCalledTimes(1);
    s.sharing.next!.resolve();
    await tick();
    expect(s.said).toEqual([]);
    expect(s.renders.length).toBe(drawn + 1); // drawn once, after it settled
  });

  it("closing the sheet without picking (AbortError) says nothing", async () => {
    const s = setup();
    s.door.start();
    await tick();
    s.door.tap();
    s.sharing.next!.reject(named("AbortError"));
    await tick();
    expect(s.said).toEqual([]);
    expect(s.writeText).not.toHaveBeenCalled();
  });

  it("with no share sheet the clipboard is called in the tap; a copy is claimed only when writeText resolved", async () => {
    const ok = setup({ share: false });
    ok.door.start();
    await tick();
    ok.door.tap();
    expect(ok.writeText).toHaveBeenCalledWith(`${SENT.text} ${SENT.url}`); // same tick
    await tick();
    expect(ok.said).toEqual([["qt_copiedPasteIt", "success"]]);

    const refused = setup({ share: false, clip: "fail" });
    refused.door.start();
    await tick();
    refused.door.tap();
    await tick();
    expect(refused.said).toEqual([["qt_couldntShare", "error"]]);

    const none = setup({ share: false, clip: "none" });
    none.door.start();
    await tick();
    none.door.tap();
    await tick();
    expect(none.said).toEqual([["qt_couldntShare", "error"]]);
  });

  it("a refusal the server knew ahead is said at the tap, and nothing is shared", async () => {
    const s = setup({ ahead: async () => ({ ok: false, error: "This invoice has no customer link yet." }) });
    s.door.start();
    await tick();
    s.door.tap();
    expect(s.share).not.toHaveBeenCalled();
    expect(s.said).toEqual([["This invoice has no customer link yet.", "error"]]);
  });
});

describe("the read-ahead: never a loop, never a lost tap", () => {
  it("is disabled until the first copy lands; a failed read-ahead re-enables it and the tap takes the old awaited path", async () => {
    const s = setup({ ahead: async () => Promise.reject(new Error("offline")) });
    s.door.start();
    expect(s.door.view().prep.state).toBe("loading");
    s.door.tap(); // the button is disabled; a tap that gets through anyway does nothing
    expect(s.load).toHaveBeenCalledTimes(1);
    await tick();
    expect(s.door.view().prep.state).toBe("failed");
    s.door.tap();
    expect(s.calls[1]).toBeUndefined(); // today's call: load() with nothing
    expect(s.door.view().busy).toBe(true);
    await tick();
    expect(s.share).toHaveBeenCalledTimes(1); // shared after the one await, as before
    s.sharing.next!.resolve();
    await tick();
    expect(s.said).toEqual([]);
  });

  it("the old path still says its own failure, and claims no copy it did not make", async () => {
    const s = setup({ ahead: async () => Promise.reject(new Error("offline")), clip: "fail" });
    s.door.start();
    await tick();
    s.door.tap();
    await tick();
    s.sharing.next!.reject(named("NotAllowedError"));
    await tick();
    await tick();
    expect(s.said).toEqual([["qt_couldntShare", "error"]]);
  });

  it("refetches only when the copy is old, on visibility, and after a stamp; a tap mid-refetch uses the copy in hand", async () => {
    const s = setup();
    s.door.start();
    await tick();
    s.door.freshen(); // pointer-enter within the minute: nothing
    expect(s.load).toHaveBeenCalledTimes(1);
    s.advance(SHARE_STALE_MS + 1);
    s.door.freshen();
    expect(s.load).toHaveBeenCalledTimes(2);
    s.door.tap(); // the refetch is still on the wire: the copy in hand shares at once
    expect(s.share).toHaveBeenCalledTimes(1);
    s.door.fetchAhead(); // the page became visible again, but a share is pending: wait
    expect(s.load).toHaveBeenCalledTimes(2);
    s.sharing.next!.resolve();
    await tick();
    s.door.fetchAhead();
    expect(s.load).toHaveBeenCalledTimes(3);
  });

  it("the component keeps load in a ref and fetches on mount and visibility only, never on a new load prop", () => {
    const src = readFileSync(join(process.cwd(), "src/components/share-icon-button.tsx"), "utf8");
    expect(src).toContain("const loadRef = useRef(load);");
    expect(src).toContain("load: () => loadRef.current,");
    expect(src).toMatch(/door\.start\(\);[\s\S]*visibilitychange[\s\S]*\}, \[door\]\);/);
    expect(src).toContain("onClick={() => door.tap()}");
    expect(src).toContain("onSave={() => door.confirm()}");
    // The button is one element whatever the status: no key, no branch around it.
    const button = src.slice(src.indexOf("<Button"), src.indexOf("</Button>"));
    expect(button).not.toContain("key=");
  });
});

describe("the version: the copy in hand never outlives the money it says (skeptic, cn-v1174)", () => {
  const PAID: Payload = { ...SENT, text: "Snowbell Electric: Invoice INV-900, balance $40.00. View/pay:" };

  it("a version change drops the old copy at once (nothing can share it); after the refetch the tap shares the NEW one with nothing awaited", async () => {
    const next = later<Payload>();
    let reads = 0;
    const s = setup({ ahead: () => (reads++ === 0 ? Promise.resolve(SENT) : next.promise) });
    s.door.setVersion("sent|100|0");
    s.door.start();
    await tick();
    expect(s.door.view().prep.state).toBe("ready");
    s.door.setVersion("sent|100|0"); // the same version: nothing fetched
    expect(s.load).toHaveBeenCalledTimes(1);
    s.door.setVersion("partial|100|60"); // a payment was recorded
    expect(s.door.view().prep.state).toBe("loading"); // the button is disabled: Getting the Link
    expect(s.load).toHaveBeenCalledTimes(2);
    s.door.tap();
    expect(s.share).not.toHaveBeenCalled(); // the old balance can no longer be shared
    next.resolve(PAID);
    await tick();
    s.door.tap();
    expect(s.share).toHaveBeenCalledTimes(1); // same tick
    expect(s.share).toHaveBeenCalledWith({ title: PAID.title, text: PAID.text, url: PAID.url });
    expect(s.load).toHaveBeenCalledTimes(2);
  });

  it("a refetched copy that says it needs a send opens the ask", async () => {
    let reads = 0;
    const s = setup({ ahead: async () => (reads++ === 0 ? SENT : DRAFT) }); // edited since it went out
    s.door.setVersion("sent|100|0|");
    s.door.start();
    await tick();
    s.door.setVersion("sent|140|0|2026-11-21T10:00");
    await tick();
    s.door.tap();
    expect(s.share).not.toHaveBeenCalled();
    expect(s.door.view().ask).toBe(DRAFT.error);
  });

  it("never while a share is pending: the version waits, and is honoured right after the share settles", async () => {
    const s = setup();
    s.door.setVersion("v1");
    s.door.start();
    await tick();
    s.door.tap();
    const drawn = s.renders.length;
    s.door.setVersion("v2");
    expect(s.load).toHaveBeenCalledTimes(1); // nothing fetched, nothing drawn mid-share
    expect(s.renders.length).toBe(drawn);
    s.sharing.next!.resolve();
    await tick();
    expect(s.load).toHaveBeenCalledTimes(2);
    expect(s.calls.at(-1)).toEqual({ ahead: true });
  });

  it("the two pages hand a version: the invoice its status, money and send stamps; the estimate its status, total and saves", () => {
    const inv = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/page.tsx"), "utf8");
    expect(inv).toContain('version={[inv.status, inv.total, inv.amount_paid, revisedAt ?? "", sentAt ?? ""].join("|")}');
    const est = readFileSync(join(process.cwd(), "src/app/(app)/quotes/estimate-editor.tsx"), "utf8");
    expect(est).toContain('version={[status, total.toFixed(2), busy ? "saving" : "saved"].join("|")}');
    const src = readFileSync(join(process.cwd(), "src/components/share-icon-button.tsx"), "utf8");
    expect(src).toMatch(/door\.setVersion\(version\);\s*\}, \[door, version\]\);/);
  });
});

describe("a read-ahead that never settles (skeptic, cn-v1174)", () => {
  it("counts as failed after 8 seconds, so the tap takes the awaited path that says its own failure", async () => {
    vi.useFakeTimers();
    try {
      const { SHARE_AHEAD_TIMEOUT_MS } = await import("./share-icon-button");
      expect(SHARE_AHEAD_TIMEOUT_MS).toBe(8_000);
      const s = setup({ ahead: () => new Promise<Payload>(() => {}), plain: async () => Promise.reject(new Error("offline")) });
      s.door.start();
      vi.advanceTimersByTime(7_999);
      expect(s.door.view().prep.state).toBe("loading");
      vi.advanceTimersByTime(1);
      expect(s.door.view().prep.state).toBe("failed"); // the button is enabled again
      s.door.tap();
      expect(s.calls[1]).toBeUndefined(); // the awaited path: load() with nothing
      await vi.runOnlyPendingTimersAsync();
      expect(s.said).toEqual([["qt_couldntShare", "error"]]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a draft (or a bill changed since it went out): ONE tap does both at the same moment", () => {
  it("the tap opens the ask at once; Mark Sent and Share opens the sheet FIRST and stamps beside it", async () => {
    const stamp = later<Payload>();
    const s = setup({ ahead: async () => DRAFT, stamp: () => stamp.promise });
    s.door.start();
    await tick();
    s.door.tap();
    expect(s.door.view().ask).toBe(DRAFT.error);
    expect(s.share).not.toHaveBeenCalled();
    const drawn = s.renders.length;
    s.door.confirm();
    // Same tick: the sheet, then the stamp. Nothing awaited before the sheet.
    expect(s.log.slice(-2)).toEqual(["share", "load:sendIt"]);
    expect(s.share).toHaveBeenCalledWith({ title: DRAFT.title, text: DRAFT.text, url: DRAFT.url });
    stamp.resolve(SENT);
    await tick();
    // The stamp landed, the sheet is still up: nothing redrawn, the ask not closed, no refresh.
    expect(s.renders.length).toBe(drawn);
    expect(s.door.view().ask).toBe(DRAFT.error);
    expect(s.refresh).not.toHaveBeenCalled();
    s.sharing.next!.resolve();
    await tick();
    expect(s.door.view().ask).toBeNull();
    expect(s.refresh).toHaveBeenCalledTimes(1);
    expect(s.said).toEqual([]);
    expect(s.calls.at(-1)).toEqual({ ahead: true }); // fetched again after the stamp
  });

  it("a stamp refused AFTER the sheet opened is said at once, with the one action, and never twice", async () => {
    const stamp = later<Payload>();
    const s = setup({ ahead: async () => DRAFT, stamp: () => stamp.promise });
    s.door.start();
    await tick();
    s.door.tap();
    const drawn = s.renders.length;
    s.door.confirm();
    stamp.resolve({ ok: false, error: "Couldn't mark this invoice as sent." });
    await tick();
    expect(s.said).toEqual([["qt_shareNotMarkedSent", "error"]]); // the sheet is still up
    expect(s.renders.length).toBe(drawn);
    s.sharing.next!.resolve();
    await tick();
    expect(s.said).toEqual([["qt_shareNotMarkedSent", "error"]]);
    expect(s.refresh).not.toHaveBeenCalled();
    expect(s.door.view().prep.state === "ready" && s.door.view().prep).toMatchObject({ res: { needsSend: true } });
  });

  it("a stamp that is lost (the call threw) is said the same way", async () => {
    const s = setup({ ahead: async () => DRAFT, stamp: async () => Promise.reject(new Error("network")) });
    s.door.start();
    await tick();
    s.door.tap();
    s.door.confirm();
    await tick();
    expect(s.said).toEqual([["qt_shareNotMarkedSent", "error"]]);
  });

  it("a sheet refused after the stamp says it is marked sent and to tap Share once more; never the clipboard; the next tap is the synchronous one", async () => {
    let reads = 0;
    const s = setup({ ahead: async () => (reads++ === 0 ? DRAFT : SENT) }); // the server says Sent once stamped
    s.door.start();
    await tick();
    s.door.tap();
    s.door.confirm();
    s.sharing.next!.reject(named("NotAllowedError"));
    await tick();
    await tick();
    expect(s.said).toEqual([["qt_markedSentShareAgain", "error"]]);
    expect(s.writeText).not.toHaveBeenCalled();
    expect(s.door.view().ask).toBeNull();
    // The copy in hand is now a sent one: the next tap shares in the same tick.
    s.door.tap();
    expect(s.share).toHaveBeenCalledTimes(2);
  });

  it("AbortError after the stamp says nothing, and the document stays marked sent", async () => {
    const s = setup({ ahead: async () => DRAFT });
    s.door.start();
    await tick();
    s.door.tap();
    s.door.confirm();
    s.sharing.next!.reject(named("AbortError"));
    await tick();
    await tick();
    expect(s.said).toEqual([]);
    expect(s.refresh).toHaveBeenCalledTimes(1);
  });

  it("without a copy in hand, Mark Sent and Share takes the old path: the stamp, then the sheet; a refusal after it never claims a copy", async () => {
    const s = setup({ ahead: async () => Promise.reject(new Error("offline")), plain: async () => ({ ok: false, needsSend: true, error: "Sharing marks INV-900 as sent." }) });
    s.door.start();
    await tick();
    s.door.tap();
    await tick();
    expect(s.door.view().ask).toBe("Sharing marks INV-900 as sent.");
    s.door.confirm();
    expect(s.share).not.toHaveBeenCalled();
    await tick();
    expect(s.log.filter((l) => l !== "load:ahead")).toEqual(["load:plain", "load:sendIt", "share"]);
    s.sharing.next!.reject(named("NotAllowedError"));
    await tick();
    await tick();
    expect(s.said).toEqual([["qt_markedSentShareAgain", "error"]]);
    expect(s.writeText).not.toHaveBeenCalled();
  });
});

describe("the words", () => {
  it("the button says it is getting the link until the read-ahead lands, disabled, in both languages", async () => {
    const { LangProvider } = await import("@/components/lang-provider");
    const draw = (lang: "en" | "es") =>
      renderToStaticMarkup(createElement(LangProvider, { lang } as never, createElement(ShareIconButton, { load: async () => SENT })));
    expect(draw("en")).toContain('aria-label="Getting the Link…"');
    expect(draw("en")).toContain("disabled");
    expect(draw("es")).toContain('aria-label="Obteniendo el Enlace…"');
  });

  it("three new keys, both languages, the clickable one in Title Case", () => {
    expect(qt.en.qt_btn_gettingTheLink).toBe("Getting the Link…");
    expect(qt.es.qt_btn_gettingTheLink).toBe("Obteniendo el Enlace…");
    expect(titleCaseIn(qt.en.qt_btn_gettingTheLink.replace("…", ""), "en")).toBe(true);
    expect(titleCaseIn(qt.es.qt_btn_gettingTheLink.replace("…", ""), "es")).toBe(true);
    expect(qt.en.qt_shareNotMarkedSent).toBe("It isn't marked sent, so the link won't open for them yet. Tap Share to try again.");
    expect(qt.es.qt_shareNotMarkedSent).toBe("No quedó marcado como enviado, así que el enlace todavía no se abre. Toca Compartir para intentarlo de nuevo.");
    expect(qt.en.qt_markedSentShareAgain).toBe("Marked sent, but the share sheet didn't open. Tap Share once more.");
    expect(qt.es.qt_markedSentShareAgain).toBe("Quedó marcado como enviado, pero la hoja para compartir no se abrió. Toca Compartir una vez más.");
  });
});
