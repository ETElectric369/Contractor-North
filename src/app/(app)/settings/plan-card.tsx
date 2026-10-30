import type { ReactNode } from "react";
import { FormSubmit } from "@/components/form-submit";
import { UsageRing } from "@/components/usage-ring";
import { fillText, translator } from "@/lib/i18n";
import type { Lang } from "@/lib/locale";
import { PLANS, planByTier } from "@/lib/plans";
import type { AccessState } from "@/lib/subscription";
import type { UsageMeter } from "@/lib/usage-meter";
import { usageWords } from "@/lib/usage-words";
import { buyExtraUsage, openPortal } from "./billing-actions";

/**
 * THE PLAN CARD (cn-v1140) — Settings › Getting Paid › Plan & subscription, redrawn around ONE
 * meter. Erik's design (2026-10-30): no "20 of 40 estimates", no count, no dollar; a ring with the
 * percent inside, "Resets Nov 1" under it, its color following the warnings; plain words; two doors,
 * Upgrade and Add Usage. Nothing to explain.
 *
 * WHAT IT DRAWS, in order: the plan's NAME in words (by the one access rule's reason — a trial, a
 * comped company, a tier's own name, or none; never the raw status or the plan column), then the
 * ring (components/usage-ring) with the meter's words beside it (lib/usage-words: Usage, the line,
 * the pace forecast when there is one, the trial's last day when there is a trial, and the standing
 * line for grace and comped), then the doors.
 *
 * THE DOORS, by role, shell and standing:
 *   owner / admin, web      Upgrade (a live Stripe subscription → the portal, where Stripe switches
 *                           the plan; otherwise /subscribe, Pick A Plan) — NOT for a comped company
 *                           (/subscribe bounces it home: a dead door) and NOT on the top tier with a
 *                           live subscription (nothing above Company); Add Usage (only when the
 *                           install sells it, billing-doors extraUsageConfigured, and only while the
 *                           company HAS access — active, trial, grace, comped; never lapsed, where
 *                           AI is paused and $15 buys nothing); Manage Billing (when Stripe knows the
 *                           customer, as before).
 *   owner / admin, the app  the ring and the words; Manage Billing alone (it stood there before);
 *                           NO Subscribe, Upgrade or Add Usage — the App Store app sells nothing
 *                           (Apple 3.1.1) — and the used-up line carries no "Add usage or upgrade."
 *   office                  the ring and the words and "Ask <first> to change the plan." Usage is
 *                           not money, so the ring is not behind office_sees_owner_money.
 *   billing off             the ring and the words and "Billing isn't turned on yet."
 * A degraded meter (a failed read, lib/usage-meter) is the ring with "—" inside and the fine words;
 * no door hides for it. Every word comes through the us_ catalog (lib/words/usage) in the person's
 * language. Pure: the page reads, this draws — so a test renders it with react-dom/server.
 */
export type PlanCardProps = {
  lang: Lang;
  /** The one access rule's answer (lib/subscription accessState); the plan's name is its reason's. */
  access: Pick<AccessState, "reason" | "active">;
  /** organizations.plan — the tier an active subscription is on. */
  plan: string | null | undefined;
  meter: Pick<UsageMeter, "pct" | "state" | "resetOn" | "runOutOn" | "trialEndsOn"> & { degraded?: boolean };
  /** The owner or an admin: the doors. Everyone else reads who to ask. */
  isAdmin: boolean;
  /** Inside the App Store app: no Subscribe, Upgrade or Add Usage. */
  inShell: boolean;
  billingEnabled: boolean;
  /** Stripe knows the customer (stripe_customer_id): Manage Billing stands. */
  hasCustomer: boolean;
  /** A Stripe subscription is live (lib/lapse-doors): Upgrade goes to the portal, not to /subscribe. */
  liveSubscription: boolean;
  /** The install sells extra usage (billing-doors extraUsageConfigured): Add Usage stands. */
  addUsageOn: boolean;
  /** The owner's first name for someone who cannot change the plan; null reads "Ask the owner…" (us_askTheOwner). */
  ownerFirst: string | null;
  /** The standing line for grace and comped (lib/lapse-doors planStateLine), owner/admin only. */
  stateLine?: string | null;
  /** What the URL carried back: billing=success, usage=added, a billing_error. */
  notice?: { billing?: string; usage?: string; billingError?: string };
};

/**
 * Which us_plan_ key names the plan: the trial and a comped company by their standing; an active or
 * grace-period subscription by its tier's name (us_plan_handyman / crew / company), or "Subscribed"
 * when the plan column names a price the ladder does not; anything else (lapsed, unknown) "No Plan".
 */
export function planNameKey(access: Pick<AccessState, "reason">, plan: string | null | undefined): string {
  if (access.reason === "trial") return "us_plan_trial";
  if (access.reason === "comped") return "us_plan_comped";
  if (access.reason === "active" || access.reason === "grace") {
    const tier = planByTier(plan)?.tier;
    return tier ? `us_plan_${tier}` : "us_plan_subscribed";
  }
  return "us_plan_none";
}

/** The Upgrade link's look: Button's primary variant, on an <a> (the /subscribe page is outside the app shell). */
const LINK_BUTTON =
  "btn-gloss inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[rgb(var(--glass-ink))] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[rgb(var(--glass-ink))]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--glass-ink))] focus-visible:ring-offset-2";

export function PlanCard(props: PlanCardProps) {
  const t = translator(props.lang);
  const words = usageWords(props.meter, t, props.lang, { shell: props.inShell });
  const notice = props.notice ?? {};

  // The doors that stand for this person, in this shell, on this standing.
  const doors: ReactNode[] = [];
  // Nothing above the ladder's last tier: a live subscription on it has no Upgrade.
  const onTopTier = props.liveSubscription && planByTier(props.plan)?.tier === PLANS[PLANS.length - 1].tier;
  if (props.billingEnabled && props.isAdmin) {
    if (!props.inShell) {
      if (props.access.reason !== "comped" && !onTopTier) {
        doors.push(
          props.liveSubscription ? (
            <form key="upgrade" action={openPortal}>
              <FormSubmit>{t("us_door_upgrade")}</FormSubmit>
            </form>
          ) : (
            <a key="upgrade" href="/subscribe" className={LINK_BUTTON}>
              {t("us_door_upgrade")}
            </a>
          ),
        );
      }
      if (props.addUsageOn && props.access.active) {
        doors.push(
          <form key="add-usage" action={buyExtraUsage}>
            <FormSubmit variant="outline">{t("us_door_addUsage")}</FormSubmit>
          </form>,
        );
      }
    }
    if (props.hasCustomer) {
      doors.push(
        <form key="portal" action={openPortal}>
          <FormSubmit variant="outline">{t("us_door_manageBilling")}</FormSubmit>
        </form>,
      );
    }
  }

  return (
    <div data-plan-card>
      {notice.billing === "success" && (
        <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{t("us_subscribedThanks")}</div>
      )}
      {notice.usage === "added" && (
        <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{t("us_added")}</div>
      )}
      {notice.billingError && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{notice.billingError}</div>}

      {/* The plan's name, in words. */}
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("us_plan")}</div>
      <div className="text-base font-semibold text-slate-900" data-plan-name>
        {t(planNameKey(props.access, props.plan))}
      </div>

      {/* The one meter: the ring, and the words beside it. */}
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <UsageRing pct={props.meter.pct} state={props.meter.state} degraded={props.meter.degraded} lang={props.lang} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-900">{words.headline}</div>
          <p className="mt-0.5 text-sm text-slate-600">{words.line}</p>
          {words.forecast && <p className="text-sm text-slate-500">{words.forecast}</p>}
          {words.trialLine && <p className="text-sm text-slate-500">{words.trialLine}</p>}
          {props.stateLine && <p className="text-sm text-slate-500">{props.stateLine}</p>}
        </div>
      </div>

      {/* The doors, or who to ask, or why there is none. */}
      {props.billingEnabled ? (
        props.isAdmin ? (
          doors.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{doors}</div>
        ) : (
          <p className="mt-3 text-sm text-slate-600">{props.ownerFirst ? fillText(t("us_askOwner"), { first: props.ownerFirst }) : t("us_askTheOwner")}</p>
        )
      ) : (
        <p className="mt-3 text-sm text-slate-400">{t("us_billingOff")}</p>
      )}
    </div>
  );
}
