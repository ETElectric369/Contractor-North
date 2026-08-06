import { parseInspectionSchema, type InspectionField } from "@/lib/inspection/schema";
import type { Need, NeedSlot, Playbook } from "./types";

/**
 * EVERY EXISTING SHEET IS ALREADY A PLAYBOOK — it just only knows how to say the closed half.
 *
 * This is the bridge, and it is what makes the whole migration boring: a `forms.schema` written in
 * 2026-07 keeps working, unchanged, through every phase. A sheet field is a need with a slot; the
 * open needs are the part nobody could express before.
 *
 * NOTHING IS INVENTED HERE. The one judgement call is `ask`, and it is a formatting rule rather
 * than a guess — see below. A conversion that quietly improved somebody's questions would be a
 * conversion nobody could trust, and the first time it got one wrong the contractor would be
 * standing at a job wondering why the app was asking him something he never wrote.
 */

/** A field's type maps 1:1 onto a slot. The old five types are all closed by definition. */
function slotFor(f: InspectionField): NeedSlot {
  switch (f.type) {
    case "number":
      return { type: "number" };
    case "select":
      // Single-valued, because that is what the stored sheet meant. A contractor who wants
      // "outlets AND lights" turns multi on deliberately — we do not decide it for him.
      return { type: "select", options: f.options ?? [] };
    case "checkbox":
      // A checkbox is a two-option select wearing a smaller coat, and saying so out loud is what
      // stops "Permit needed" from being answerable only as yes-or-silence. It is also the field
      // that vanished at 13125 Moraine Rd and got recorded as "no" — a shape that could not hold
      // "the homeowner is pulling one, for occupancy".
      return { type: "select", options: ["Yes", "No"] };
    case "textarea":
      return { type: "text", long: true };
    default:
      return { type: "text" };
  }
}

/**
 * The label, turned into something a person could be ASKED.
 *
 * Deliberately mechanical. A label that is already a question keeps its own words; one that reads
 * like a heading gets a question mark and nothing else. ET's sheet has a field labelled "Panel" —
 * this makes it "Panel?", which is still a poor question, and that is the honest outcome: the
 * conversion does not pretend to know what he meant by it. The playbook editor is where he writes
 * the real sentence, and until he does the app asks exactly what his sheet always asked.
 */
export function askFromLabel(label: string): string {
  const t = label.trim();
  if (!t) return "";
  if (/[?？]$/.test(t)) return t;
  if (/^(what|where|when|who|why|how|is|are|do|does|did|can|will|any|should)\b/i.test(t)) return `${t}?`;
  return `${t}?`;
}

/** One sheet field → one closed need, rule and all. */
export function needFromField(f: InspectionField): Need {
  return {
    key: f.key,
    label: f.label,
    ask: askFromLabel(f.label),
    slot: slotFor(f),
    // showIf is one clause; `when` is the array that can hold several. Widening a single rule into
    // a one-element list changes nothing about when it fires.
    ...(f.showIf ? { when: [{ key: f.showIf.key, in: f.showIf.in }] } : {}),
    ...(f.measured ? { measured: true } : {}),
  };
}

/** A stored `forms.schema` → a playbook. Tolerant: the parser already drops what it can't read. */
export function playbookFromSheet(raw: unknown): Playbook {
  return { needs: parseInspectionSchema(raw).map(needFromField) };
}

/**
 * A playbook → a sheet, for anything still reading the old shape.
 *
 * OPEN NEEDS ARE DROPPED, on purpose and without apology: a sheet has no way to render a question
 * that has no control, so emitting one would produce a field that renders as an empty text box
 * with a heading — furniture, which is the exact thing this whole design removes. A reader wanting
 * the open needs should read the playbook.
 */
export function sheetFromPlaybook(pb: Playbook): InspectionField[] {
  const out: InspectionField[] = [];
  for (const n of pb.needs) {
    if (!n.slot) continue;
    // A `file` need has no equivalent in the OLD sheet shape, so it is simply not exported back
    // to one — a sheet that claimed a file question was a text box would lose the uploads.
    if (n.slot.type === "file") continue;
    const type =
      n.slot.type === "number" ? "number" : n.slot.type === "select" ? "select" : n.slot.long ? "textarea" : "text";
    out.push({
      key: n.key,
      label: n.label,
      type,
      ...(n.slot.type === "select" ? { options: n.slot.options } : {}),
      // Only a single-clause rule survives the trip. A multi-clause need becomes UNCONDITIONAL
      // rather than half-gated: showing a question too often is a nuisance, hiding it on a rule
      // the old engine can't evaluate is a question nobody knows they were meant to answer.
      ...(n.when?.length === 1 && "in" in n.when[0] ? { showIf: { key: n.when[0].key, in: n.when[0].in } } : {}),
      ...(n.measured ? { measured: true } : {}),
    });
  }
  return out;
}
