/**
 * THE ADD USAGE DOOR'S FACTS AND WORDS (cn-v1140) — a plain module beside billing-actions.ts,
 * because a "use server" file may export only async functions (tests/use-server-exports) and both
 * the action (buyExtraUsage) and the plan card (is the door for sale?) read the same two things:
 *
 *   · THE PRICE, by env name. STRIPE_PRICE_EXTRA_USAGE is one Stripe price on OUR account (never a
 *     connected one) for a one-time payment; its PRODUCT carries metadata.usage_usd — the internal
 *     dollars of model spend the purchase adds to the month's cap (0401 usage_topups, landed by the
 *     webhook). Unset: the door does not render, and a posted form is refused in words.
 *   · THE REFUSALS, each naming one action (no-merry-go-round). English, like the siblings in
 *     lib/lapse-doors: a refusal rides the URL into the card, which prints it as it is.
 */
export const EXTRA_USAGE_PRICE_ENV = "STRIPE_PRICE_EXTRA_USAGE";

/** The extra-usage price id, or null when the install has none (the door is then hidden). */
export function extraUsagePriceId(): string | null {
  return process.env.STRIPE_PRICE_EXTRA_USAGE || null;
}

/** Is extra usage for sale on this install? (The card asks; the action re-checks.) */
export function extraUsageConfigured(): boolean {
  return extraUsagePriceId() !== null;
}

/** The most one top-up may add (internal dollars): a product carrying more is a typo in Stripe, refused before any session. */
export const EXTRA_USAGE_USD_MAX = 1000;
/** usage_topups.usage_usd is numeric(12,6) (0401): more decimals than the column holds are refused, never silently rounded. */
export const EXTRA_USAGE_USD_DECIMALS = 6;
const USD_SHAPE = /^\d+(\.\d{1,6})?$/;

/**
 * The usage a retrieved price adds, from its EXPANDED product's metadata.usage_usd: a positive
 * number of at most EXTRA_USAGE_USD_MAX with at most EXTRA_USAGE_USD_DECIMALS decimals, or null
 * when the product is not expanded, is deleted, or carries no such number — and null is a refusal
 * in words (ADD_USAGE_NOT_PRICED) before any session is created. The webhook writes exactly this
 * figure (as a string) into the session's metadata, so what is sold and what lands are one number
 * read once.
 */
export function extraUsageUsdOf(price: { product?: unknown } | null | undefined): number | null {
  const product = price?.product;
  if (!product || typeof product !== "object") return null;
  if ((product as { deleted?: boolean }).deleted) return null;
  const raw = (product as { metadata?: Record<string, string> | null }).metadata?.usage_usd;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!USD_SHAPE.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 && n <= EXTRA_USAGE_USD_MAX ? n : null;
}

/** buyExtraUsage's refusal from inside the App Store app (the door is hidden there; Apple 3.1.1). */
export const ADD_USAGE_WEB_ONLY = "Add usage from a web browser — open Settings there.";
/** buyExtraUsage's refusal when STRIPE_PRICE_EXTRA_USAGE is unset. */
export const ADD_USAGE_NOT_CONFIGURED = "Extra usage isn't for sale yet.";
/** buyExtraUsage's refusal when the price's product carries no positive metadata.usage_usd (or one above the ceiling, or with too many decimals). */
export const ADD_USAGE_NOT_PRICED = "Extra usage isn't priced yet — tell us and we'll fix it.";
/** startCheckout's refusal from inside the App Store app, and /subscribe's one line there (Apple 3.1.1: the app sells nothing). */
export const PICK_PLAN_WEB_ONLY = "Pick a plan on the web at app.contractornorth.com.";

/** startCheckout's refusal when no tier was posted and the legacy STRIPE_PRICE_ID is unset too. */
export const NO_PLAN_CONFIGURED = "No plan is configured yet.";
/** startCheckout's refusal when the posted tier is not on the ladder (lib/plans PLANS). */
export const NO_SUCH_PLAN = "That plan doesn't exist — pick one from the list.";

/** startCheckout's refusal when the tier is real but its price for that cadence is not configured. */
export function planNotConfiguredWords(planName: string, cadence: "monthly" | "annual"): string {
  return `${planName} isn't set up for ${cadence === "annual" ? "yearly" : "monthly"} billing yet.`;
}
