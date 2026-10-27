import { laborRateFor, type LaborRateFrom } from "@/lib/pricing/labor-rate";
import type { DraftLineItem, TaskLabor } from "./line-map";
import { lineFromDetail, repriceTaskLine } from "./task-lines";

/**
 * THE LABOR ROWS BEHIND THE BUILDER'S TWO DOORS (cn-v1131): the rule effect, which re-prices every
 * task line when the rule's inputs move, and the Who select, which re-asks the rule for a row.
 *
 * repriceTaskLine knows ONE figure — the rule's answer for a row that names nobody. A row that names
 * a person has another (their Team rate, held under the customer's level), so after that pass every
 * "rule" row with a person asks the rule again with them on top. The builder used to key its effect
 * on the nobody figure alone, so a person's rate could move while that figure did not (a level rate
 * equal to the default) and a person's row stayed where it was. Now the effect is keyed on EVERY
 * input (ruleInputsKey) and runs this one pass, which is pure and tested on its own.
 *
 * A typed ("hand") or dictated ("stated") rate is HIS and is not touched by either door: the Who
 * select used to overwrite it when he picked a person or Labor.
 */
export interface RuleInputs {
  /** The customer's pricing-level labor rate, when the level has one. */
  levelRate?: number | string | null;
  /** The company default (Settings' default labor rate). */
  orgDefault?: number | string | null;
  /** The team with their bill rates, for a row that names a person. */
  people?: ReadonlyArray<{ id: string; billRate: number | string | null }>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The rule's answer for whoever a row names: the person on top when the row names one the team
 *  still has; a person who left prices at the rule's no-person answer. */
export function rowRule(personId: string | null, now: RuleInputs): { rate: number; from: LaborRateFrom } {
  const person = personId ? now.people?.find((p) => p.id === personId) : undefined;
  return laborRateFor({ personRate: person?.billRate, levelRate: now.levelRate, orgDefault: now.orgDefault });
}

/** One string that changes when ANY input of the rule does — what the builder keys its effect on, so a
 *  person's rate moving under an unchanged level or default still re-prices their rows. */
export function ruleInputsKey(now: RuleInputs): string {
  const n = (v: number | string | null | undefined): string => (v == null || v === "" ? "" : String(Number(v)));
  return `${n(now.levelRate)}|${n(now.orgDefault)}|${(now.people ?? []).map((p) => `${p.id}:${n(p.billRate)}`).join(",")}`;
}

/**
 * THE RE-PRICE PASS. A "rule" row takes the rule's answer for whoever it names; a "legacy" row (read
 * from the old one-figure shape, which never said whose figure it was) follows only while its rate
 * still equals the rule's PREVIOUS no-person answer; a "hand" or "stated" row stands. The parts keep
 * the sell they were built with. A line with no breakdown is returned as it is.
 */
export function repriceRows(line: DraftLineItem, now: RuleInputs, prevRule: number): DraftLineItem {
  if (!line.detail) return line;
  const first = repriceTaskLine(line, rowRule(null, now).rate, prevRule);
  const d = first.detail!;
  const labor = d.labor.map((r) => {
    if (!r.person_id || r.rate_from !== "rule") return r;
    const own = round2(rowRule(r.person_id, now).rate);
    return own === r.rate ? r : { ...r, rate: own };
  });
  return labor.some((r, i) => r !== d.labor[i]) ? lineFromDetail(first, { ...d, labor }) : first;
}

/**
 * A WHO PICK ON A ROW: a person, nobody ("Labor"), or his own word ("Other…", with the word he may
 * already have typed). A "rule" or "legacy" row asks the rule again for whoever is named now and is a
 * "rule" row from here; a typed or dictated rate stands — he set it, and who does the hours is a
 * separate question from what they cost.
 */
export function rowForWho(row: TaskLabor, who: { personId: string | null; label: string | null }, now: RuleInputs): TaskLabor {
  const keeps = row.rate_from === "hand" || row.rate_from === "stated";
  const named: TaskLabor = { ...row, person_id: who.personId, label: who.label };
  return keeps ? named : { ...named, rate: round2(rowRule(who.personId, now).rate), rate_from: "rule" };
}
