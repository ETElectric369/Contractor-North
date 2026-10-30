import type { AccessReason, AccessState } from "@/lib/subscription";

/**
 * THE DOORS A LAPSED COMPANY KEEPS (cn-v1137). When a company's standing is gone (accessState says
 * trial_ended, grace_spent, canceled, unknown), the (app) layout sends everyone to /subscribe —
 * except the people who can fix it, on the doors that fix it: the owner or an admin may still open
 * Settings (Plan & subscription, Manage Billing), /subscribe itself and the accountant's export. On
 * those doors the shell is drawn with a red bar instead of a redirect, so the fix is one tap away
 * and the books are never held hostage by the bill.
 *
 * A layout cannot read its own URL, so middleware writes the request's path and query onto two
 * request headers (PATHNAME_HEADER, SEARCH_HEADER) and the layout reads them. A missing header is
 * the safe default: redirect. Pure, so every rule here is tested without a request.
 */
export const LAPSED_OPEN_DOORS = ["/subscribe", "/settings", "/analytics/accountant"] as const;

/** The request header middleware sets to the request's pathname (overwriting any a browser sent). */
export const PATHNAME_HEADER = "x-cn-pathname";
/** The request header middleware sets to the request's query string ("?a=b" or ""). */
export const SEARCH_HEADER = "x-cn-search";

/** The roles that can pick a plan: the owner and an admin (billing-actions' loadOwnerOrg, the same two). */
export function canPickPlan(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Is this path one a lapsed owner/admin may still open? Prefix on a "/" boundary, so /settingsx is
 * not /settings and /settings/anything is. A trailing slash is the same door. null = no header =
 * false (the safe default is the wall).
 */
export function lapsedDoorOpen(pathname: string | null | undefined, role: string | null | undefined): boolean {
  if (!canPickPlan(role)) return false;
  if (!pathname || typeof pathname !== "string") return false;
  const p = pathname.replace(/\/+$/, "") || "/";
  return LAPSED_OPEN_DOORS.some((door) => p === door || p.startsWith(`${door}/`));
}

/** The red bar's words: what ended, and what is paused (never the customers' way to pay). */
export function lapseBarWords(state: Pick<AccessState, "reason">): string {
  return `${lapseWhat(state.reason)} Nort, texts and reminders are paused. Your customers can still pay you.`;
}

function lapseWhat(reason: AccessReason): string {
  if (reason === "trial_ended") return "Your free trial has ended.";
  if (reason === "grace_spent") return "Your card was not updated in time.";
  return "Your plan has ended.";
}

/** /subscribe's headline, by reason. Title Case: it is the one line the page says. */
export function subscribeHeadline(reason: AccessReason): string {
  if (reason === "trial_ended") return "Your Free Trial Has Ended";
  if (reason === "grace_spent") return "Your Card Was Declined";
  if (reason === "canceled") return "Your Subscription Has Ended";
  return "Your Plan Needs Attention";
}

/** The longest billing_error the wall carries into /subscribe (a query string is not a letter). */
const BILLING_ERROR_MAX = 300;

/**
 * Where the wall sends someone: /subscribe, carrying ONLY a billing_error from the query it was
 * asked on (a Stripe refusal that landed a lapsed person on a closed door must not be lost in the
 * redirect). Anything else in the query stays behind; a query that cannot be parsed is no query.
 */
export function subscribeHref(search: string | null | undefined): string {
  if (!search || typeof search !== "string") return "/subscribe";
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return "/subscribe";
  }
  const err = (params.get("billing_error") ?? "").trim();
  if (!err) return "/subscribe";
  return `/subscribe?billing_error=${encodeURIComponent(err.slice(0, BILLING_ERROR_MAX))}`;
}

export type LapseWall =
  /** The company stands: nothing to do. */
  | { kind: "open" }
  /** Lapsed, but this person on this door may stay: draw the red bar with these words. */
  | { kind: "bar"; words: string }
  /** Lapsed and this is not an open door for this person: send them here. */
  | { kind: "redirect"; to: string };

/**
 * THE WALL'S ONE DECISION. The layout asks this inside its billing gate with the state the spine
 * computed, the person's role and the two headers; it does what the answer says and nothing more.
 */
export function lapseWall(args: {
  state: AccessState;
  role: string | null | undefined;
  pathname: string | null | undefined;
  search?: string | null | undefined;
}): LapseWall {
  if (args.state.active) return { kind: "open" };
  if (lapsedDoorOpen(args.pathname, args.role)) return { kind: "bar", words: lapseBarWords(args.state) };
  return { kind: "redirect", to: subscribeHref(args.search) };
}

/**
 * A STRIPE SUBSCRIPTION THAT CAN STILL BE MANAGED: one exists and Stripe still holds it open —
 * active, trialing, past due, unpaid, waiting on its first payment (incomplete) or paused. This is
 * the one case where the billing portal is the door (update the card, change the plan, undo a
 * cancellation) and Checkout must not mint a second subscription on the same customer. A canceled
 * subscription cannot be restarted from the portal, and neither can one whose first payment never
 * came (incomplete_expired: Stripe has closed it for good) — so for those, and for a customer
 * Stripe knows but never subscribed, Checkout is the door, and it reuses the customer (skeptic #43,
 * S13: "any status but canceled" offered Manage Billing to an expired subscription and refused the
 * Checkout that was its only way back).
 */
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

export function stripeSubscriptionLive(org: {
  stripe_subscription_id?: string | null;
  subscription_status?: string | null;
}): boolean {
  return !!org.stripe_subscription_id && LIVE_SUBSCRIPTION_STATUSES.has(String(org.subscription_status ?? ""));
}

/** startCheckout's refusal when a subscription is already live (names ONE action). */
export const SECOND_SUBSCRIPTION_REFUSAL = "A subscription already exists — use Manage Billing.";
/** openPortal's refusal when Stripe has no customer for this company yet (names ONE action: the
 *  plan card's Upgrade door, which is where a company with no billing account picks a plan). */
export const NO_BILLING_ACCOUNT_REFUSAL = "There's no billing account yet — Upgrade first.";

/**
 * The one-line standing on Settings › Plan & subscription, for the owner/admin: how long the trial
 * has, how much grace is left, or until when the company is comped. Nothing when the plan is simply
 * active, and nothing when it has lapsed (the badge and the wall already say so).
 */
export function planStateLine(
  state: AccessState,
  opts: { compedUntil?: string | null; tz?: string | null } = {},
): string | null {
  if (state.reason === "trial") {
    if (state.daysLeft == null) return null;
    if (state.daysLeft === 0) return "Trial Ends Today";
    return `Trial Ends In ${state.daysLeft} ${state.daysLeft === 1 ? "Day" : "Days"}`;
  }
  if (state.reason === "grace") {
    const n = state.daysLeft ?? 0;
    return `Grace: ${n} ${n === 1 ? "Day" : "Days"} Left`;
  }
  if (state.reason === "comped") {
    const date = state.compedBy === "column" ? formatDay(opts.compedUntil, opts.tz) : null;
    return date ? `Comped Until ${date}` : "Comped";
  }
  return null;
}

/** "Nov 30, 2026" in the company's own zone; null when the stamp is not a date. */
function formatDay(iso: string | null | undefined, tz: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: tz || "America/Los_Angeles",
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(d);
  }
}
