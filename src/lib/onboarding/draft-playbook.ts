import { askFromLabel } from "@/lib/playbook/from-sheet";
import { WHY_ASK, whyHint } from "@/lib/playbook/why";
import type { Need, Playbook } from "@/lib/playbook/types";

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
  "You are helping a contractor write the walk-through questions his own app will ask him on a job " +
  "site, and — more importantly — WHERE EACH ANSWER ENDS UP IN HIS PRICE.\n\n" +
  "For each question, return two things:\n\n" +
  "  ask — the question as a person would SAY it out loud, on site, to another human. Not a form " +
  "label. 'Panel' is not a question. \"What's the panel — brand, size, any room in it?\" is.\n" +
  "  why — THE PATH FROM THE ANSWER TO THE NUMBER. Not a justification, not a story about what goes " +
  "wrong. State where the answer LANDS in his estimate. It takes one of three shapes:\n" +
  "      A CALCULATION — \"Length × width is the square footage, and that drives the board count.\"\n" +
  "      A FORK        — \"Decides subpanel or home runs, which sets every run length after it.\"\n" +
  "      A TRIGGER     — \"Permitted means an inspection before cover — that's a second trip.\"\n\n" +
  "RULES FOR THE WHY, AND THEY ARE THE WHOLE JOB:\n" +
  "- ONE SENTENCE. Two at the absolute most. If it needs a paragraph you have written a story " +
  "instead of a path. A contractor reviewing fifteen of these has to be able to read each in about " +
  "three seconds.\n" +
  "- IT MUST NAME A DESTINATION — a number it feeds, a decision it settles, or work it switches on. " +
  "A line that says the question is important and nothing else is worthless.\n" +
  "- WRITE IT THE WAY HE'D SAY IT ON THE PHONE. Short, blunt, no commas stacked up. \"Tells me how " +
  "much wire.\" is a better line than three clauses about conduit fill.\n" +
  "- NEVER RESTATE THE QUESTION. \"I need to know the panel brand\" is the question said backwards " +
  "and carries nothing.\n" +
  "- If it is a number, say the ARITHMETIC — what it multiplies with and what comes out. That is the " +
  "most useful kind, because a machine can act on it.\n\n" +
  "OTHER RULES:\n" +
  "- NEVER invent, remove, merge or reorder questions. You get a list of keys; return exactly those " +
  "keys, no more, no fewer. You are writing prose for questions somebody else chose.\n" +
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

/**
 * Merge drafted prose onto the real playbook. Structure is never taken from the model.
 *
 * AND A WHY SOMEBODY ALREADY WROTE IS NEVER OVERWRITTEN — enforced here, in code, not asked for in
 * the prompt. Same law as the provenance gate and as applyFills: FILL HOLES, NEVER OVERWRITE A
 * HAND. Erik's own playbook carries fifteen long why lines written from his own words; a
 * walk-through that quietly reworded them would destroy the exact thing this whole build exists to
 * capture, and he'd have to read fifteen paragraphs closely to notice. Blank lines get drafted;
 * written ones get read, which is training enough.
 */
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
      const mine = !!n.why?.trim();
      return {
        ...n,
        // An ask they already wrote is theirs too — only a mechanical one (a label with a question
        // mark bolted on) is worth replacing, and a need with a real why is a need they've been
        // through. Leave the whole thing alone.
        // …and now the code actually TESTS "mechanical" (audit 8): it replaced any ask whose
        // need had no why, so a contractor who reworded three questions in his own voice and
        // wrote no why lines lost that wording the next time he re-took the walk-through.
        ...(d?.ask && !mine && n.ask.trim() === askFromLabel(n.label).trim() ? { ask: d.ask } : {}),
        ...(d?.why && !mine ? { why: d.why } : {}),
      };
    }),
  };
}

/**
 * WHAT NORT SAYS ABOUT ONE WHY LINE, standing on it, out loud.
 *
 * Erik: "explain every little step of the why files as we go through it together because people
 * aint gonna get it i guarantee it."
 *
 * A list of fifteen textareas teaches nobody anything — it is a form, and a form about an idea
 * somebody has not met yet is worse than no form. So the walk is one at a time, and each one says
 * the same three things in order: WHAT this question is for, WHAT the drafted reason claims, and
 * WHAT to do about it. By the third or fourth the shape is obvious, which is the point at which
 * somebody can write their own — and that is the only definition of "taught" that matters here.
 */
export function explainWhy(n: Need, i: number, total: number): string {
  const { shape } = whyHint(n);
  const opener =
    i === 0
      ? "Here's the first one. One at a time, and this is quick. "
      : i === total - 1
        ? "Last one. "
        : "";
  // Two flags worth one clause each, because they change what the answer DOES rather than what it
  // means. Both used to overstate: `measured` claimed "I do the arithmetic myself" (nothing derives
  // an answer from another — hear.ts:41 forbids it in terms) and `hold` claimed to block pricing
  // (holdingNeeds, resolve.ts:95, has no caller and "Start the estimate" is an unguarded link).
  // A flag that says it stops you, and doesn't, teaches somebody to ignore the next flag too.
  const tail = n.measured
    ? " That one's a number — it goes straight into a price."
    : n.hold
      ? " That one gets a 'before you price it' flag so it can't hide — nothing stops you starting the estimate without it."
      : "";
  const drafted = n.why?.trim();
  // ASK HIM, don't lecture him. The draft is a thing to agree with or correct in three seconds —
  // reading a paragraph at somebody and then inviting edits is how fifteen of these became
  // homework. If there's no draft, the question stands on its own and the shape shows him the form.
  return drafted
    ? `${opener}"${n.ask}" — I've got that landing here: ${drafted} That right?${tail}`
    : `${opener}"${n.ask}" — ${WHY_ASK} Something like: "${shape.example}"${tail}`;
}

/** What we know about them from the setup card, as prose the drafter can reason from. */
export function aboutFromSetup(a: Record<string, unknown>): string {
  const bits: string[] = [];
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
  if (s("trade")) bits.push(`Trade: ${s("trade")}`);
  if (s("city")) bits.push(`Based in: ${s("city")}`);
  if (s("service_area")) bits.push(`Covers: ${s("service_area")}`);
  if (typeof a.labor_rate === "number" && a.labor_rate > 0) bits.push(`Bills $${a.labor_rate}/hr for labor`);
  return bits.length ? bits.join("\n") : "A contractor. Nothing else known yet.";
}
