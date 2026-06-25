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
