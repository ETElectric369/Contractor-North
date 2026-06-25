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
