import { zodToJsonSchema } from "zod-to-json-schema";
import type Anthropic from "@anthropic-ai/sdk";
import { actionsForRole } from "./registry";
import { actionRisk } from "./risk";

// Phase E, step 1: the curated set of TIER-1 (reversible, low-stakes) writes the CHAT
// agent may perform — task management + the two safe creates. Everything still flows
// through executeAction (role gate + audit + the confirm/step-up gate), and tier-2 /
// destructive / money actions are deliberately NOT in this set. Widen in risk order as
// the confirm-in-chat flow lands (Phase E step 2). Belt-and-suspenders like VOICE_ALLOWED.
export const AGENT_WRITE_ALLOWED = new Set<string>([
  "task.create",
  "task.complete",
  "task.setDue",
  "task.assign",
  "customer.create",
  "appointment.create",
  // Quotes are DRAFTS (reversible, reviewable, not sent, no money moved). The agent must
  // read the whole quote back + get a spoken "yes" before calling it — that conversational
  // confirm is enforced in the tool description, and saveQuote is staff-gated + audited.
  "quote.create",
]);

// Registry names are group.verb (a dot); Anthropic tool names can't contain dots.
const toToolName = (name: string) => name.replace(/\./g, "__");

/** The write tools a given role may be OFFERED in chat — generated from the registry so
 *  adding an action to AGENT_WRITE_ALLOWED is the only step. Returns the Anthropic tool
 *  defs + a resolver from tool name back to the canonical action name (null if not a
 *  write tool). */
export function agentWriteToolsForRole(role: string | null | undefined): {
  tools: Anthropic.Tool[];
  resolve: (toolName: string) => string | null;
} {
  const allowed = actionsForRole(role, { effect: "write" }).filter(
    (a) => AGENT_WRITE_ALLOWED.has(a.name) && actionRisk(a) <= 1,
  );
  const map = new Map<string, string>();
  const tools: Anthropic.Tool[] = allowed.map((a) => {
    const tn = toToolName(a.name);
    map.set(tn, a.name);
    const schema = zodToJsonSchema(a.input, { target: "openApi3" }) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return {
      name: tn,
      description: a.description,
      input_schema: {
        type: "object",
        properties: schema.properties ?? {},
        required: schema.required ?? [],
      },
    };
  });
  return { tools, resolve: (toolName: string) => map.get(toolName) ?? null };
}
