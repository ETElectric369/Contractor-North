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

export type AgentHudCard = {
  kind: "job" | "estimate" | "invoice" | "customer" | "schedule" | "task";
  /** The headline — the customer / entity name. */
  title: string;
  /** A short context line, e.g. "on the clock · J-012" or "draft estimate". */
  eyebrow?: string | null;
  /** A one-line scope / summary. */
  scope?: string | null;
  /** Street address — the card turns it into one tap to Maps. */
  address?: string | null;
  /** Up to ~4 big glanceable tiles (gate code, balance due, hours, …). */
  facts?: HudFact[];
  /** The one look-ahead line, e.g. "next: 8:00 at the Lim's, 6 min away". */
  next?: string | null;
  /** Deep link to the full screen, so tapping the card opens it when parked. */
  href?: string | null;
  /** true = clear the card off the glass. */
  cleared?: boolean;
};
