import type { Playbook } from "@/lib/playbook/types";

/**
 * DRAFTING SOMEBODY'S WHY LINES SO THEY HAVE SOMETHING TO ARGUE WITH.
 *
 * Erik: "part of the onboarding is to guide them and explain how to craft their own why lines
 * based off of suggestions created from their interview … an onboarding interview with built in
 * training rather than a tutorial."
 *
 * THE TEACHING MECHANISM IS CORRECTION, NOT EXPLANATION. Nobody writes a good `why` from a blank
 * box and an instruction — a why is a judgement about what a wrong answer costs, and you only
 * discover you have one when you read a version that is slightly wrong. So Nort drafts every line
 * in their trade's terms from what they just said about their business, and the training is them
 * going "no, that's not why I ask that."
 *
 * WHICH IS WHY THE DRAFT MUST BE HONEST ABOUT BEING A DRAFT. Erik's own playbook file says it
 * best: "Where a line quotes him, it quotes him. Where it reasons about the trade, that reasoning
 * is mine and he should cut it — an inference dressed as his own judgement is worse than a blank."
 * The prompt says exactly that, and the UI says it too.
 *
 * IT DRAFTS PROSE ONLY. Keys, slots, options and rules come from their existing sheet and are
 * passed through untouched — the model is never given the chance to invent a question, only to
 * phrase one and say why it is worth asking. That keeps the whole thing inside the determinism
 * boundary: unstructured out of a structure that was already decided.
 */

export const DRAFT_SYSTEM =
  "You are helping a contractor write the walk-through questions his own app will ask him on a " +
  "job site, and — more importantly — the REASON behind each one.\n\n" +
  "You will be given his trade, what he told you about his business, and the questions he already " +
  "has. For each question, return two things:\n\n" +
  "  ask — the question as a person would SAY it out loud, on site, to another human. Not a form " +
  "label. 'Panel' is not a question. 'What's the panel — brand, size, any room in it?' is.\n" +
  "  why — what a WRONG OR MISSING answer costs him, in his trade's own terms. Money, a second " +
  "trip, a code problem, a job he shouldn't have quoted. Concrete, specific to the trade, and " +
  "written the way a tradesman talks — not marketing, not a definition of the field.\n\n" +
  "RULES:\n" +
  "- NEVER invent, remove, merge or reorder questions. You get a list of keys; return exactly " +
  "those keys, no more, no fewer. You are writing prose for questions somebody else chose.\n" +
  "- Write the why as a DRAFT HE WILL CUT. Two or three sentences at most. If you are guessing " +
  "about his trade, guess plainly and briefly so the wrong parts are easy to spot — an inference " +
  "dressed up as his own judgement is worse than a blank line.\n" +
  "- Use what he actually told you. If he said he subs out electrical, do not write a why that " +
  "assumes he pulls his own wire.\n" +
  "- Never mention this app, 'the system', or the software. He is describing his trade, not ours.\n\n" +
  'Return ONLY a JSON object: { "needs": [ { "key": "...", "ask": "...", "why": "..." } ] }.';

/** The questions he already has, described for drafting — keys and shape only, never our prose. */
export function draftRequest(pb: Playbook, about: string): string {
  const lines = pb.needs.map((n) => {
    const bits = [`- key: ${n.key}`, `  currently called: ${n.label}`];
    if (n.slot?.type === "select") bits.push(`  he picks one of: ${n.slot.options.join(" | ")}`);
    else if (n.slot?.type === "number") bits.push(`  a number${n.slot.unit ? ` in ${n.slot.unit}` : ""}`);
    else if (n.slot) bits.push("  he types it");
    else bits.push("  he says it in his own words");
    if (n.measured) bits.push("  measured on site — this number feeds a price");
    if (n.why) bits.push(`  his existing reason (IMPROVE, do not discard): ${n.why}`);
    return bits.join("\n");
  });
  return `ABOUT HIM:\n${about}\n\nHIS QUESTIONS:\n${lines.join("\n")}`;
}

/** Merge drafted prose onto the real playbook. Structure is never taken from the model. */
export function applyDraft(pb: Playbook, raw: unknown): Playbook {
  const src = (raw as { needs?: unknown } | null)?.needs;
  const byKey = new Map<string, { ask?: string; why?: string }>();
  if (Array.isArray(src))
    for (const r of src) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const key = typeof o.key === "string" ? o.key.trim() : "";
      if (!key) continue;
      byKey.set(key, {
        ask: typeof o.ask === "string" ? o.ask.trim().slice(0, 300) : undefined,
        why: typeof o.why === "string" ? o.why.trim().slice(0, 2000) : undefined,
      });
    }
  // Every need survives, in order, with its key/slot/rules exactly as they were. A key the model
  // invented has nothing to attach to and is simply never looked up.
  return {
    needs: pb.needs.map((n) => {
      const d = byKey.get(n.key);
      return { ...n, ...(d?.ask ? { ask: d.ask } : {}), ...(d?.why ? { why: d.why } : {}) };
    }),
  };
}

/** What he told the setup interview, as a paragraph the drafter can read. */
export function aboutFromSetup(a: Record<string, unknown>): string {
  const bits: string[] = [];
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
  if (s("trade")) bits.push(`Trade: ${s("trade")}`);
  if (s("city")) bits.push(`Based in: ${s("city")}`);
  if (s("service_area")) bits.push(`Covers: ${s("service_area")}`);
  if (typeof a.labor_rate === "number" && a.labor_rate > 0) bits.push(`Bills $${a.labor_rate}/hr for labor`);
  return bits.length ? bits.join("\n") : "A contractor. Nothing else known yet.";
}
