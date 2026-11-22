"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Share, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";

export type SharePayload = { ok: boolean; error?: string; needsSend?: boolean; title?: string; text?: string; url?: string };
export type ShareLoad = (opts?: { sendIt?: boolean; ahead?: boolean }) => Promise<SharePayload>;

/**
 * SHARE A CUSTOMER DOCUMENT — the tiny box-with-arrow at the corner of a document's title.
 *
 * The invoice screen offered Email, Collect Payment, Record Payment and Preview/Print. Nothing
 * for "text this to her" or "AirDrop it", which is how a contractor standing in a driveway
 * actually sends things. So the fallback was the OS share sheet from the PDF preview — and iOS
 * shares the PAGE, not the document: the customer got the app's own marketing description, a
 * link to app.contractornorth.com that shows a login screen, and the PDF. Vendor pitch plus a
 * locked door.
 *
 * The app has to hand the OS a payload instead of letting it scrape one. What goes out is the
 * customer's own token link on the CONTRACTOR'S domain, with the same sentence the SMS sends.
 *
 * `load` is a server action rather than props because the message carries a live balance — a
 * button rendered an hour ago must not text yesterday's number. (Since cn-v1174 it is called
 * AHEAD of the tap, and kept fresh — see the last section.)
 *
 * ── THE SHARE SHEET NEEDS THE TAP THAT ASKED FOR IT (Erik, 2026-09-19) ─────────────────────────
 *
 *     "i had to hit the button twice, again, first time marks it sent and the second one opens
 *      up the mac share window"
 *
 * `navigator.share` may only be called while the browser still holds TRANSIENT USER ACTIVATION
 * from the click. A draft used to spend that activation before it got there: a `confirm()` — which
 * WebKit consumes activation on by design — and then a second server round-trip to mark the
 * invoice sent. By the time the sheet was asked for, the tap had expired, so it threw
 * NotAllowedError. And the catch below read every rejection as "the user closed the sheet" and
 * returned in silence, so the first tap marked his invoice SENT and then appeared to do nothing
 * at all. The second tap needed no confirm and no flip, one await fits inside the window, and it
 * worked — which is exactly why it looked like a button that wants pressing twice.
 *
 * So the question moved into a real Modal, and the answer button became a FRESH tap with exactly
 * one await between it and the sheet. And a rejection that is not AbortError was no longer
 * swallowed — it fell through to the clipboard, with a sentence.
 *
 * ── ONE AWAIT WAS STILL ONE TOO MANY (the owner, 2026-11-21) ───────────────────────────────────
 *
 *     "when I click the share button then messages the first time never opens messages and but
 *      the second time does"
 *
 * On a SENT invoice, in Safari on a Mac. The one await left in both paths was a server action (a
 * sign-in check and three reads), cold on the first tap: it can outlast the tap's activation, warm
 * on the second it fits. Then the share was refused, the clipboard fallback was refused for the
 * same reason, and the only sign was a toast. The owner's answer for the draft, the same day:
 * "can we make it happen at the same moment together as its been doing but in on tap
 * multifunction?" So now NOTHING is awaited between a tap and `navigator.share`:
 *
 *   · THE READ-AHEAD. `load({ ahead: true })` runs when the button mounts, when the page becomes
 *     visible again, after a stamp, and on pointer-enter or focus when the copy in hand is older
 *     than a minute. It stamps nothing. For a document that needs a send (a draft, or a bill
 *     changed since it went out) it returns the ask's sentence AND the words and link the sent
 *     document will carry; a refusal it can know ahead comes back without needsSend. `load` lives
 *     in a ref, because the invoice page hands a new one on every server render and the estimate
 *     editor on every keystroke: keyed on it, the read-ahead would loop. A tap while a refetch is
 *     in flight uses the copy in hand. Until the first copy lands the button is disabled and its
 *     name says Getting the Link; a read-ahead that fails (or is still out after 8 seconds)
 *     re-enables it and the tap takes the old awaited path, which says its own failure.
 *   · THE VERSION (skeptic, cn-v1174). A payment recorded or a save that moved the total, then a tap
 *     within the minute, used to send the customer the OLD figure from the copy in hand. Each page
 *     now hands a `version` (the invoice: status, total, paid, revised and sent; the estimate: status,
 *     total and each save landing); when it moves, the copy is dropped at once and fetched again,
 *     and while a share is pending that waits until it settles.
 *   · READY (sent): the tap calls `navigator.share` (or, with no share sheet, the clipboard) in
 *     the click handler itself. Settled: AbortError is silent; a refusal tries the clipboard;
 *     a copy is claimed only when writeText resolved.
 *   · THE ASK (draft / changed): the tap opens the Modal at once. Its one button, Mark Sent and
 *     Share, calls `navigator.share` FIRST, in the click handler, and fires `load({ sendIt: true })`
 *     beside it: the sheet and the stamp at the same moment. A stamp refused or lost is said AT
 *     ONCE (a toast only: it re-renders the toast list, not this button or the page) with the one
 *     action, Tap Share to try again, because the link will not open until it is marked sent. A
 *     sheet refused after a stamp that landed says it is marked sent and to tap Share once more
 *     (never the clipboard, never a copy that did not happen); AbortError stays silent and the
 *     document stays sent.
 *   · NOTHING MOVES WHILE THE SHEET IS UP. No state change, no Modal close (it pops a history
 *     entry), no refresh while the share promise is pending: the door's state lives outside React
 *     (createShareDoor), the screen is redrawn only after the promise settles, and a read-ahead
 *     that lands meanwhile waits for it. The one thing this side cannot hold back is the stamp's
 *     own revalidation, which the server action carries back and the router applies in place; the
 *     button sits outside every status branch on both pages, so it is never remounted by it.
 *
 * WHY A TINY ICON, when the 60mph rule says an unlabeled glyph is a guess: this one glyph is
 * the OS's own — the box with the up-arrow every phone already teaches — and it was a full
 * labelled 44px button elbowing through the verb row (Erik 2026-09-11: "everywhere, things
 * like share can be this super tiny box with arrow icon… positioned intuitively"). It keeps
 * aria-label + title so VoiceOver and a mouse hover still say "Share", and Button's icon-sm
 * keeps the 44px finger target under the 32px box. It is a PURE share-sheet trigger: Text and
 * Email stay their own doors, the QR modal keeps its own menu.
 */

/** The copy in hand: nothing yet, a read-ahead that failed, or the server's answer and when it came. */
export type SharePrep = { state: "loading" } | { state: "failed" } | { state: "ready"; res: SharePayload; at: number };
export type ShareDoorView = { prep: SharePrep; ask: string | null; busy: boolean };
/** The two platform doors this reads, so a test can hand in a stand-in. */
export type ShareNav = {
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  clipboard?: { writeText?: (text: string) => Promise<void> };
};
type Outcome = "shared" | "aborted" | "refused" | "copied" | "copyFailed";

/** A copy older than this is fetched again when a pointer comes near or the button takes focus. */
export const SHARE_STALE_MS = 60_000;
/** A read-ahead still on the wire after this counts as failed (the tap then takes the awaited path). */
export const SHARE_AHEAD_TIMEOUT_MS = 8_000;

const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";

/**
 * THE DOOR, OUT OF REACT: plain variables, so a tap reads the copy in hand synchronously and a
 * pending share is never disturbed by a render. `render` is called with the view to draw, never while
 * a share is pending (it is held and drawn when the share settles).
 */
export function createShareDoor(deps: {
  load: () => ShareLoad;
  nav: () => ShareNav | undefined;
  say: (message: string, kind: "success" | "error") => void;
  words: (key: string) => string;
  refresh: () => void;
  render: (view: ShareDoorView) => void;
  now: () => number;
}) {
  let prep: SharePrep = { state: "loading" };
  let ask: string | null = null;
  let busy = false; // the old awaited path, after a failed read-ahead
  let sharing = false; // a share promise is pending
  let live = true;
  let seq = 0;
  let version: string | undefined;
  let versionSeen = false;
  let stale = false; // the version moved while a share (or the awaited path) was pending
  let timer: ReturnType<typeof setTimeout> | null = null;

  const view = (): ShareDoorView => ({ prep, ask, busy });
  const emit = () => {
    if (live && !sharing) deps.render(view());
  };
  /** The copy in hand no longer says what the document says: drop it at once, fetch it again. */
  function refetchFresh() {
    stale = false;
    prep = { state: "loading" };
    emit();
    fetchAhead();
  }
  /** After a share or the awaited path settles: a version that moved meanwhile is honoured now. */
  function afterSettle() {
    if (stale) refetchFresh();
    else fetchAhead();
  }
  const call = (opts?: { sendIt?: boolean; ahead?: boolean }): Promise<SharePayload> => {
    try {
      return Promise.resolve(opts ? deps.load()(opts) : deps.load()());
    } catch (e) {
      return Promise.reject(e);
    }
  };

  function fetchAhead() {
    const mine = ++seq;
    if (timer) clearTimeout(timer);
    /* A READ-AHEAD THAT NEVER SETTLES must not leave the button disabled for good: after
       SHARE_AHEAD_TIMEOUT_MS it counts as failed, and the tap takes the awaited path, which says its
       own failure. A copy that lands later is still taken. */
    timer = setTimeout(() => {
      timer = null;
      if (mine !== seq || prep.state !== "loading") return;
      prep = { state: "failed" };
      emit();
    }, SHARE_AHEAD_TIMEOUT_MS);
    const settled = () => {
      if (mine === seq && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    call({ ahead: true }).then(
      (res) => {
        settled();
        if (mine !== seq) return;
        prep = { state: "ready", res, at: deps.now() };
        emit();
      },
      () => {
        settled();
        if (mine !== seq || prep.state === "ready") return; // a copy in hand stays in hand
        prep = { state: "failed" };
        emit();
      },
    );
  }

  /** The clipboard, claimed only when writeText resolved. */
  function copy(res: SharePayload): Promise<Outcome> {
    const clip = deps.nav()?.clipboard;
    if (!clip?.writeText) return Promise.resolve("copyFailed");
    let p: Promise<void>;
    try {
      // The whole message, not just the URL, so a paste into an email or a text reads as a sentence.
      p = clip.writeText(`${res.text} ${res.url}`);
    } catch (e) {
      p = Promise.reject(e);
    }
    return p.then(
      () => "copied" as const,
      () => "copyFailed" as const,
    );
  }

  /** Hand the payload to the OS, or to the clipboard. SYNCHRONOUS up to navigator.share. */
  function handOff(res: SharePayload): Promise<Outcome> {
    const nav = deps.nav();
    if (!nav?.share) return copy(res);
    let p: Promise<void>;
    try {
      p = nav.share({ title: res.title, text: res.text, url: res.url });
    } catch (e) {
      p = Promise.reject(e);
    }
    return p.then(
      () => "shared" as const,
      (e) => (isAbort(e) ? ("aborted" as const) : ("refused" as const)),
    );
  }

  function tell(out: Outcome) {
    if (out === "copied") deps.say(deps.words("qt_copiedPasteIt"), "success");
    else if (out === "copyFailed") deps.say(deps.words("qt_couldntShare"), "error");
  }

  /** TODAY'S PATH, for a read-ahead that failed: one await, then the sheet. It says its own failure. */
  async function slowTap() {
    busy = true;
    emit();
    try {
      const res = await call();
      if (!res.ok && res.needsSend) ask = res.error ?? deps.words("qt_stillADraft");
      else if (!res.ok || !res.url) deps.say(res.error ?? deps.words("qt_couldntBuildLink"), "error");
      else {
        let out = await handOff(res);
        if (out === "refused") out = await copy(res);
        tell(out);
      }
    } catch {
      deps.say(deps.words("qt_couldntShare"), "error");
    } finally {
      busy = false;
      emit();
      afterSettle();
    }
  }

  /** Mark Sent and Share without a copy in hand: the stamp first, then the sheet (the old shape). */
  async function slowConfirm() {
    busy = true;
    emit();
    try {
      const res = await call({ sendIt: true });
      if (!res.ok || !res.url) deps.say(res.error ?? deps.words("qt_couldntBuildLink"), "error");
      else {
        const out = await handOff(res);
        if (out === "refused") deps.say(deps.words("qt_markedSentShareAgain"), "error");
        else tell(out);
      }
      ask = null;
      if (res.ok) deps.refresh(); // the page must show Sent, not yesterday's Draft
    } catch {
      deps.say(deps.words("qt_couldntShare"), "error");
      ask = null;
    } finally {
      busy = false;
      emit();
      afterSettle();
    }
  }

  return {
    view,
    /** Mount (and remount under Strict Mode): live again, and a fresh read-ahead. */
    start() {
      live = true;
      fetchAhead();
    },
    stop() {
      live = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    /**
     * THE DOCUMENT CHANGED (a payment recorded, a save landed, the status moved): the copy in hand
     * says the old balance or total, so it is dropped at once (the button is disabled and says Getting
     * the Link) and fetched again. Never while a share is pending: then right after it settles. The
     * first version handed in is only remembered (the mount's read-ahead is already on the wire).
     */
    setVersion(v: string | undefined) {
      if (!versionSeen) {
        versionSeen = true;
        version = v;
        return;
      }
      if (v === version) return;
      version = v;
      if (sharing || busy) stale = true;
      else refetchFresh();
    },
    /** The page became visible again. */
    fetchAhead() {
      if (!sharing) fetchAhead();
    },
    /** Pointer-enter or focus: fetch again only when the copy in hand is old (or there is none). */
    freshen() {
      if (sharing) return;
      if (prep.state === "failed" || (prep.state === "ready" && deps.now() - prep.at > SHARE_STALE_MS)) fetchAhead();
    },
    /** The icon's tap. */
    tap() {
      if (sharing || busy || prep.state === "loading") return;
      if (prep.state === "failed") {
        void slowTap();
        return;
      }
      const res = prep.res;
      /* A DRAFT ASKS, THEN GOES. The old refusal ("send it first") was a dead end for the exact
         person this button exists for — no email, no number, just a share sheet. Sharing IS
         sending, so one plain-words yes marks it sent and opens the sheet in the same motion. */
      if (res.needsSend) {
        ask = res.error ?? deps.words("qt_stillADraft");
        emit();
        return;
      }
      if (!res.ok || !res.url) {
        // A refusal known ahead (no link, not found): its own sentence, nothing shared.
        deps.say(res.error ?? deps.words("qt_couldntBuildLink"), "error");
        fetchAhead();
        return;
      }
      sharing = true;
      void handOff(res).then(async (out) => {
        sharing = false;
        if (out === "refused") out = await copy(res);
        tell(out);
        if (stale) refetchFresh();
        else emit();
      });
    },
    /** Mark Sent and Share: the sheet and the stamp at the same moment. */
    confirm() {
      if (sharing || busy) return;
      if (!(prep.state === "ready" && prep.res.needsSend && prep.res.url)) {
        void slowConfirm();
        return;
      }
      const res = prep.res;
      sharing = true;
      const shared = handOff(res); // the sheet FIRST: nothing is awaited before it
      const stamped = call({ sendIt: true })
        .then(
          (r) => r,
          () => null,
        )
        .then((st) => {
          // Said at once, sheet or no sheet: the link the customer may be getting will not open yet.
          if (!st?.ok) deps.say(deps.words("qt_shareNotMarkedSent"), "error");
          return st;
        });
      void Promise.all([shared, stamped]).then(([out, st]) => {
        sharing = false;
        ask = null;
        if (st?.ok) {
          // Marked sent: the copy in hand now shares at once on the next tap.
          prep = { state: "ready", res: { ...res, ok: true, needsSend: false, error: undefined }, at: deps.now() };
          if (out === "refused") deps.say(deps.words("qt_markedSentShareAgain"), "error");
          else tell(out);
          deps.refresh(); // the page must show Sent, not yesterday's Draft
        }
        emit();
        afterSettle(); // after a stamp (and after a version that moved while the sheet was up)
      });
    },
    /** Not Yet, or the Modal closed. */
    dismiss() {
      ask = null;
      emit();
    },
  };
}

export function ShareIconButton({
  load,
  version,
  label,
  className,
}: {
  load: ShareLoad;
  /** What the copy fetched ahead depends on (status, money, a save landing), joined into one string. */
  version?: string;
  label?: string;
  className?: string;
}) {
  const toast = useToast();
  const t = translator(useLang());
  const doorLabel = label ?? t("qt_btn_share");
  const router = useRouter();

  // The newest of each, read by the door through refs: none of them may restart the read-ahead.
  const loadRef = useRef(load);
  const toastRef = useRef(toast);
  const tRef = useRef(t);
  const routerRef = useRef(router);
  useEffect(() => {
    loadRef.current = load;
    toastRef.current = toast;
    tRef.current = t;
    routerRef.current = router;
  });

  const [view, setView] = useState<ShareDoorView>({ prep: { state: "loading" }, ask: null, busy: false });
  const [door] = useState(() =>
    createShareDoor({
      load: () => loadRef.current,
      nav: () => (typeof navigator === "undefined" ? undefined : (navigator as ShareNav)),
      say: (message, kind) => toastRef.current(message, kind),
      words: (key) => tRef.current(key),
      refresh: () => routerRef.current.refresh(),
      render: setView,
      now: () => Date.now(),
    }),
  );

  useEffect(() => {
    door.start();
    const onVisible = () => {
      if (document.visibilityState === "visible") door.fetchAhead();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      door.stop();
    };
  }, [door]);

  // The document moved: the copy in hand is dropped and fetched again (never mid-share).
  useEffect(() => {
    door.setVersion(version);
  }, [door, version]);

  const waiting = view.prep.state === "loading";
  const name = waiting ? t("qt_btn_gettingTheLink") : doorLabel;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={name}
        title={name}
        aria-busy={waiting || view.busy || undefined}
        onClick={() => door.tap()}
        onPointerEnter={() => door.freshen()}
        onFocus={() => door.freshen()}
        disabled={waiting || view.busy}
        className={className}
      >
        {view.busy && !view.ask ? <Loader2 className="animate-spin" /> : <Share />}
      </Button>

      <Modal
        open={!!view.ask}
        onClose={() => door.dismiss()}
        title={t("qt_btn_shareThisNow")}
        footer={
          <ModalActions
            onCancel={() => door.dismiss()}
            onSave={() => door.confirm()}
            saveLabel={t("qt_btn_markSentAndShare")}
            saving={view.busy}
            cancelLabel={t("qt_btn_notYet")}
          />
        }
      >
        <p className="text-sm leading-relaxed text-slate-700">{view.ask}</p>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          {t("qt_sharingIsSending")}
        </p>
      </Modal>
    </>
  );
}
