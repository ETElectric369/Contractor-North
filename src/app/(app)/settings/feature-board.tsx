"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented";
import { useToast } from "@/components/toast";
import { FEATURES, FEATURE_BY_KEY, featureChildren, featureOn, type FeatureDef, type FeatureKey, type FeatureMap } from "@/lib/features";
import { TRADE_PACK_OPTIONS, tradePackage, type TradeKey } from "@/lib/trade-package";
import { codesOfferWords, sheetOfferWords, switchesOfferWords, type SwitchMove, type TradeOffers } from "@/lib/trade-offers";
import { applyTradeCodes, applyTradeSwitches, setEstimatingMode, setFeature, setOrgTrade, startTradeSheet, type SetOrgTradeResult } from "./features-actions";

/**
 * SETTINGS > FEATURES: THE SWITCH BOARD (0352). One row per switch, sub-switches nested under their
 * parent. A Title Case name, one plain line, and for the owner a 44px switch; everyone else reads
 * the state and "Ask The Owner" (only the owner can move a switch, and a switch that can't save for
 * this person must not render as one).
 *
 * A switch hides doors only, and the page says so where it matters:
 *   - off with saved records: "Off · 3 saved" (nothing was deleted, and it all opens by link);
 *   - turning one off asks first, in one line naming what stops (the website names its address,
 *     Recurring Billing counts its repeat invoices, Customer Portal says its links stop opening,
 *     the rest hide their buttons);
 *   - a sub-switch whose parent is off reads Off to everyone but the owner (featureOn); the owner's
 *     switch keeps the stored value, so turning the parent back on brings it back as it was;
 *   - every flip comes back with Undo (the NOT-annoying law: no save game, an undo trail).
 *
 * ABOVE THE SWITCHES, "YOUR TRADE & PRICING" (cn-v1135): the trade the company picked at sign-up
 * and the way it prices, the owner's two doors that did not exist before (TradeCard below).
 */
export type FeatureBoardProps = {
  /** The company's switches as stored and normalized (getOrgSettings(...).features). */
  features: FeatureMap;
  isOwner: boolean;
  /** Saved records per feature (lib/feature-counts); a feature missing here has no count. */
  counts: Partial<Record<FeatureKey, number>>;
  /** The public site's address ("etelectricity.com"), or null when the company has none. */
  siteName: string | null;
  /** No one but the owner on the team yet: Crew & Payroll stays quiet until someone joins. */
  crewQuiet: boolean;
  /** false until 0352 is on the database: the switches can't save yet, so they don't render as switches. */
  ready: boolean;
  /** The company's trade (lib/org-trade orgTrade) and its menu row, "Not Listed" when there is no key. */
  trade: { key: TradeKey | ""; menu: string };
  /** How the company prices (settings.estimating_mode). */
  estimatingMode: EstimatingMode;
};

export type EstimatingMode = "research" | "catalog";

/** The one line under each way of pricing: what the estimator actually does in that mode. */
export const MODE_LINES: Record<EstimatingMode, string> = {
  research: "Your price book first; current prices researched for what it lacks; sizes calculated.",
  catalog: "Only your own price list and kits; never a web price; the public configurator for a deck builder.",
};

export function stopsLine(key: FeatureKey, siteName: string | null, repeatInvoices: number | undefined): string {
  if (key === "website" && siteName) return `Unpublishes ${siteName}.`;
  // The engine skips only repeat INVOICES while this is off (recurring-engine skipDueRun); repeat
  // jobs and expenses keep running. An unknown count still names what stops, never "nothing".
  if (key === "recurring_billing") {
    const stops =
      repeatInvoices === undefined
        ? "Stops repeat invoices."
        : repeatInvoices > 0
          ? `Stops ${repeatInvoices} repeat invoice${repeatInvoices === 1 ? "" : "s"}.`
          : "Hides its buttons.";
    return `${stops} Repeat jobs and expenses keep running.`;
  }
  // Off shuts every portal link (lib/portal/access, before any sign-in) and drops the portal link
  // from invoice emails (lib/invoice-email). Invoice and pay links never read the switch.
  if (key === "customer_portal") return "Your customers' portal links stop opening. Invoice and pay links still work.";
  return "Hides its buttons. Nothing is deleted.";
}

export function FeatureBoard({ features, isOwner, counts, siteName, crewQuiet, ready, trade, estimatingMode }: FeatureBoardProps) {
  const router = useRouter();
  const toast = useToast();
  const [on, setOn] = useState<FeatureMap>(features);
  const [asking, setAsking] = useState<FeatureKey | null>(null);
  const [pending, start] = useTransition();

  function flip(key: FeatureKey, next: boolean, undo = true) {
    setOn((m) => ({ ...m, [key]: next }));
    start(async () => {
      const res = await setFeature(key, next);
      setAsking(null);
      if (!res.ok) {
        setOn((m) => ({ ...m, [key]: !next }));
        toast(res.error, "error");
        return;
      }
      const label = FEATURE_BY_KEY[key].label;
      toast(
        `${label} is ${next ? "on" : "off"}.`,
        "success",
        undo ? { label: "Undo", onClick: () => flip(key, res.previous, false) } : undefined,
      );
      router.refresh();
    });
  }

  const tops = FEATURES.filter((f) => !f.parent);
  const asked = asking ? FEATURE_BY_KEY[asking] : null;

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Turn off what your company doesn&apos;t use. A switch only hides buttons: nothing is deleted, no number changes,
        and anything saved still opens from a link.
      </p>
      {!ready && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Features need an update from North before they can be changed. Everything is on until then.
        </p>
      )}
      {ready && !isOwner && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">Only the owner can turn features on or off.</p>
      )}
      <TradeCard
        trade={trade}
        estimatingMode={estimatingMode}
        canMove={isOwner && ready}
        askOwner={!isOwner}
        onSwitchesMoved={(moved) => setOn((m) => ({ ...m, ...Object.fromEntries(moved.map((s) => [s.key, s.on])) }))}
      />
      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
        {tops.map((f) => (
          <div key={f.key}>
            <Row
              f={f}
              on={on}
              canMove={isOwner && ready}
              askOwner={!isOwner}
              count={counts[f.key]}
              quietLine={f.key === "crew_payroll" && crewQuiet && on.crew_payroll ? "Quiet until someone joins your team." : null}
              pending={pending}
              onFlip={(next) => (next ? flip(f.key, true) : setAsking(f.key))}
            />
            {featureChildren(f.key).map((c) => (
              <Row
                key={c.key}
                f={c}
                on={on}
                canMove={isOwner && ready}
                askOwner={!isOwner}
                count={counts[c.key]}
                quietLine={on[f.key] ? null : `Off while ${f.label} is off.`}
                pending={pending}
                onFlip={(next) => (next ? flip(c.key, true) : setAsking(c.key))}
                nested
              />
            ))}
          </div>
        ))}
      </div>

      <Modal
        open={!!asked}
        onClose={() => setAsking(null)}
        title={asked ? `Turn Off ${asked.label}?` : ""}
        size="sm"
        historyClose={false}
        footer={
          <ModalActions
            onCancel={() => setAsking(null)}
            onSave={() => asked && flip(asked.key, false)}
            saveLabel="Turn Off"
            cancelLabel="Keep On"
            saving={pending}
          />
        }
      >
        <p className="text-sm text-slate-700">{asked ? stopsLine(asked.key, siteName, counts.recurring_billing) : ""}</p>
      </Modal>
    </div>
  );
}

function Row({
  f,
  on,
  canMove,
  askOwner,
  count,
  quietLine,
  pending,
  onFlip,
  nested = false,
}: {
  f: FeatureDef;
  on: FeatureMap;
  /** The owner, with the switches on the database: a real switch. Anyone else reads the state. */
  canMove: boolean;
  /** Not the owner: an off row says who can turn it on. */
  askOwner: boolean;
  count: number | undefined;
  quietLine: string | null;
  pending: boolean;
  onFlip: (next: boolean) => void;
  nested?: boolean;
}) {
  // The owner moves the STORED value; everyone else reads what the app does (a sub-switch is off
  // while its parent is off, whatever is stored).
  const isOn = canMove ? on[f.key] : featureOn(on, f.key);
  const saved = !isOn && count ? ` · ${count} saved` : "";
  return (
    <div className={`flex min-h-11 items-center gap-3 px-4 py-3 ${nested ? "pl-10 bg-slate-50/60" : ""}`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-900">{f.label}</div>
        <div className="text-xs text-slate-500">{f.line}</div>
        {quietLine && <div className="mt-0.5 text-xs text-slate-400">{quietLine}</div>}
      </div>
      {canMove ? (
        <div className="flex shrink-0 items-center gap-1">
          {saved && <span className="text-xs text-slate-500">{`Off${saved}`}</span>}
          <button
            type="button"
            role="switch"
            aria-checked={isOn}
            aria-label={`${isOn ? "Turn Off" : "Turn On"} ${f.label}`}
            disabled={pending}
            onClick={() => onFlip(!isOn)}
            className="flex h-11 min-w-11 items-center justify-center rounded-lg px-2 hover:bg-slate-100 disabled:opacity-60"
          >
            <span className={`relative block h-6 w-11 rounded-full transition-colors ${isOn ? "bg-brand" : "bg-slate-300"}`}>
              <span
                className={`absolute top-0.5 block h-5 w-5 rounded-full bg-white shadow transition-all ${isOn ? "left-[22px]" : "left-0.5"}`}
              />
            </span>
          </button>
        </div>
      ) : (
        <span className="shrink-0 text-right text-xs text-slate-500">
          {isOn ? "On" : `Off${saved}${askOwner ? " · Ask The Owner" : ""}`}
        </span>
      )}
    </div>
  );
}

// ── YOUR TRADE & PRICING (cn-v1135) ─────────────────────────────────────────────────────────────

type OfferDoor = "codes" | "switches" | "sheet";
const MODE_ITEMS = [
  { id: "research", label: "Research" },
  { id: "catalog", label: "Catalog" },
];

/** A server action that threw (the network, a hung request): said where the button was, never swallowed. */
export const UNREACHABLE = "Couldn't reach the server — try again.";

/**
 * THE TRUTH ABOUT THE KEY (B1): what follows it the moment it is saved, and what does not. Every reader
 * of settings.trade flips on Save — Nort's words (lib/trade-nort), the Tools page's packages, a new
 * permit's default, which inspection starter is offered — while the company's own codes, switches,
 * sheet and playbook stay as they are and are OFFERED, one button each. Said on the card and in the
 * Change My Trade sheet, the same sentence.
 */
export const TRADE_FOLLOWS_LINE =
  "Your trade sets Nort's words, the Tools page, the permit default and which inspection starter is offered. Your codes, switches, sheets and playbook stay as they are; below, each has its own button.";

/**
 * ONE MORE LINE IN THE SHEET when the Save would turn the public instant-estimate page off: it is on
 * only for a deck company pricing from its catalog (lib/org-trade deckConfiguratorOn — the page, the
 * site's estimate button, the sitemap entry and the site chat's deck tool all read that one gate), so
 * moving such a company to any other trade turns the four off at once. Null when the company is not
 * one, or when the pick is still a deck trade (nothing would turn off).
 */
export function deckPageOffLine(current: TradeKey | "", mode: EstimatingMode, picked: string): string | null {
  if (current !== "deck" || mode !== "catalog" || picked === "deck") return null;
  return "Your public instant-estimate page turns off until a deck trade is set again.";
}

/** What the card says after the trade landed: what follows it now, and the words that were cleared, if any. */
export function tradeSavedWords(res: Pick<Extract<SetOrgTradeResult, { ok: true }>, "trade" | "clearedWords">, menu: string): string {
  const first = res.trade
    ? `Your trade is ${menu}. Nort's words, the Tools page and the permit default follow it now; the offers below are each your call.`
    : "Your trade is not listed. The app stays neutral.";
  return res.clearedWords ? `${first} Your words "${res.clearedWords}" were cleared.` : first;
}

/**
 * EVERY SERVER CALL THE CARD MAKES GOES THROUGH HERE (S1): a thrown call (the network, a hung request,
 * a server error Next turns into a throw) becomes a refusal in words instead of a rejected promise
 * nobody awaits, and `done` runs whatever happened — the card hands it setBusy(null), so no button can
 * stay disabled forever on a throw. The refusals an action answers with pass through untouched.
 */
export async function cardCall<T extends { ok: boolean }>(call: () => Promise<T>, done: () => void): Promise<T | { ok: false; error: string }> {
  try {
    return await call();
  } catch {
    return { ok: false, error: UNREACHABLE };
  } finally {
    done();
  }
}

/**
 * THE TOP CARD: the trade the company does and the way it prices. Before cn-v1135 no screen could
 * change either after sign-up (settings/page.tsx promised it could). Two rows:
 *
 *   Your Trade     the menu row the key stands for; the owner's Change My Trade opens a sheet with
 *                  the ten trades and Other / Not Listed. After the key lands (0398 set_org_trade:
 *                  the key, and the company's own trade words when they named another trade — said
 *                  back), every reader of the key follows at once (TRADE_FOLLOWS_LINE), and the new
 *                  trade's package is OFFERED as three rows, each with its own button saying what it
 *                  would do and how much is new — codes under either spelling, the switches that
 *                  differ, the inspection sheet when there is none — and each says what it did, or
 *                  why it did not, in place. A failed offers read is said in their place.
 *   How You Price  Research or Catalog, one line each saying what the estimator does in that mode;
 *                  the owner moves it, everyone else reads it with Ask The Owner, as on the board.
 *                  A refused or thrown move goes back to the value the server last confirmed.
 */
function TradeCard({
  trade,
  estimatingMode,
  canMove,
  askOwner,
  onSwitchesMoved,
}: {
  trade: { key: TradeKey | ""; menu: string };
  estimatingMode: EstimatingMode;
  /** The owner, with the switches on the database. */
  canMove: boolean;
  /** Not the owner: each row says who can change it. */
  askOwner: boolean;
  /** The board keeps its own copy of the switches; a switch the package moved is told here. */
  onSwitchesMoved: (moved: SwitchMove[]) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [key, setKey] = useState<TradeKey | "">(trade.key);
  const [menu, setMenu] = useState(trade.menu);
  const [changing, setChanging] = useState(false);
  const [picked, setPicked] = useState<string>(trade.key || "other");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [offers, setOffers] = useState<TradeOffers | null>(null);
  /** The offers read failed after the trade landed: said where the buttons would be. */
  const [offersError, setOffersError] = useState<string | null>(null);
  /** What each offer's door said after it ran; a door that has spoken shows its words, not its button. */
  const [said, setSaid] = useState<Partial<Record<OfferDoor, string>>>({});
  /** A door's refusal, or a thrown call, said on its own row under its button. */
  const [doorError, setDoorError] = useState<Partial<Record<OfferDoor, string>>>({});
  const [busy, setBusy] = useState<"trade" | "mode" | OfferDoor | null>(null);
  const [mode, setMode] = useState<EstimatingMode>(estimatingMode);

  function openChange() {
    setPicked(key || "other");
    setRefusal(null);
    setChanging(true);
  }

  function saveTrade() {
    setBusy("trade");
    setRefusal(null);
    void (async () => {
      const res = await cardCall(() => setOrgTrade(picked), () => setBusy(null));
      if (!res.ok) {
        setRefusal(res.error);
        return;
      }
      const nextMenu = tradePackage(res.trade)?.menu ?? "Not Listed";
      setKey(res.trade);
      setMenu(nextMenu);
      setOffers(res.offers);
      setOffersError(res.offersError ?? null);
      setSaid({});
      setDoorError({});
      setChanging(false);
      toast(tradeSavedWords(res, nextMenu), "success");
      router.refresh();
    })();
  }

  function runDoor(door: OfferDoor) {
    if (!offers) return;
    const key = offers.key;
    setBusy(door);
    setDoorError((e) => ({ ...e, [door]: undefined }));
    void (async () => {
      const res = await cardCall(
        () => (door === "switches" ? applyTradeSwitches(key) : door === "codes" ? applyTradeCodes(key) : startTradeSheet(key)),
        () => setBusy(null),
      );
      // The switches that landed are the board's too, whether or not the run finished (a thrown
      // call carries none: the server said nothing about what moved).
      const moved = (res as { moved?: SwitchMove[] }).moved;
      if (moved?.length) onSwitchesMoved(moved);
      if (!res.ok) {
        setDoorError((e) => ({ ...e, [door]: res.error }));
        return;
      }
      setSaid((s) => ({ ...s, [door]: res.words }));
      router.refresh();
    })();
  }

  function pickMode(id: string) {
    const next = id === "catalog" ? "catalog" : "research";
    if (next === mode || busy) return;
    // The value the server last confirmed: where the control goes back to on a refusal or a throw.
    const previous = mode;
    setMode(next);
    setBusy("mode");
    void (async () => {
      const res = await cardCall(() => setEstimatingMode(next), () => setBusy(null));
      if (!res.ok) {
        setMode(previous);
        toast(res.error, "error");
        return;
      }
      setMode(res.mode);
      toast(res.mode === "catalog" ? "You price from your catalog now." : "You price by research now.", "success");
      router.refresh();
    })();
  }

  const deckOff = deckPageOffLine(key, mode, picked);
  const rows: { door: OfferDoor; words: { button: string | null; line: string } }[] = offers
    ? [
        { door: "codes", words: codesOfferWords(offers) },
        { door: "switches", words: switchesOfferWords(offers) },
        { door: "sheet", words: sheetOfferWords(offers) },
      ]
    : [];

  return (
    <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
      <div className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Your Trade &amp; Pricing</div>
      <div className="flex min-h-11 items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-900">Your Trade: {menu}</div>
          <div className="text-xs text-slate-500">{TRADE_FOLLOWS_LINE}</div>
        </div>
        {canMove ? (
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={openChange}>
            Change My Trade
          </Button>
        ) : (
          askOwner && <span className="shrink-0 text-xs text-slate-500">Ask The Owner</span>
        )}
      </div>
      {offersError && <div className="bg-slate-50/60 px-4 py-3 text-xs text-red-600">{offersError}</div>}
      {offers && (
        <div className="space-y-2 bg-slate-50/60 px-4 py-3">
          <div className="text-xs font-medium text-slate-700">{offers.menu} usually comes with these. Each one is your call.</div>
          {rows.map(({ door, words }) => (
            <div key={door} className="flex items-center gap-3">
              <div className="min-w-0 flex-1 text-xs text-slate-600">
                {said[door] ?? words.line}
                {doorError[door] && <div className="mt-0.5 text-red-600">{doorError[door]}</div>}
              </div>
              {words.button && !said[door] && (
                <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => runDoor(door)}>
                  {busy === door ? "Working…" : words.button}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="px-4 py-3">
        <div className="flex min-h-11 items-center gap-3">
          <div className="min-w-0 flex-1 text-sm font-medium text-slate-900">How You Price</div>
          {canMove ? (
            <SegmentedControl items={MODE_ITEMS} activeId={mode} onSelect={pickMode} />
          ) : (
            <span className="shrink-0 text-right text-xs text-slate-500">
              {mode === "catalog" ? "Catalog" : "Research"}
              {askOwner ? " · Ask The Owner" : ""}
            </span>
          )}
        </div>
        <div className="mt-1 space-y-0.5">
          {(["research", "catalog"] as const).map((m) => (
            <div key={m} className={`text-xs ${m === mode ? "text-slate-700" : "text-slate-400"}`}>
              <span className="font-medium">{m === "research" ? "Research" : "Catalog"}:</span> {MODE_LINES[m]}
            </div>
          ))}
        </div>
      </div>

      <Modal
        open={changing}
        onClose={() => (busy === "trade" ? undefined : setChanging(false))}
        title="Change My Trade"
        size="sm"
        historyClose={false}
        holdOpen={busy === "trade"}
        footer={<ModalActions onCancel={() => setChanging(false)} onSave={saveTrade} saveLabel="Save" saving={busy === "trade"} />}
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-700">{TRADE_FOLLOWS_LINE}</p>
          <Select value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Your Trade">
            {TRADE_PACK_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
            <option value="other">Other / Not Listed</option>
          </Select>
          {deckOff && <p className="text-sm text-amber-800">{deckOff}</p>}
          {refusal && <p className="text-sm text-red-600">{refusal}</p>}
        </div>
      </Modal>
    </div>
  );
}
