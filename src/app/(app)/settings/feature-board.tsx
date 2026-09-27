"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { FEATURES, FEATURE_BY_KEY, featureChildren, featureOn, type FeatureDef, type FeatureKey, type FeatureMap } from "@/lib/features";
import { setFeature } from "./features-actions";

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

export function FeatureBoard({ features, isOwner, counts, siteName, crewQuiet, ready }: FeatureBoardProps) {
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
