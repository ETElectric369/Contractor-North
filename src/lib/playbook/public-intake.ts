import type { Need, NeedSlot, Playbook } from "./types";

/**
 * THE CUSTOMER-FACING SLICE OF A PLAYBOOK — what a homeowner sees, and nothing else.
 *
 * Erik: "since the inspector will be doing the job of collecting information we need a playbook
 * for that or is it built in?" The ENGINE is built in — resolver, slots, when-rules, renderer.
 * What must never be built in is the leak: a walk-through playbook carries `why` (where the
 * answer lands in his price) and `note` (his war stories and asking rules). Those are the
 * contractor's pricing logic, and a public page that renders them hands his estimating method to
 * every competitor with a browser. Same law as public-RPC projection parity: THE FAILURE IS
 * ALWAYS A SELECT LIST — so the projection is an explicit allowlist of fields, not an omit-list,
 * and a field added to Need tomorrow stays private until somebody deliberately ships it here.
 */
export interface PublicNeed {
  key: string;
  label: string;
  ask: string;
  slot?: NeedSlot;
  when?: Need["when"];
}

/** Allowlist projection. `why`, `note`, `feeds`, `hold`, `measured` never cross this line. */
export function publicIntakeNeeds(pb: Playbook): PublicNeed[] {
  return pb.needs.map((n) => ({
    key: n.key,
    label: n.label,
    ask: n.ask,
    ...(n.slot ? { slot: n.slot } : {}),
    ...(n.when ? { when: n.when } : {}),
  }));
}

/**
 * THE STARTER INTAKE — five questions a customer can actually answer, seeded when the org flips
 * the door on. Deliberately small: every public question is friction, and the walk-through will
 * re-ask anything that matters once a human is involved. Slots on EVERY need — there is no Nort
 * on the public page (v1), so an open need would render nothing.
 *
 * "Do you have plans?" gates its follow-up with a `when` clause — the conditional reveal Andrew
 * asked for, built from machinery the playbook already had. (The file upload he also asked for is
 * a separate build — a `file` slot type — and this question is written to work without it.)
 */
export const INTAKE_STARTER: Playbook = {
  needs: [
    {
      key: "describe",
      label: "The project",
      ask: "What would you like done? Tell us in your own words.",
      slot: { type: "text", long: true },
    },
    {
      key: "timeline",
      label: "Timeline",
      ask: "When are you hoping to have it done?",
      slot: { type: "select", options: ["As soon as possible", "In the next few weeks", "In the next few months", "Just planning ahead"] },
    },
    {
      key: "budget",
      label: "Budget",
      ask: "Do you have a budget range in mind?",
      slot: { type: "select", options: ["Under $5,000", "$5,000 – $15,000", "$15,000 – $50,000", "Over $50,000", "Not sure yet"] },
    },
    {
      key: "has_plans",
      label: "Plans",
      ask: "Do you already have plans or drawings?",
      slot: { type: "select", options: ["Yes", "No"] },
    },
    {
      key: "plans_detail",
      label: "About the plans",
      ask: "Tell us about them — who drew them, and are they approved?",
      slot: { type: "text", long: true },
      when: [{ key: "has_plans", in: ["Yes"] }],
    },
  ],
};
