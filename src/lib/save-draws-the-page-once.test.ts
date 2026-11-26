import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A SAVE DRAWS THE PAGE ONCE (cn-v1190, P2). The owner: "it seems like everything is taking twice as
 * long to process everywhere". Nothing was measured; this is what the code proves.
 *
 * THE PROOF, FROM THE INSTALLED NEXT (pinned below, so an upgrade that changes it turns this red):
 * - the client posts a server action to the page the person is on (server-action-reducer.js:
 *   `fetch(state.canonicalUrl, ...)`), with no RSC header, so the server renders from the root;
 * - any revalidatePath / revalidateTag sets `store.pathWasRevalidated = true` (revalidate.js);
 * - the action handler then renders that page's tree into the answer
 *   (action-handler.js: `skipFlight: !workStore.pathWasRevalidated || actionWasForwarded`);
 * - the client lays that tree in as the page (server-action-reducer.js: `mutable.cache = cache`).
 * So a `router.refresh()` right after an action that revalidated draws the page, layout included,
 * a second time.
 *
 * THE RULE: in the six doors the scout named, a refresh after an action goes only where EVERY success
 * path of that action revalidates the page the door is drawn on. Where one does not, it stays, with
 * its reason beside it. A refresh that follows no server action is never touched.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
/** Real calls only: a comment that names the call is not one. */
const refreshCalls = (src: string) => src.split("\n").filter((l) => /router\.refresh\(\)/.test(l.replace(/\/\/.*$/, ""))).length;

/** An exported function's body, from its signature to the next top-level declaration. */
function body(src: string, name: string): string {
  const at = src.indexOf(`export async function ${name}(`);
  if (at < 0) throw new Error(`no ${name}`);
  const rest = src.slice(at + 1);
  const next = rest.search(/\n(export |async function |function |const [A-Z_]+ =)/);
  return next < 0 ? rest : rest.slice(0, next);
}
/** Every `ok: true` answer comes after a revalidation in the same function (the success paths). */
function everySuccessRevalidates(fn: string): boolean {
  const oks = [...fn.matchAll(/ok: true/g)].map((m) => m.index ?? 0);
  if (!oks.length) return false;
  return oks.every((i) => /revalidate(Path|TaskViews|Money)\(/.test(fn.slice(0, i)));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * THE EXACT REVALIDATION ON THE SUCCESS PATH (fix-1190-B, skeptic #91 S6). everySuccessRevalidates
 * passes when SOME revalidation sits anywhere above an `ok: true` (a refusal branch's own one counts),
 * so it stayed green with the real one deleted. This asks more: the action has ONE success return, at
 * the function's top level, and the pinned lines sit at that same level directly before it, with no
 * other `return` between them. Deleting a pinned line, or moving it into a branch or below the
 * return, turns it red.
 */
function successPathPinned(fn: string, pin: string[]): { oneSuccess: boolean; pinned: boolean } {
  const successReturns = fn.split("\n").filter((l) => /^\s*return\b.*\bok: true\b/.test(l));
  const lines = pin.map((l) => `\\n  ${esc(l)}`).join("");
  const re = new RegExp(`${lines}\\n(?:(?![ \\t]*return\\b)[^\\n]*\\n)*?  return [^\\n]*\\bok: true\\b`);
  return { oneSuccess: successReturns.length === 1 && /^  return\b/.test(successReturns[0]), pinned: re.test(fn) };
}

type Row = { door: string; action: string; file: string; fn: string; revalidates: string; verdict: "removed" | "kept"; pin?: string[] };

/** action → what its success paths revalidate → the refresh after it. */
const TABLE: Row[] = [
  { door: "job-task-list toggle", action: "toggleTask", file: "src/app/(app)/tasks/actions.ts", fn: "toggleTask", revalidates: "/tasks, /planner, /jobs/[the page's job]", verdict: "removed", pin: ["revalidateTaskViews(opts?.category, opts?.jobId);"] },
  { door: "job-task-list flag", action: "setJobTaskFlag", file: "src/app/(app)/tasks/actions.ts", fn: "setJobTaskFlag", revalidates: "/tasks, /planner, /jobs/[the task's job and the page's job]", verdict: "removed", pin: ["revalidateTaskViews(null, jobId);", "if (opts?.jobId && opts.jobId !== jobId) revalidatePath(`/jobs/${opts.jobId}`);"] },
  { door: "job-task-list rename", action: "updateTask", file: "src/app/(app)/tasks/actions.ts", fn: "updateTask", revalidates: "/tasks, /planner, /jobs/[the page's job]", verdict: "removed", pin: ["revalidateTaskViews(opts?.category, opts?.jobId);"] },
  { door: "job-task-list delete", action: "deleteTask", file: "src/app/(app)/tasks/actions.ts", fn: "deleteTask", revalidates: "/tasks, /planner, /jobs/[the page's job]", verdict: "removed", pin: ["revalidateTaskViews(opts?.category, opts?.jobId);"] },
  { door: "job-task-list add", action: "createTask", file: "src/app/(app)/tasks/actions.ts", fn: "createTask", revalidates: "a duplicate answers ok with no revalidation", verdict: "kept" },
  { door: "job-bills Edit", action: "executeAction(bill.update) → updateBill", file: "src/app/(app)/jobs/actions.ts", fn: "updateBill", revalidates: "/jobs/[old and new job], /bills, /analytics", verdict: "removed", pin: ["for (const jid of new Set([oldJobId, (data as any)?.job_id].filter(Boolean) as string[])) revalidatePath(`/jobs/${jid}`);", 'revalidatePath("/bills");', 'revalidatePath("/analytics"); // bill cost moves job profitability'] },
  { door: "return-bill-door file", action: "fileReturnBillWithItsBill", file: "src/app/(app)/organize/credit-memo-actions.ts", fn: "fileReturnBillWithItsBill", revalidates: "/organize, /bills, /jobs/[the credit's job]", verdict: "removed", pin: ['revalidatePath("/organize");', 'revalidatePath("/bills");', "revalidatePath(`/jobs/${credit.bill.job_id}`);"] },
  { door: "request-payment make", action: "requestPayment", file: "src/app/(app)/billing/request-actions.ts", fn: "requestPayment", revalidates: "/jobs/[job], /billing, /billing/[request], /planner, /analytics, /tax-report — not a visit's page", verdict: "kept" },
  { door: "credit-memo-door file", action: "fileCreditMemoWithItsBill", file: "src/app/(app)/organize/credit-memo-actions.ts", fn: "fileCreditMemoWithItsBill", revalidates: "/organize, /bills, /jobs/[job] — not /reconcile or a page under Snap or Note", verdict: "kept" },
  { door: "receipt-billing-card returned", action: "setReceiptLineReturned", file: "src/app/(app)/bills/receipt-billing-actions.ts", fn: "setReceiptLineReturned", revalidates: "/bills, /jobs/[job] — not My Day or an invoice (Already Billed sheet)", verdict: "kept" },
  { door: "receipt-billing-card take off shelf", action: "takeRollOffShelf", file: "src/app/(app)/bills/receipt-billing-actions.ts", fn: "takeRollOffShelf", revalidates: "/inventory, /bills (in unshelveLot)", verdict: "kept" },
];

describe("the proof, in the installed Next", () => {
  it("an action that revalidated hands the current page's tree back, and the client lays it in", () => {
    const handler = read("node_modules/next/dist/server/app-render/action-handler.js");
    expect(handler).toContain("skipFlight: !workStore.pathWasRevalidated || actionWasForwarded");
    const revalidate = read("node_modules/next/dist/server/web/spec-extension/revalidate.js");
    expect(revalidate).toContain("store.pathWasRevalidated = true;");
    const reducer = read("node_modules/next/dist/client/components/router-reducer/reducers/server-action-reducer.js");
    expect(reducer).toContain("const res = await fetch(state.canonicalUrl, {");
    expect(reducer).toContain("mutable.cache = cache;");
  });
});

describe("action → revalidates → the refresh after it", () => {
  for (const r of TABLE) {
    it(`${r.door}: ${r.action} → ${r.revalidates} → ${r.verdict}`, () => {
      const fn = body(read(r.file), r.fn);
      if (r.verdict === "removed") {
        expect(everySuccessRevalidates(fn)).toBe(true);
        // The exact revalidation the page needs sits on the one success path, directly before its return.
        expect(r.pin?.length, "a removed refresh names its revalidation").toBeTruthy();
        expect(successPathPinned(fn, r.pin!)).toEqual({ oneSuccess: true, pinned: true });
      }
      // takeRollOffShelf revalidates inside unshelveLot; the rest are kept for the page they are drawn on.
      if (r.fn === "createTask") expect(everySuccessRevalidates(fn)).toBe(false);
    });
  }
});

describe("each door's refreshes", () => {
  const doors: { file: string; calls: number; kept: number }[] = [
    { file: "src/app/(app)/jobs/[id]/job-task-list.tsx", calls: 4, kept: 4 },
    { file: "src/app/(app)/jobs/[id]/job-bills.tsx", calls: 1, kept: 1 },
    { file: "src/components/return-bill-door.tsx", calls: 1, kept: 1 },
    { file: "src/components/request-payment.tsx", calls: 1, kept: 1 },
    { file: "src/components/credit-memo-door.tsx", calls: 2, kept: 2 },
    { file: "src/app/(app)/bills/receipt-billing-card.tsx", calls: 6, kept: 6 },
  ];
  for (const d of doors) {
    it(`${d.file}: ${d.calls} left, each with its reason beside it`, () => {
      const src = read(d.file);
      expect(refreshCalls(src)).toBe(d.calls);
      // The reason sits on the refresh's own line, or on the line just above it.
      const lines = src.split("\n");
      const withReason = lines.filter(
        (l, i) => /router\.refresh\(\)/.test(l.replace(/\/\/.*$/, "")) && (/\/\/ kept: /.test(l) || /^\s*\/\/ kept: /.test(lines[i - 1] ?? "")),
      ).length;
      expect(withReason).toBe(d.kept);
    });
  }

  it("the removed ones say why, where they were", () => {
    const tasks = read("src/app/(app)/jobs/[id]/job-task-list.tsx");
    for (const a of ["toggleTask", "setJobTaskFlag", "updateTask", "deleteTask"]) expect(tasks).toContain(`// No second refresh here (cn-v1190): ${a} revalidates this job's page`);
    expect(read("src/app/(app)/jobs/[id]/job-bills.tsx")).toContain("// No second refresh here (cn-v1190): both of updateBill's success paths revalidate the bill's job");
    expect(read("src/components/return-bill-door.tsx")).toContain("// No second refresh here (cn-v1190): the one success path of fileReturnBillWithItsBill revalidates");
  });
});
