// Shared between the chat route (server) and the assistant client. The chat normally
// streams plain text; when the agent proposes a CONFIRM-gated action (e.g. record a cost),
// the server appends this marker followed by a JSON proposal as the LAST thing in the
// stream. The client splits on the marker: everything before is the spoken/printed reply,
// everything after is the proposal to confirm. ␞ (U+241E) won't occur in normal prose.
export const CONFIRM_MARKER = "␞CN_CONFIRM␞";

/** The proposal the user must approve before the action actually runs. */
export type AgentConfirm = {
  /** Canonical registry action name, e.g. "bill.create". */
  name: string;
  /** The exact validated input the agent proposed. */
  input: Record<string, unknown>;
  /** Human read-back, e.g. "Add a $40.00 cost from Home Depot — say yes to confirm." */
  prompt: string;
};

// A second client directive: open Maps (navigate / find a place). Emitted as the last
// stream chunk, same split rule as the confirm marker. The agent decides search vs
// directions; the client opens the URL.
export const OPEN_MARKER = "␞CN_OPEN␞";

export type AgentOpen = {
  /** Maps URL to open. */
  url: string;
  /** What we're opening, for the read-back, e.g. "gas station". */
  label: string;
};

// A BIDIRECTIONAL client directive: open the on-screen CONTACT PICKER so the user can search +
// physically tap a contact mid-conversation (e.g. while building an estimate). Emitted as the last
// stream chunk (same split rule as OPEN/CONFIRM). Unlike OPEN, the result comes BACK: after the user
// picks, the client sends their choice as the next message so the agent resumes — the "say the name,
// pick it on screen, keep building" flow.
export const PICK_MARKER = "␞CN_PICK␞";

export type AgentPick = {
  /** What to pick — a contact (customer / subcontractor) for now. */
  kind: "contact";
  /** Optional search term to pre-fill the picker, e.g. "Jackie". */
  search?: string;
  /** Optional type filter. */
  type?: "residential" | "commercial" | "industrial" | "subcontractor";
  /** Short read-back, e.g. "pick the contact to add". */
  label?: string;
};

// Transient TOOL-STATUS while the agent works (so a silent tool call doesn't feel dead). Emitted
// inline as the agent enters a tool batch; the client shows the latest as a "Searching…" pill while
// streaming and clears it when text resumes. Delimited so it's strippable from the visible text.
export const STATUS_OPEN = "␞CN_STATUS␞";
export const STATUS_CLOSE = "␞/CN_STATUS␞";

// A LIVE quote draft the agent builds as you talk — emitted MID-stream (delimited by an
// open/close marker so the client can extract complete blocks while text keeps streaming),
// and re-emitted each time a line is added/changed, so the preview fills in line-by-line.
export const DRAFT_OPEN = "␞CN_DRAFT␞";
export const DRAFT_CLOSE = "␞/CN_DRAFT␞";

export type AgentDraftItem = {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
};

export type AgentDraft = {
  kind: "quote";
  /** Display name; resolve customer_id via list_customers when known (null = unattached). */
  customer_name?: string | null;
  customer_id?: string | null;
  job_id?: string | null;
  title?: string;
  /** Fraction, e.g. 0.0825 for 8.25%. */
  tax_rate?: number;
  items: AgentDraftItem[];
  /** "building" while gathering, "ready" once read back + good to save. */
  status?: "building" | "ready";
};

// The DRIVER HUD CARD — the "windshield". When the user asks Nort to pull up / show an
// entity (a job, estimate, invoice, customer, or the day), the agent calls show_card with
// the KEY glanceable facts and the client fills the N-Box with one big, driver-safe card
// instead of a wall of text. Emitted as a delimited block, same mid-stream extract rule as
// DRAFT (the client keeps the LAST complete block).
export const HUD_OPEN = "␞CN_HUD␞";
export const HUD_CLOSE = "␞/CN_HUD␞";

export type HudFact = {
  /** Short label, e.g. "gate code", "balance due", "hours today". */
  label: string;
  /** The value, already formatted for the eye, e.g. "4412", "$7,350", "6.5h". */
  value: string;
};

/** One row of a projected LIST block — an estimate line, an appointment, a duplicate
 *  contact, a job in a set. label on the left, value on the right, an optional dimmer sub. */
export type HudRow = {
  label: string;
  /** Right-aligned value, e.g. "$3,600", "8:00a", "(530) 933-6686". */
  value?: string | null;
  /** A quieter second line under the label, e.g. "24 hr × $150", "Tue Jul 15". */
  sub?: string | null;
  /** Optional deep link so a parked tap opens that row's record. */
  href?: string | null;
};

/**
 * The glass Nort projects — a COMPOSABLE card, not a fixed shape. Nort fills only the
 * blocks it needs and they stack in order: eyebrow → title → address → scope → facts
 * tiles → a titled ROWS list (line items, a day's appointments, duplicate contacts side
 * by side, a set of jobs) → an optional total → the one look-ahead line. Think hologram
 * projector: same frame, any content.
 */
export type AgentHudCard = {
  kind: "job" | "estimate" | "invoice" | "customer" | "schedule" | "task" | "list";
  /** The headline — the customer / entity name (or a list heading like "3 duplicate Millers"). */
  title: string;
  /** A short context line, e.g. "on the clock · J-012" or "draft estimate". */
  eyebrow?: string | null;
  /** A one-line scope / summary. */
  scope?: string | null;
  /** Street address — the card turns it into one tap to Maps. */
  address?: string | null;
  /** Up to ~4 big glanceable tiles (gate code, balance due, hours, …). */
  facts?: HudFact[];
  /** A projected LIST — estimate line items, a day's appointments, duplicate contacts, jobs. */
  rows?: HudRow[];
  /** Heading above the rows, e.g. "Line items", "Today's stops", "3 versions on file". */
  rowsTitle?: string | null;
  /** A bold total row under the list, e.g. { label: "Total", value: "$7,350" }. */
  total?: HudFact | null;
  /** The one look-ahead line, e.g. "next: 8:00 at the Lim's, 6 min away". */
  next?: string | null;
  /** Deep link to the full screen, so tapping the card opens it when parked. */
  href?: string | null;
  /** true = clear the card off the glass. */
  cleared?: boolean;
};

/**
 * The ONLY kind of link a HUD card may carry: a same-app, absolute, RELATIVE path.
 *
 * A card's `href` and its `rows[].href` are MODEL-authored, and the model routinely reads
 * customer-controlled text (notes, inquiry messages). Rendered as a next/link inside the PWA —
 * where standalone display mode shows no address bar — an off-origin URL would be an attacker's
 * page one tap away, dressed as the app. So href is never trusted: only "/..." internal paths
 * pass; absolute URLs ("https://…"), protocol-relative ("//…"), and backslash tricks ("/\…")
 * all return null and the consumer falls back to plain text (no link). Same predicate as the
 * ?next= open-redirect guard (safeNextPath); duplicated here so this module stays dependency-free
 * and usable from both the server route and the client card renderer.
 */
export function safeInternalHref(raw: unknown): string | null {
  const p = typeof raw === "string" ? raw.trim() : "";
  return p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") ? p.slice(0, 512) : null;
}

/**
 * Server-side clamp for a show_card payload before it reaches the client: strip every href that
 * isn't a safe internal path so a compromised card can never carry an off-origin link to the
 * windshield. Structure-preserving — every other field passes through untouched (they render as
 * plain text, never as a navigation target). The client card renderer applies safeInternalHref
 * again at the render boundary (defense in depth), so any future consumer inherits the guard too.
 */
export function sanitizeHudCard(input: unknown): Partial<AgentHudCard> {
  const c = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...c };
  const href = safeInternalHref(c.href);
  if (href) out.href = href;
  else delete out.href;
  if (Array.isArray(c.rows)) {
    out.rows = c.rows.map((r) => {
      const row = (r ?? {}) as Record<string, unknown>;
      const rh = safeInternalHref(row.href);
      const cleaned = { ...row };
      if (rh) cleaned.href = rh;
      else delete cleaned.href;
      return cleaned;
    });
  }
  return out as Partial<AgentHudCard>;
}
