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
  "customer.update", // fix a misspelled name / add contact info (reversible edit)
  "appointment.create",
  "appointment.update", // reschedule by voice (no cancel+recreate)
  "appointment.setStatus", // mark completed / cancelled
  // Quotes are DRAFTS (reversible, reviewable, not sent, no money moved). The agent must
  // read the whole quote back + get a spoken "yes" before calling it — that conversational
  // confirm is enforced in the tool description, and saveQuote is staff-gated + audited.
  "quote.create",
  "quote.addItem", // the deep audit's biggest miss — CIB could create a quote but not edit it
  "quote.updateItem",
  "quote.deleteItem",
  // Field work — the one-assistant-everywhere set. Clock in/out + log time are reversible
  // tier-1 records; bill.create (add a cost) is tier-2 financial and trips the confirm gate,
  // which the chat now surfaces (propose → user says yes → confirmAgentAction). NONE of these
  // is money-MOVEMENT, so none needs the WebAuthn step-up.
  "time.clockIn",
  "time.clockOut",
  "time.addEntry",
  "bill.create",
  // The money loop (CIB audit Phase 2 — "fill in the invoice and get it ready, I'll hit
  // Send"). Building/adjusting a DRAFT invoice is tier-1 (reversible, nothing sent, no money
  // moved) so it runs straight through; payment.record touches money so it's confirm-gated
  // (confirm:"financial" → propose → spoken yes). SENDING / refunding / deleting an invoice
  // are NOT here — those remain the user's tap on the big Send button.
  "invoice.fromJob",
  "invoice.fromQuote",
  "invoice.addItem",
  "invoice.updateItem",
  "invoice.deleteItem",
  "payment.record",
  // Connect-the-dots: the funnel's first hop + permits. inquiry.create/contact/convert make the
  // leads->quote->job pipeline voice-walkable end to end; permit.create logs a permit. All tier-1
  // (reversible records; no money, nothing sent). inquiry.delete stays OUT (destructive).
  "inquiry.create",
  "inquiry.contact",
  "inquiry.convert",
  "permit.create",
  // Mycelium: the office/field nodes — log petty cash (confirm-gated, money), adjust stock,
  // log a safety record. All reversible tier-1 except pettyCash.add (confirm:financial).
  "pettycash.add",
  "inventory.adjust",
  "safety.log",
  "compliance.create",
  "lien.update",
  // The JOB LIFECYCLE (the deep audit's biggest miss): CIB could quote a job but not OPEN,
  // schedule, assign, set status on, or FINISH one. job.finish is confirm-gated (drafts an
  // invoice — but never sends); the rest are tier-1 reversible.
  "job.create",
  "job.setStatus",
  "job.finish",
  "job.scheduleDay",
  "job.assign",
  "job.setScope",
  // Field capture: a hands-busy voice note + on-site price-list capture + receipt triage.
  "organize.saveNote",
  "organize.review",
  "organize.billReceipt", // confirm-gated (creates a job cost)
  "pricelist.add",
  // The last filaments: move a quote down the funnel, draft a contract.
  "quote.setStatus",
  "quote.convertToJob",
  "contract.generate",
  "form.submit", // fill a checklist by voice
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
    (a) =>
      AGENT_WRITE_ALLOWED.has(a.name) &&
      // tier-1 runs straight through; tier-2 CONFIRM actions are now offered too because the
      // chat surfaces the confirm (propose → user yes). Money-MOVEMENT (stepUp) and tier-3
      // (human-only) stay OUT of the agent's reach entirely.
      (actionRisk(a) <= 1 || a.confirm != null) &&
      !a.stepUp &&
      actionRisk(a) < 3,
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
