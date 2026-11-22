import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CHECK OFF ON A FLAGGED TASK THAT STILL HAS OPEN STEPS (cn-v1179, skeptic #82, S5). The row's Check Off
 * runs task.complete with no cascade; toggleTask refuses with a QUESTION ("complete them too?",
 * needsCascade) that a Needs You row cannot answer. The row says one sentence naming its one way through
 * (its own Open the Job) in the reader's language, and NEVER asks again with cascade: that would close
 * steps nobody looked at. The registry is a stand-in that answers as toggleTask does.
 */
const calls = vi.hoisted(() => ({ list: [] as { name: string; input: Record<string, unknown> }[], answer: null as any }));
vi.mock("@/lib/actions/execute", () => ({
  executeAction: vi.fn(async (name: string, input: Record<string, unknown>) => {
    calls.list.push({ name, input });
    return calls.answer;
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { dispatchAction } from "./dispatch";
import { DISPATCH_WHY_KEY } from "./dispatch-map";
import { dict, translator } from "@/lib/i18n";

beforeEach(() => {
  calls.list = [];
});

const refusal = { ok: false, needsCascade: true, openChildren: 1, error: "This task has 1 open subtask — complete them too?" };

describe("Check Off on a flagged task with open steps", () => {
  it("is said as the one way through, in both languages, and never sent again with cascade", async () => {
    calls.answer = refusal;
    const res = await dispatchAction({ kind: "job_task_flagged", id: "flagtask-task-900", verb: "do" });
    expect(res).toEqual({ ok: false, error: "This task still has open steps. Open the Job to check them off.", why: "openSteps" });
    // the list says the catalog's words for `why` (action-list: t(DISPATCH_WHY_KEY[res.why]))
    expect(translator("en")(DISPATCH_WHY_KEY[res.why!])).toBe("This task still has open steps. Open the Job to check them off.");
    expect(translator("es")(DISPATCH_WHY_KEY[res.why!])).toBe("Esta tarea aún tiene pasos abiertos. Abre el Trabajo para marcarlos.");
    // the English fallback is the catalog's own sentence, and the button it names is the row's own
    expect(res.error).toBe(dict("en").ny_taskHasOpenSteps);
    expect(dict("en").ny_taskHasOpenSteps).toContain(dict("en").ag_btn_openTheJob);
    // ONE call, the task's own record, no cascade
    expect(calls.list).toEqual([{ name: "task.complete", input: { id: "task-900", done: true } }]);
    expect(calls.list.some((c) => "cascade" in c.input)).toBe(false);
  });

  it("any other refusal is passed on as it was, with no why", async () => {
    calls.answer = { ok: false, error: "Task not found." };
    expect(await dispatchAction({ kind: "job_task_flagged", id: "flagtask-task-900", verb: "do" })).toEqual({ ok: false, error: "Task not found." });
    calls.answer = { ok: true };
    expect(await dispatchAction({ kind: "job_task_flagged", id: "flagtask-task-900", verb: "do" })).toEqual({ ok: true });
  });

  it("the list says `why` through the catalog, in the reader's language", () => {
    const SRC = readFileSync(join(process.cwd(), "src/components/action-items/action-list.tsx"), "utf8");
    expect(SRC).toContain('const message = res.why ? t(DISPATCH_WHY_KEY[res.why]) : (res.error ?? t("ny_couldntDoThat"));');
    expect(SRC).not.toMatch(/cascade:\s*true/);
  });
});
