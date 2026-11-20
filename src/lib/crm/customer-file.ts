import { leadStage, type LeadStage, type StandingRead } from "@/lib/leads/new-intake";
import type { FileVisitRow } from "@/lib/appointments/file-visit";

/**
 * THE CUSTOMER'S FILE KEEPS THE REQUEST AND THE INSPECTION (cn-v1171). Erik, 2026-11-19: "won converts
 * everything into the customer file keeping the inspection, estimates, work, invoices and everything".
 * The customer's page (crm/[id]) reads these columns for its Requests and Inspections tabs. No money
 * column in either.
 */

/** A customer's leads: `inquiries.customer_id = id`. */
export const CUSTOMER_REQUEST_COLUMNS = "id, name, message, source, status, converted_to, converted_at, created_at";

/** A customer's inspections: theirs by `customer_id`, or made from one of their leads by `inquiry_id`
 *  (a won lead's visit often carries no customer). */
export const CUSTOMER_VISIT_COLUMNS = "id, type, status, outcome, starts_at, title, inquiry_id";

export type CustomerRequest = {
  id: string;
  name: string | null;
  message: string | null;
  source: string | null;
  status: string | null;
  converted_to: string | null;
  converted_at: string | null;
  created_at: string;
};

export type CustomerVisit = FileVisitRow & { inquiry_id: string | null };

/** A request's line: the first line of its scope, else the lead's name. */
export function requestLine(r: Pick<CustomerRequest, "message" | "name">): string {
  const first = String(r.message ?? "")
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  return first || String(r.name ?? "").trim();
}

/** Each request's stage by the Leads list's own rule. A lead whose visits could not be read is in
 *  neither set, so it reads open (offered, never hidden), as it does on the list. */
export function requestStages(requests: readonly CustomerRequest[], read: StandingRead): Map<string, LeadStage> {
  return new Map(requests.map((r) => [r.id, leadStage(r, read.standing.has(r.id))]));
}

/** A request still in play, for the Requests tab's count: on the Leads list, or with a visit standing
 *  (a badge counts only what is open, tests/badges-show-open). */
export function isOpenRequest(stage: LeadStage | undefined): boolean {
  return stage === "open" || stage === "standing";
}
