import { coerceByPlaybook } from "@/lib/playbook/answers";
import { clearInapplicable, isAnswered } from "@/lib/playbook/resolve";
import { extOf, uploadDisplayName } from "@/lib/playbook/uploads";
import type { AnswerValue, Answers, Playbook } from "@/lib/playbook/types";

/**
 * THE PRELIMINARY WALK-THROUGH REPORT, read from the customer's own plans.
 *
 * Erik + Andrew, 8/21: "have Nort process any lead that comes in to have a preliminary inspection
 * report ready to go for the boss ... all of that information ready in the inspector, for us to
 * edit and expand on." A lead that arrives with a plan set used to sit unread until someone fed
 * it to the estimator by hand; the inspector — the surface that actually collects a job's facts —
 * never saw it at all.
 *
 * This module is the PURE half: the brief's shape, its tolerant parse, its clamps, and the filter
 * that turns the model's raw answers into ones the walk-through playbook accepts. The server
 * runner (plan-brief-run.ts) does the reading; every surface (lead row, inspector, carry) reads
 * through here.
 *
 * The brief lives INSIDE `inquiries.intake` (key `plan_brief`) — deliberately not a column. The
 * intake jsonb already rides to every surface that needs it (the leads board reads *, and the
 * estimate/job/walk-through pages carry `inquiry.intake` since cn-v759), so no projection ever
 * has to remember it exists.
 *
 * PROVENANCE LAW: everything here is a MACHINE's reading of a document. The customer's own
 * answers always win over the brief's (layerBriefAnswers), the human hand always wins over both
 * (fill holes, never overwrite), and every surface that shows a brief answer says where it came
 * from. Measured needs ARE allowed — a dimensioned architect's sheet is the one document a
 * measurement legitimately comes from before anyone pulls a tape — but they carry the same
 * "verify on site" flag as everything else.
 */

export type PlanBriefStatus = "pending" | "ready" | "failed" | "skipped";

export interface PlanBriefSkip {
  name: string;
  reason: string;
}

export interface PlanBrief {
  v: 1;
  status: PlanBriefStatus;
  /** ISO timestamp of the last attempt (start for pending, finish otherwise). */
  at: string;
  model?: string;
  /** Intake storage paths that were actually read. */
  files: string[];
  skipped: PlanBriefSkip[];
  summary?: string;
  scope_included?: string[];
  scope_excluded?: string[];
  /** Typed to the org's walk-through playbook — already coerced, sparse. */
  answers?: Answers;
  /** Concrete details the plans show that no playbook question asks. */
  observations?: string[];
  /** What to verify on site — ambiguities, conflicts, dense sheets. */
  cautions?: string[];
  error?: string;
}

/** Clamps — a brief is a briefing, not a transcription. */
export const BRIEF_LIMITS = {
  summary: 1200,
  listItems: 12,
  itemChars: 300,
  /** Total plan bytes per reading. Base64 inflates ~33% and the API ceiling is 32MB. */
  readBudgetBytes: 19 * 1024 * 1024,
} as const;

const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, BRIEF_LIMITS.itemChars))
        .filter(Boolean)
        .slice(0, BRIEF_LIMITS.listItems)
    : [];

/** Tolerant read of `intake.plan_brief` — bad or missing shapes are simply no brief. */
export function parsePlanBrief(intake: unknown): PlanBrief | null {
  const raw = (intake as { plan_brief?: unknown } | null)?.plan_brief;
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const status = String(b.status ?? "");
  if (!["pending", "ready", "failed", "skipped"].includes(status)) return null;
  return {
    v: 1,
    status: status as PlanBriefStatus,
    at: typeof b.at === "string" ? b.at : "",
    model: typeof b.model === "string" ? b.model : undefined,
    files: Array.isArray(b.files) ? b.files.filter((f): f is string => typeof f === "string") : [],
    skipped: Array.isArray(b.skipped)
      ? b.skipped
          .filter((s): s is { name?: unknown; reason?: unknown } => !!s && typeof s === "object")
          .map((s) => ({ name: String(s.name ?? ""), reason: String(s.reason ?? "") }))
      : [],
    summary: typeof b.summary === "string" ? b.summary : undefined,
    scope_included: strList(b.scope_included),
    scope_excluded: strList(b.scope_excluded),
    answers: b.answers && typeof b.answers === "object" ? (b.answers as Answers) : undefined,
    observations: strList(b.observations),
    cautions: strList(b.cautions),
    error: typeof b.error === "string" ? b.error : undefined,
  };
}

/**
 * The model's raw answers → ones the walk-through accepts.
 *
 * Same spine as answersFromIntake (coerce against the walk-through's own playbook, drop unknown
 * keys, drop scopes/file slots, sparse output) with ONE deliberate difference: `measured` needs
 * are KEPT. A customer may answer a question but never take a measurement — a plan sheet is the
 * opposite case: its dimensions are the architect's, exactly what a take-off reads, and the
 * provenance note plus the inspector's own editability are the check on a misread.
 */
export function answersFromBrief(pb: Playbook, raw: unknown): Answers {
  if (!pb.needs.length || !raw || typeof raw !== "object") return {};
  const coerced = coerceByPlaybook(pb, raw);
  const kept: Answers = {};
  for (const n of pb.needs) {
    if (n.slot?.type === "scopes" || n.slot?.type === "file") continue;
    const v = coerced[n.key];
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    kept[n.key] = v;
  }
  return kept;
}

/**
 * Layer the brief's answers UNDER the customer's own for the walk-through seed.
 *
 * The customer answered questions in their own words; the brief is a machine's reading of their
 * documents. Where both speak, the person wins. Returns the merged answers plus the labels of
 * needs the brief alone filled — the caller says those out loud in the appointment's notes, the
 * same way carriedNote names the customer's.
 */
export function layerBriefAnswers(
  pb: Playbook,
  customerAnswers: Answers,
  briefAnswers: Answers,
): { answers: Answers; briefCarried: string[] } {
  const answers: Answers = { ...briefAnswers, ...customerAnswers };
  const briefCarried = pb.needs
    .filter((n) => briefAnswers[n.key] != null && customerAnswers[n.key] == null)
    .map((n) => n.label);
  return { answers, briefCarried };
}

/**
 * The fills the inspector's one-tap button can honestly offer, simulated to a fixed point.
 *
 * Two review findings live here. The brief's stored answers were coerced against the playbook AT
 * READING TIME — the sheet may have changed since (an option renamed, a text turned select), so
 * they re-coerce against the CURRENT playbook first. And a naive "empty holes with brief values"
 * count lies twice: it counts fills that clearInapplicable will immediately strip (a gated branch
 * whose gate the brief doesn't open), and it MISSES chains the brief itself opens (its gate answer
 * makes its branch answer applicable). Only simulating the apply and keeping what survives makes
 * the button's count equal what a tap actually leaves answered.
 */
export function computeBriefFills(
  pb: Playbook,
  briefRawAnswers: unknown,
  base: Answers,
): { key: string; label: string; value: AnswerValue }[] {
  const ba = answersFromBrief(pb, briefRawAnswers);
  const candidates = pb.needs.filter((n) => ba[n.key] != null && !isAnswered(base[n.key]));
  if (!candidates.length) return [];
  let next: Answers = { ...base };
  for (const n of candidates) next = { ...next, [n.key]: ba[n.key]! };
  next = clearInapplicable(pb, next);
  return candidates
    .filter((n) => isAnswered(next[n.key]))
    .map((n) => ({ key: n.key, label: n.label, value: ba[n.key] as AnswerValue }));
}

/**
 * Which of the walk-through's CURRENT answers are still the machine's, verbatim.
 *
 * The estimator hand-off frames walk-through answers as "his words — take them as given"; an
 * answer the brief seeded and nobody touched is NOT his words, it is a model's reading of a
 * stranger's document, and it must cross that boundary wearing its own label. Equality is the
 * provenance test: the moment he edits a value it stops matching and becomes his.
 */
export function briefProvenanceKeys(pb: Playbook, briefRawAnswers: unknown, current: Answers): Set<string> {
  const ba = answersFromBrief(pb, briefRawAnswers);
  const keys = new Set<string>();
  for (const k of Object.keys(ba)) {
    if (current[k] != null && JSON.stringify(current[k]) === JSON.stringify(ba[k])) keys.add(k);
  }
  return keys;
}

/**
 * Which uploads a reading can actually take, and why the rest can't ride.
 *
 * PDFs only, newest-first upload order preserved, inside one total byte budget. Everything else
 * is named with an honest reason — a skipped file the office doesn't know about is the "silent
 * cap" this codebase's audits keep finding.
 */
export function pickReadablePlans(
  files: { path: string; bytes: number | null }[],
  budget: number = BRIEF_LIMITS.readBudgetBytes,
): { read: string[]; skipped: PlanBriefSkip[] } {
  const read: string[] = [];
  const skipped: PlanBriefSkip[] = [];
  let used = 0;
  for (const f of files) {
    const name = uploadDisplayName(f.path);
    const ext = extOf(f.path);
    if (ext !== "pdf") {
      skipped.push({
        name,
        reason:
          ext === "dwg" || ext === "dxf"
            ? "CAD drawing — can't be read yet; open it from the paperclip"
            : "photo — not read for the report",
      });
      continue;
    }
    if (f.bytes == null) {
      skipped.push({ name, reason: "file no longer in storage" });
      continue;
    }
    if (used + f.bytes > budget) {
      skipped.push({ name, reason: "over the 20 MB reading budget" });
      continue;
    }
    used += f.bytes;
    read.push(f.path);
  }
  return { read, skipped };
}
