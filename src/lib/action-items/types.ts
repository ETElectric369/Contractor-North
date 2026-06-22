// The unified "actionable item" model — the action-layer twin of <ModalActions>.
// Every surface (tasks, jobs to schedule, inquiries, appointments, captures to
// file) projects onto ONE shape with ONE set of canonical verbs, so a single
// list component and a single voice registry can act on all of them.

export type ActionKind =
  | "task" // an open to-do
  | "work_order" // an open to-do tied to a job
  | "job_to_schedule" // a job with no date yet
  | "inquiry" // a new/uncontacted lead
  | "appointment" // a scheduled appt awaiting completion
  | "organize" // a capture (receipt/note/doc) needing a filing decision
  | "invoice_overdue" // a sent/partial invoice past its due date (A/R)
  | "lien_deadline" // a lien prelim/recording deadline coming due or past
  | "contract_unsigned"; // a contract sent but not yet signed

/** The canonical verbs. Each maps to an existing server action in dispatch.ts. */
export type Affordance =
  | "do" // mark complete / contacted
  | "schedule" // put on the calendar / pick a date
  | "assign" // give to a person
  | "convert" // advance the pipeline (inquiry → estimate/job, capture → filed)
  | "snooze" // defer to a later date
  | "dismiss" // remove from my list (delete / cancel / archive)
  | "open"; // drill into the detail page

export interface ActionItem {
  id: string;
  kind: ActionKind;
  title: string;
  subtitle?: string | null; // customer / job / vendor line
  who?: string | null; // assignee name
  when?: string | null; // ISO or yyyy-mm-dd (due/follow-up/starts/null)
  urgency: 0 | 1 | 2; // 0 normal · 1 soon/overdue · 2 urgent
  done: boolean; // drives the universal "sinks to the bottom" rule
  href: string; // deep link for Open
  affordances: Affordance[]; // canonical verbs valid for THIS item
}

export const KIND_META: Record<ActionKind, { label: string; tone: "slate" | "blue" | "amber" | "green" }> = {
  task: { label: "Task", tone: "slate" },
  work_order: { label: "Job task", tone: "blue" },
  job_to_schedule: { label: "To schedule", tone: "amber" },
  inquiry: { label: "Inquiry", tone: "green" },
  appointment: { label: "Appointment", tone: "blue" },
  organize: { label: "To file", tone: "slate" },
  invoice_overdue: { label: "Overdue invoice", tone: "amber" },
  lien_deadline: { label: "Lien deadline", tone: "amber" },
  contract_unsigned: { label: "Unsigned contract", tone: "blue" },
};

// The affordance matrix — which verbs each kind exposes. THE contract, consumed
// by both the UI (<ActionList>) and (later) the voice registry. (Assign/Convert
// land in a follow-up step with inline pickers.)
export const AFFORDANCES: Record<ActionKind, Affordance[]> = {
  task: ["do", "schedule", "assign", "snooze", "dismiss", "open"],
  work_order: ["do", "schedule", "assign", "dismiss", "open"],
  job_to_schedule: ["schedule", "assign", "open"],
  inquiry: ["do", "schedule", "convert", "snooze", "dismiss", "open"],
  appointment: ["do", "dismiss", "open"],
  organize: ["dismiss", "open"],
  // Money/legal items drill into their own surface to act (record a payment, serve a
  // notice, chase a signature) — no generic "do"/"dismiss" that would mislabel them.
  invoice_overdue: ["open"],
  lien_deadline: ["open"],
  contract_unsigned: ["open"],
};

/**
 * THE universal ordering rule, applied in one place so every surface inherits
 * it: not-done before done ("checked boxes go to the bottom"), then by urgency
 * (high first), then soonest scheduled time first (undated last). Stable.
 */
export function sortActionItems(items: ActionItem[]): ActionItem[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      if (a.it.done !== b.it.done) return a.it.done ? 1 : -1;
      if (a.it.urgency !== b.it.urgency) return b.it.urgency - a.it.urgency;
      const aw = a.it.when ? Date.parse(a.it.when) : Infinity;
      const bw = b.it.when ? Date.parse(b.it.when) : Infinity;
      if (aw !== bw) return aw - bw;
      return a.i - b.i; // stable
    })
    .map(({ it }) => it);
}
