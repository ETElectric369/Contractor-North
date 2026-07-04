/**
 * Lead triage — THE front-door qualifier for inbound leads (e.g. the Tahoe Deck deck
 * configurator). Pure + testable: given a customer's intake answers + the configured
 * estimate total, it decides the readiness bucket, whether the job is big enough to force
 * a site inspection (no instant price), whether to show an instant number at all, and a
 * priority score so the hot/ready/big jobs surface first. The rules live HERE (server-side)
 * so a client can't game its way to an instant big-ticket number or a false priority.
 */

/** The scope the customer picked. 'unsure' (or a combination) signals "needs help" → consult. */
export type ProjectType =
  | "new_deck"
  | "full_replacement"
  | "resurface"        // new boards on the existing frame
  | "railing"          // railing only
  | "stairs"           // stairs only
  | "extension"        // add-on / enlarge
  | "repair"           // rot / damage / loose boards
  | "staining"         // refinish only
  | "unsure";          // "not sure / combination — I need help"

export const PROJECT_TYPES: { value: ProjectType; label: string }[] = [
  { value: "new_deck", label: "New deck" },
  { value: "full_replacement", label: "Full deck replacement" },
  { value: "resurface", label: "Resurface — new boards, keep the frame" },
  { value: "railing", label: "Railing only" },
  { value: "stairs", label: "Stairs only" },
  { value: "extension", label: "Add-on / extension" },
  { value: "repair", label: "Repair (rot, damage, loose boards)" },
  { value: "staining", label: "Staining / refinishing only" },
  { value: "unsure", label: "Not sure / combination — I need help" },
];

export type LeadIntake = {
  projectType?: ProjectType | null;
  /** Q2 — do they have engineered plans? */
  hasPlans?: boolean;
  /** Q3 (if hasPlans) — county/city approved? */
  plansApproved?: "yes" | "no" | "unsure" | null;
  /** Q4 (if no plans) — how they can picture it. */
  hasSketch?: boolean;      // uploaded a sketch / photos
  hasDimensions?: boolean;  // has accurate measurements
  needsDesignHelp?: boolean;
  /** The configured estimate total from the deck builder (0/absent if none). */
  estimateTotal?: number | null;
  contact?: { name?: string | null; email?: string | null; phone?: string | null; address?: string | null } | null;
};

/** Readiness bucket — how ready this lead is to become a firm quote. */
export type LeadBucket = "A" | "B" | "C";

export const LEAD_BUCKETS: Record<LeadBucket, { label: string; blurb: string }> = {
  A: { label: "Ready to quote", blurb: "Has plans — straight to a firm estimate." },
  B: { label: "Measure & quote", blurb: "No plans, but a sketch and/or real dimensions." },
  C: { label: "Design consult", blurb: "Needs a design conversation before any number." },
};

/** Default job size (configured total) at or above which a job needs a human site
 *  inspection before any firm price. Owner-tunable via org settings. */
export const DEFAULT_SITE_INSPECTION_THRESHOLD = 20000;

const fin = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

export type LeadTriage = {
  bucket: LeadBucket;
  /** Big job → route to a human site visit; never show an instant firm price. */
  siteInspectionRequired: boolean;
  /** Whether the customer should see an instant firm number (earned, not given). */
  showInstantPrice: boolean;
  /** 0-based score; higher = hotter (bigger + readier + reachable). Sort desc. */
  priority: number;
  /** One-line human explanation for the Leads board. */
  reason: string;
};

/**
 * Classify a lead. `inspectionThreshold` comes from the org's settings (defaults to $20k).
 */
export function classifyLead(
  intake: LeadIntake,
  opts: { inspectionThreshold?: number } = {},
): LeadTriage {
  const threshold = opts.inspectionThreshold ?? DEFAULT_SITE_INSPECTION_THRESHOLD;
  const total = fin(intake.estimateTotal);
  const c = intake.contact ?? {};

  // ── Bucket (readiness) ──
  // "Need help" / unsure / combination → design consult, regardless of anything else.
  // Otherwise: plans → A; else a sketch or real dimensions → B; else (nothing to go on) → C.
  let bucket: LeadBucket;
  if (intake.needsDesignHelp || intake.projectType === "unsure") bucket = "C";
  else if (intake.hasPlans) bucket = "A";
  else if (intake.hasSketch || intake.hasDimensions) bucket = "B";
  else bucket = "C";

  // ── The size gate ── big jobs always get eyes-on before a number.
  const siteInspectionRequired = total > threshold;

  // ── Instant price is EARNED ── only a ready lead (A/B) on a right-sized job (≤ threshold)
  // with an actual configured number sees a firm price. Everything else is a human touch.
  const showInstantPrice = bucket !== "C" && !siteInspectionRequired && total > 0;

  // ── Priority (size × readiness × reachability × plan-approval) ──
  const sizePts = Math.min(40, Math.round(total / 1000)); // $1k → 1pt, caps at $40k+
  const readyPts = bucket === "A" ? 30 : bucket === "B" ? 18 : 5;
  const approvedPts = intake.plansApproved === "yes" ? 15 : 0;
  const contactPts = (c.phone ? 5 : 0) + (c.address ? 5 : 0) + (c.email ? 3 : 0);
  const priority = sizePts + readyPts + approvedPts + contactPts;

  const money = total > 0 ? `$${Math.round(total).toLocaleString()}` : "no estimate";
  const reason = siteInspectionRequired
    ? `Over threshold (${money}) — site inspection required`
    : bucket === "C"
      ? `Design consult — ${money}`
      : `Bucket ${bucket} · ${money}${intake.plansApproved === "yes" ? " · plans approved" : ""} · instant quote`;

  return { bucket, siteInspectionRequired, showInstantPrice, priority, reason };
}

/** One priced line from a partner configurator's estimate (Tahoe Deck sends these in
 *  intake.estimate.lines). Shape is the contract in POST /api/inbound/lead's JSDoc and
 *  matches the quote builder's DraftLineItem, so these seed a draft estimate 1:1. */
export type EstimateLine = { description: string; quantity: number; unit: string; unit_price: number };

/**
 * Pull the configurator's priced lines out of a lead's stashed intake jsonb
 * (intake.estimate.lines) as clean EstimateLines. Everything is coerced defensively — the
 * JSON crossed the wire from a partner — and any row without a description is dropped, so
 * the result is always safe to hand to saveQuote(). Missing/'' anything → an empty list.
 */
export function estimateLinesFromIntake(intake: unknown): EstimateLine[] {
  const raw = (intake as { estimate?: { lines?: unknown } } | null)?.estimate?.lines;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => {
      const line = (l ?? {}) as Record<string, unknown>;
      return {
        description: String(line.description ?? "").trim(),
        quantity: Number(line.quantity) || 0,
        unit: line.unit ? String(line.unit) : "ea",
        unit_price: Number(line.unit_price) || 0,
      };
    })
    .filter((l) => l.description.length > 0);
}
