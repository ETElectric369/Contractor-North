/**
 * ONE EFFORT TABLE FOR EVERY MODEL CALL (cn-v1142, the SDK half).
 *
 * The 5.5 line thinks on every request (adaptive thinking is on when `thinking` is omitted; the
 * old `disabled` and `budget_tokens` shapes are 400s on Opus 5.5 and Sonnet 5.5), and the ONE
 * control for how much it thinks — and so for latency and cost — is `output_config.effort`.
 * The API's default differs by model and moves between releases (Opus 5 defaulted to `high`,
 * Opus 5.5 to `medium`), so a call that sets nothing runs at whatever its model's default is this
 * month. This table says it once per surface, keyed by the ledger's surface names (ai-cost
 * recordAiUsage), so the row that meters a call and the row that shapes it are the same word.
 *
 * THREE NAMES ARE NEW HERE and the ledger does not carry them yet: "estimator:tasks" (the task
 * splitter), "estimator:supplier-quote" (a supplier quote READ into lines) and "organize:triage"
 * (the 500-token action pick). Each is metered today under its parent's name ("estimator",
 * "organize") although it is lighter work; the site that applies this table meters under the
 * sub-name too, so the ledger can tell them apart from then on.
 *
 * `thinking`: "adaptive" sends `thinking: { type: "adaptive" }` (explicit, so a pinned older
 * model that thinks only when asked still thinks); "off" sends NO thinking field and runs at low
 * effort — the docs' own lever in place of `disabled`, which Opus 5.5 and Sonnet 5.5 reject
 * outright and Haiku 5.5 is told to leave alone, and the only shape that is safe whichever model
 * the usage tier picks this month. The thinking text is never asked for (`display` stays at its
 * default, omitted): no screen shows it, and it would cost.
 *
 * `maxTokens` is a FLOOR, not today's cap: thinking counts toward max_tokens even though its
 * text is not returned, so a cap sized for a no-thinking answer now cuts the answer off. Where a
 * surface's cap was sized that way it rises here; the rest keep today's number (noted per row).
 */

export type Surface =
  | "chat"
  | "chat:field"
  | "estimator"
  | "estimator:tasks"
  | "estimator:supplier-quote"
  | "panel-plans"
  | "panel-photo"
  | "circuit-schedule"
  | "nort:review"
  | "plan-brief"
  | "site-designer"
  | "playbook:hear"
  | "setup:talk"
  | "setup:draft"
  | "setup:converse"
  | "compliance"
  | "vendor-lookup"
  | "vendor-list-read"
  | "organize"
  | "organize:triage"
  | "materials"
  | "statement-scan"
  | "statement-scan-kind"
  | "json-repair"
  | "resource-from-link"
  | "site-chat";

export type Effort = "low" | "medium" | "high" | "max";
export type Thinking = "adaptive" | "off";

export type EffortRow = { thinking: Thinking; effort: Effort; maxTokens: number };

const row = (thinking: Thinking, effort: Effort, maxTokens: number): EffortRow => ({ thinking, effort, maxTokens });

/** The table. One row per surface; the comment on each says today's cap where the floor differs. */
export const EFFORT_TABLE: Readonly<Record<Surface, EffortRow>> = {
  // NORT'S CHAT. Staff reason about money and estimates; the field asks what's on today.
  // 2048 → 6000: the whole answer plus the thinking behind it, streamed, so no timeout to size for.
  "chat": row("adaptive", "medium", 6000),
  "chat:field": row("adaptive", "low", 6000),
  // THE ESTIMATOR: the one surface whose entire job is the numbers. 8192 → 16000 (the docs'
  // non-streaming default; high-effort thinking on a dense take-off would starve 8192).
  "estimator": row("adaptive", "high", 16000),
  // The task SPLIT (one task per piece of work the person named, his hours, his parts): a sort,
  // not a price. Keeps 8192.
  "estimator:tasks": row("adaptive", "medium", 8192),
  // A supplier quote is READ into lines, not estimated. Keeps 8192.
  "estimator:supplier-quote": row("adaptive", "medium", 8192),
  // Plan circuits: forty circuits counted off a sheet, every one a breaker. 6000 → 10000.
  "panel-plans": row("adaptive", "high", 10000),
  // The panel photo: one door's labels. 3000 → 5000.
  "panel-photo": row("adaptive", "medium", 5000),
  // The circuit schedule drawn from an estimate. 3000 → 5000.
  "circuit-schedule": row("adaptive", "medium", 5000),
  // The nightly review of a company's day. 1500 → 3000.
  "nort:review": row("adaptive", "medium", 3000),
  // The preliminary plan brief. 4096 → 6000.
  "plan-brief": row("adaptive", "medium", 6000),
  // The site designer returns a whole document; 12288 already had room.
  "site-designer": row("adaptive", "medium", 12288),
  // Hearing a run of speech into a playbook's answers (the inspection and the setup interview).
  // 2000 → 3000.
  "playbook:hear": row("adaptive", "medium", 3000),
  "setup:talk": row("adaptive", "medium", 3000),
  // The setup draft (a company's first settings from its interview). 4000 → 6000.
  "setup:draft": row("adaptive", "medium", 6000),
  // One conversational turn of the setup interview. 1200 → 2000.
  "setup:converse": row("adaptive", "low", 2000),
  // ROUTINE EXTRACTIONS: copy what is printed, the office reviews it. 1024 → 2000.
  "compliance": row("adaptive", "low", 2000),
  "vendor-lookup": row("adaptive", "low", 2000),
  "vendor-list-read": row("adaptive", "low", 8000),
  // The paper READ (a receipt or bill into its lines — the one that becomes billable money):
  // 4096 → 6000. The TRIAGE (which bucket, which job): 500 → 1500, the smallest cap that holds
  // its thinking and its one-object answer.
  "organize": row("adaptive", "medium", 6000),
  "organize:triage": row("adaptive", "low", 1500),
  // A material take-off from a scope of work: judgment about what the job needs. 2000 → 4000.
  "materials": row("adaptive", "medium", 4000),
  // A bank statement's forty money lines; 16000 was sized for a long one and keeps it.
  "statement-scan": row("adaptive", "medium", 16000),
  // MECHANICS on the small model: what kind of paper, repair a JSON, what a link points at.
  // No thinking asked for; the caps were sized for thinking inside them already (cn-v1128).
  "statement-scan-kind": row("off", "low", 1500),
  "json-repair": row("off", "low", 4096),
  "resource-from-link": row("off", "low", 1500),
  // The public site chat: a stranger's ballpark on the small model. Keeps 1500.
  "site-chat": row("adaptive", "low", 1500),
};

export const AI_SURFACES = Object.keys(EFFORT_TABLE) as Surface[];

/** The row for a surface. */
export function effortFor(surface: Surface): EffortRow {
  return EFFORT_TABLE[surface];
}

/**
 * The request fragment in the docs' exact shape, to spread into `messages.create` / `.stream`:
 *   { thinking: { type: "adaptive" }, output_config: { effort }, max_tokens }
 * ("off" rows carry no `thinking` key.) `opts.maxTokens` raises the cap for a call that needs
 * more than the floor; it can never lower it.
 */
export type AiRequestFragment = {
  thinking?: { type: "adaptive" };
  output_config: { effort: Effort };
  max_tokens: number;
};

export function aiRequestFor(surface: Surface, opts: { maxTokens?: number } = {}): AiRequestFragment {
  const e = effortFor(surface);
  const asked = Math.trunc(Number(opts.maxTokens) || 0);
  return {
    ...(e.thinking === "adaptive" ? { thinking: { type: "adaptive" as const } } : {}),
    output_config: { effort: e.effort },
    max_tokens: Math.max(e.maxTokens, asked),
  };
}
