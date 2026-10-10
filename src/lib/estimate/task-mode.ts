import { withArticle } from "@/lib/org-trade";
import type { BookPricing } from "@/lib/pricing/item-options";
import { screenEstimatorTasks } from "./estimator-tasks";
import type { DraftLineItem } from "./line-map";
import { taskLines, type TaskBookRow } from "./task-lines";

/**
 * DRAFT WITH ESTIMATOR, IN TASK MODE — the prompt and the answer, both pure.
 *
 * Erik (2026-10-09): "The foundation underlying the ability to estimate a project … is pretty much
 * always broken down into tasks … each task carries its own labor and materials." And on what the
 * estimator had been doing with his punch list — deciding crew-hours, choosing parts, pricing them
 * at a retail guess — "Draft With Estimator is the speculation."
 *
 * So on the free-text path, for a research org, the model is no longer an estimator. It is a
 * SPLITTER: it reads his scope and returns the tasks he named, each with the hours HE gave for it
 * and the parts HE named in it, and it returns the fragment of his text each task came from so
 * code can check every claim (screenEstimatorTasks, the inspector's own gate). It is sent NO price
 * book, NO calculators and NO rate: there is nothing for it to price with, which is the point. The
 * survivors are priced by taskLines from his numbers, and a hole asks ([[no-speculation]]).
 *
 * Both halves live here, out of the server action, so the prompt's promises and the answer's
 * arithmetic are TESTED rather than reviewed. The catalog path (Tahoe Deck), the plan path and the
 * supplier-quote path keep the priced-lines prompt in quotes/actions.ts, untouched.
 */

/** What the model returns in task mode. Every field is untrusted; screenEstimatorTasks reads it. */
export type TaskModeParsed = {
  description?: unknown;
  tasks?: unknown;
  questions?: unknown;
};

export interface TaskModePromptInput {
  /** The company's trade words (tradeWordsOr), for the one noun the prompt needs. */
  trade: string;
  /** settings.quote_playbook — company notes, applied on top. */
  playbook?: string | null;
}

/** The task-mode system prompt. ONE string, no price book block: the model does not price. */
export function taskModePrompt({ trade, playbook }: TaskModePromptInput): string {
  const notes = (playbook ?? "").trim();
  return (
    `You are helping ${withArticle(trade)} write an estimate. You are handed HIS scope of work, in his own words. ` +
    "Your ONLY job is to SPLIT it into the tasks he described. You do not price anything and you do not add anything: the app prices each task from HIS hours and HIS parts, and anything you invent is thrown away by code. " +
    'Respond with ONLY a JSON OBJECT: {"description": string, "tasks": [ ... ], "questions": [ ... ]}. ' +
    'Each entry in "tasks": {"name": string, "hours": number|null, "heard": string, "materials": [{"words": string, "qty": number|null}]}. ' +
    // ONE TASK PER PIECE OF WORK, IN HIS WORDS. The inspector's gate (screenHeardTask) refuses a
    // name that is not mostly the fragment's words, so "shortened is fine, never new words" is
    // not style advice — it is what survives.
    '"tasks" = ONE task per piece of work he named, in his order. "name" = his words for that piece of work (shortened is fine; never new words). ' +
    // THE FRAGMENT IS THE EVIDENCE. Code folds case and spacing and checks that `heard` is a
    // substring of the scope; a paraphrase fails the check and the whole task is dropped.
    '"heard" = the exact fragment of the scope that task came from, copied VERBATIM, punctuation and all — it is checked by code, and a task whose fragment is not in the scope is thrown away. ' +
    // HOURS ARE HIS NUMBER OR NOTHING. A whole-job time is nobody's task's hours; a day is not
    // converted (that is arithmetic, and somebody else's). Null is the honest answer and the app
    // asks "hours?" on that line.
    '"hours" = a number ONLY when he said hours for THAT task inside that fragment ("about 3 hours", "an hour and a half"). ' +
    "A time he gave for the whole job is nobody's task's hours: null. Days are never converted to hours: null. No hours said: null. " +
    // PARTS HE NAMED, COUNTED AS HE COUNTED. Naming a part is one of it; a count he did not say
    // is null, never a typical quantity.
    '"materials" = ONLY the parts he named in that fragment, in his words ("50 amp breaker", "6/3"). "qty" = the count he gave for it in that fragment; a part he named without a number is 1; never a quantity you worked out. ' +
    "NEVER: a price, a catalog code, a labor rate, a part he did not name, a task he did not describe, a typical figure for anything. A hole in his words is a hole in the answer, not a guess. " +
    // THE SCOPE, POLISHED — the same rule the priced-lines prompt carries (quotes/actions.ts).
    '"description" = HIS OWN SCOPE, rewritten as 2-5 sentences a homeowner reads above the line items. Plain, calm, specific about rooms and what gets done. ' +
    "STATE ONLY WHAT HE DESCRIBED — no work he did not list, no hours, no prices, no sales language, no promises about workmanship or timelines. " +
    'Keep his options as options ("either ... or"). If he wrote nothing to polish, return "". ' +
    // NOTHING WITHOUT DATA — the same rule as the other prompt: a question is about something he
    // SAID, and it is a genuine ambiguity in what he said.
    '"questions" = AT MOST TWO, and usually ZERO. A question is allowed ONLY when his own words are genuinely ambiguous in a way that changes the price — two readings of a count, a quantity he gave without a unit, an option he named without choosing. ' +
    "FORBIDDEN: anything he already stated plainly; work he never mentioned (drywall, paint, permits, trenching, disposal — if he wanted it quoted he would have said so); trade options he did not raise; and any restatement of a task you already returned. " +
    "An empty list is the correct answer for a clear scope. No prose outside the JSON." +
    (notes ? `\n\nCompany notes (apply on top; his words still govern):\n${notes}` : "")
  );
}

/** The org's price book keyed by code AS STORED (taskLines tries the uppercase second). */
export function taskBookFromRows(rows: readonly unknown[]): Map<string, TaskBookRow> {
  const book = new Map<string, TaskBookRow>();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const code = String((r as { code?: unknown }).code ?? "").trim();
    if (!code) continue;
    book.set(code, { ...(r as object), code } as TaskBookRow);
  }
  return book;
}

export interface TaskModeContext {
  /** The org's price book by code. A part he named carries no code (the gate wipes them), so today
   *  this prices nothing until he picks the part from the book in the builder; it is here so the
   *  one function (taskLines) is called the one way. */
  book: Map<string, TaskBookRow>;
  /** The labor rate for this customer (laborRateFor), or the one he TYPED in the scope. 0 = none. */
  rate: number;
  pricing: BookPricing;
}

/**
 * THE MODEL'S JSON → ONE LINE PER TASK, with every refusal SAID.
 *
 * Screen first (the inspector's gate), then price the survivors from his numbers. What the gate
 * refused joins the questions as "Not taken: …" so the builder's Worth Checking list shows it: a
 * task the model made up, an hour it decided on, a part he never named — nothing is dropped
 * silently ([[not-annoying]]: nothing silent).
 */
export function taskModeDraft(
  scope: string,
  parsed: TaskModeParsed | null | undefined,
  ctx: TaskModeContext,
): { items: DraftLineItem[]; questions: string[]; description: string } {
  const p = parsed ?? {};
  const description = String(p.description ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
  // Read exactly as the priced-lines path reads them (quotes/actions.ts): trimmed, blanks out,
  // never truncated — the prompt asks for two at most, and a third is his to read, not ours to lose.
  const asked = Array.isArray(p.questions) ? p.questions.map((q) => String(q).trim()).filter(Boolean) : [];
  const { tasks, dropped } = screenEstimatorTasks(scope, p.tasks);
  const items = taskLines(tasks, { book: ctx.book, rate: ctx.rate, pricing: ctx.pricing });
  return {
    items,
    questions: [...asked, ...dropped.map((d) => `Not taken: ${d}`)],
    description,
  };
}
