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
  "task.setFocus", // pin/unpin into a day's six ("do this today", the debrief's tomorrow picks) — reversible tier-1
  "task.assign",
  // Bulk triage (T2): sweep MANY open tasks in one confirmed verb ("push all follow-ups to
  // Monday", "clear everything about ZZ TEST"). Staff-only + confirm-gated (the describe
  // names the filter in plain words) + bounded server-side (>100 matches refuses), so one
  // yes can never silently mow down the whole org's list.
  "task.bulkComplete",
  "task.bulkReschedule",
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
  // Fix ANOTHER crew member's entry — close an open shift, correct times/lunch/job
  // ("Brian left at 4:30"). Staff-gated + confirm:"financial" (it edits a wage record),
  // so the filter below admits it as a confirm-gated tier-2: propose → user says yes.
  "time.fixEntry",
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
  "job.move", // shift ONE scheduled range to a new day — read-modify-write, other ranges kept
  "job.proposeDates", // draft a customer pick-a-date link (creates it; SENDS nothing itself)
  "job.assign",
  "job.setScope",
  // Field capture: a hands-busy voice note + on-site price-list capture + receipt triage.
  "organize.saveNote",
  "organize.review",
  "organize.billReceipt", // confirm-gated (creates a job cost)
  "pricelist.add",
  // The last filaments: move a quote down the funnel, draft a contract.
  "quote.setStatus",
  "quote.setType", // switch a doc between estimate (T&M) and fixed-price quote
  "quote.attachJob", // pin a saved estimate to a job ("leave it with the job") — reversible link
  "quote.setCustomer", // attach/fix the customer on a saved quote without re-creating it
  "quote.convertToJob",
  "contract.generate",
  "form.submit", // fill a checklist by voice
  // Sublinking: put a sub/supplier/inspector on a job (and remove). The contact book + the
  // many-to-many job_contacts, by voice — "add Joe's plumbing to the Miller job".
  "job.linkContact",
  "job.unlinkContact",
  // Progress billing: define a draw schedule + draft the next draw (confirm-gated).
  "payment.setSchedule",
  "payment.requestNext",
  // Bug-watch: CIB can triage its own bug list (mark fixed / won't-fix) — and FILE one.
  // bug.report is auth:"any" so every role gets it; it closes the list-but-can't-file hole.
  "bug.resolve",
  "bug.report",
  // The one-field front door: any fragment → a private needs_review stub in the
  // review inbox. Pure local insert (no AI call, nothing sent, no money) — tier-1,
  // open to every role, so Nort can always "just write that down".
  "capture.quick",
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
        properties: to2020(schema.properties ?? {}) as Record<string, unknown>,
        required: schema.required ?? [],
      },
    };
  });
  return { tools, resolve: (toolName: string) => map.get(toolName) ?? null };
}

/**
 * Anthropic validates tool input_schema against JSON Schema draft 2020-12, but
 * zod-to-json-schema's openApi3 target emits draft-4-style BOOLEAN
 * exclusiveMinimum/exclusiveMaximum (e.g. z.number().positive() →
 * { minimum: 0, exclusiveMinimum: true }) — ONE such keyword anywhere in the
 * tool array 400s the ENTIRE chat request (this took Nort down: tools.84,
 * time.addEntry's hours>0). Convert to the 2020-12 numeric form everywhere.
 * (Unknown keywords like openApi3's `nullable` are legal 2020-12 annotations
 * and pass through untouched.)
 */
function to2020(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(to2020);
  if (!node || typeof node !== "object") return node;
  const o: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  if (o.exclusiveMinimum === true && typeof o.minimum === "number") {
    o.exclusiveMinimum = o.minimum;
    delete o.minimum;
  } else if (typeof o.exclusiveMinimum === "boolean") delete o.exclusiveMinimum;
  if (o.exclusiveMaximum === true && typeof o.maximum === "number") {
    o.exclusiveMaximum = o.maximum;
    delete o.maximum;
  } else if (typeof o.exclusiveMaximum === "boolean") delete o.exclusiveMaximum;
  for (const k of Object.keys(o)) o[k] = to2020(o[k]);
  return o;
}
