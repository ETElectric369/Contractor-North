import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * NOTHING IS SENT STALE (cn-v1177). A bill on a job takes the job's payment requests off with one
 * "prepaid_credit" line each, re-resolved while it is a DRAFT (lib/invoice-recalc runs
 * syncPrepaidCredit first) and standing as written once it is sent. So every place a bill goes from
 * draft to sent must run the recalc IMMEDIATELY BEFORE the flip and stop, saying so, when it could not.
 *
 * This file is the list. It reads every source file under src and finds every way a bill leaves draft:
 *   - a call to the one send stamp (markInvoiceSent), or to a door that ends in it (sendDraftForPayment,
 *     deliverInvoiceEmail);
 *   - an UPDATE of invoices that names `status` or writes a patch built elsewhere.
 * Each one is pinned below with how it is covered, and the coverage is CHECKED in the text where it
 * can be. A new flip fails the first test until it is listed here, with its cover.
 */
const SRC = join(process.cwd(), "src");
const files: string[] = [];
const walk = (dir: string) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n) && !/db-suite|db-fixture|test-util/.test(n)) files.push(p);
  }
};
walk(SRC);
const rel = (p: string) => relative(process.cwd(), p);
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Comments out (line comments and block comments), strings kept: what runs. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

/** The top-level function a character offset sits in: the nearest `function name(` that starts a line above it. */
const enclosing = (text: string, at: number): string => {
  const head = text.slice(0, at);
  let name = "?";
  for (const m of head.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm)) name = m[1];
  return name;
};
/** One function's text, from its `function name(` to the next top-level `\n}\n`. */
const fnText = (text: string, name: string): string => {
  const at = text.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (at < 0) throw new Error(`no function ${name}`);
  return text.slice(at, text.indexOf("\n}\n", at) + 2);
};

const CALLS = /\b(markInvoiceSent|sendDraftForPayment|deliverInvoiceEmail)\(/g;

/** Every call that can move a bill out of draft, as "file › function › callee". */
const callSites = (): string[] => {
  const out: string[] = [];
  for (const f of files) {
    const t = code(readFileSync(f, "utf8"));
    for (const m of t.matchAll(CALLS)) {
      const before = t.slice(Math.max(0, m.index! - 40), m.index!);
      if (/function\s+$/.test(before)) continue; // the definition itself
      out.push(`${rel(f)} › ${enclosing(t, m.index!)} › ${m[1]}`);
    }
  }
  return out.sort();
};

/** Every UPDATE of invoices that writes `status`, or writes a patch built elsewhere (a name, not an object). */
const statusWrites = (): string[] => {
  const out: string[] = [];
  for (const f of files) {
    const t = code(readFileSync(f, "utf8"));
    for (const m of t.matchAll(/from\("invoices"\)/g)) {
      const tail = t.slice(m.index!, m.index! + 400);
      const u = tail.search(/\.update\(/);
      if (u < 0 || tail.slice(0, u).includes(";")) continue;
      const arg = tail.slice(u + ".update(".length, tail.indexOf(")", u));
      if (/^\s*\{/.test(arg) ? /\bstatus\b/.test(arg) : true) out.push(`${rel(f)} › ${enclosing(t, m.index!)}`);
    }
  }
  // One entry per function (the stamp writes twice: the status with its date, and the fallback).
  return [...new Set(out)].sort();
};

/** THE LIST: every flip, and what covers it. */
const FLIPS: Record<string, string> = {
  // The stamp and its two doors: they are the flip; their callers are the cover (listed below).
  "src/lib/pay-door-send.ts › sendDraftForPayment › markInvoiceSent": "outgoingDraftFirst immediately before, and a false sends nothing",
  "src/lib/invoice-email.ts › deliverInvoiceEmail › markInvoiceSent": "its callers: emailInvoice (freshBeforeSend) and the recurring cron (a bill with no job)",
  // The office's doors.
  "src/app/(app)/billing/actions.ts › invoiceShareText › markInvoiceSent": "freshBeforeSend before the read",
  "src/app/(app)/billing/actions.ts › textInvoice › markInvoiceSent": "freshBeforeSend before the read",
  "src/app/(app)/billing/actions.ts › emailInvoice › deliverInvoiceEmail": "freshBeforeSend before the email is composed",
  "src/app/(app)/billing/actions.ts › settleUp › markInvoiceSent": "outgoingDraftFirst checked right before (and no mint while a request still asks for money)",
  "src/app/(app)/billing/actions.ts › settleUp › sendDraftForPayment": "sendDraftForPayment recalcs first; the payment lands on the figure read after",
  "src/app/(app)/billing/actions.ts › collectArtifacts › sendDraftForPayment": "sendDraftForPayment recalcs first; the balance is read after",
  "src/app/(app)/billing/tap-actions.ts › createTapPaymentIntent › sendDraftForPayment": "sendDraftForPayment recalcs first; the balance is read after",
  // A request is born sent: its own recalc runs first (the sync skips a request by its kind).
  "src/lib/payment-request.ts › createPaymentRequest › markInvoiceSent": "recalcInvoice checked right before",
  // A deposit request found as a draft has its birth finished the same way (skeptic #80, F10).
  "src/lib/payment-request.ts › finishBirth › markInvoiceSent": "recalcInvoice checked right before",
  // The cron: a recurring bill is made with no job, so there is nothing to take off it.
  "src/lib/recurring-engine.ts › createRecurringInvoice › deliverInvoiceEmail": "a bill with no job_id: the sync has nothing to do",
};
const STATUS_WRITES: Record<string, string> = {
  "src/lib/invoice-sent-stamp.ts › markInvoiceSent": "THE stamp: every caller is covered above",
  "src/lib/invoice-recalc.ts › recalcInvoice": "paidStatus never moves a draft (invoice-math), and the sync runs first",
  "src/app/(app)/billing/actions.ts › setInvoiceStatus": "freshBeforeSend immediately before the patch, when a draft goes out",
  "src/app/(app)/billing/actions.ts › setInvoiceCustomerJob": "draft only, and writes job and customer, never status",
};

describe("nothing is sent stale: every draft → sent flip in src is listed, with its cover", () => {
  it("the flips found are exactly the flips listed", () => {
    expect(callSites()).toEqual(Object.keys(FLIPS).sort());
    expect(statusWrites()).toEqual(Object.keys(STATUS_WRITES).sort());
  });

  it("each office door is brought up to date BEFORE the flip, and stops when it could not", () => {
    const actions = code(read("src/app/(app)/billing/actions.ts"));
    const fresh = fnText(actions, "freshBeforeSend");
    expect(fresh).toContain("if (String(row.status ?? \"\") !== \"draft\") return null;");
    // The bill going out comes first (skeptic #80): the one function clears the other drafts' derived
    // credit, resolves this bill, then lets the others take what is left.
    expect(fresh).toContain("if (await outgoingDraftFirst(supabase, id)) return null;");
    for (const [door, flip] of [
      ["invoiceShareText", "markInvoiceSent("],
      ["textInvoice", "markInvoiceSent("],
      ["emailInvoice", "deliverInvoiceEmail("],
      ["setInvoiceStatus", ".update(patch)"],
      ["previewInvoiceSend", "invoiceSendWords("],
    ] as const) {
      const body = fnText(actions, door);
      const guard = body.indexOf("const stale = await freshBeforeSend(");
      expect(guard, door).toBeGreaterThan(0);
      expect(body.slice(guard, guard + 160), door).toContain("if (stale) return { ok: false, error: stale };");
      expect(body.indexOf(flip), door).toBeGreaterThan(guard);
    }
    // settleUp: the recalc right before the stamp is checked.
    const settle = fnText(actions, "settleUp");
    const recalc = settle.indexOf("if (!(await outgoingDraftFirst(supabase, inv.id))) {");
    expect(recalc).toBeGreaterThan(0);
    expect(settle.indexOf("const settleSent = await markInvoiceSent(supabase, inv.id);")).toBeGreaterThan(recalc);
  });

  it("the bill going out comes first: ONE function clears the other drafts' credit, resolves the outgoing bill, then the others", () => {
    const fn = fnText(code(read("src/lib/payment-request.ts")), "outgoingDraftFirst");
    const clear = fn.indexOf('.eq("import_source", PREPAID_CREDIT)');
    const recalc = fn.indexOf("const fresh = await recalcInvoice(sb, invoiceId);");
    const resync = fn.indexOf("await resyncJobDrafts(sb, jobId, invoiceId);");
    expect(clear).toBeGreaterThan(0);
    expect(recalc).toBeGreaterThan(clear);
    expect(resync).toBeGreaterThan(recalc);
  });

  it("the pay doors' send recalcs first and sends nothing when it could not", () => {
    const door = code(read("src/lib/pay-door-send.ts"));
    const recalc = door.indexOf("if (!(await outgoingDraftFirst(supabase, invoiceId))) {");
    expect(recalc).toBeGreaterThan(0);
    expect(door.indexOf("const sent = await markInvoiceSent(supabase, invoiceId);")).toBeGreaterThan(recalc);
  });

  it("a request's own send recalcs first; the recurring cron's bill has no job", () => {
    const req = fnText(code(read("src/lib/payment-request.ts")), "createPaymentRequest");
    const recalc = req.indexOf("if (!(await recalcInvoice(db, id))) {");
    expect(recalc).toBeGreaterThan(0);
    expect(req.indexOf("const sent = await markInvoiceSent(db, id);")).toBeGreaterThan(recalc);
    const birth = fnText(code(read("src/lib/payment-request.ts")), "finishBirth");
    const bRecalc = birth.indexOf("if (!(await recalcInvoice(db, live.id))) return null;");
    expect(bRecalc).toBeGreaterThan(0);
    expect(birth.indexOf("const sent = await markInvoiceSent(db, live.id);")).toBeGreaterThan(bRecalc);
    const cron = fnText(code(read("src/lib/recurring-engine.ts")), "createRecurringInvoice");
    const insert = cron.slice(cron.indexOf('.from("invoices")'), cron.indexOf(".select(", cron.indexOf('.from("invoices")')));
    expect(insert).not.toContain("job_id");
  });

  it("the recalc runs the sync FIRST on a draft with a job that is not a request, and a failed sync writes nothing", () => {
    const recalc = code(read("src/lib/invoice-recalc.ts"));
    const sync = recalc.indexOf("if (!(await syncPrepaidCredit(supabase, invoiceId))) return false;");
    expect(sync).toBeGreaterThan(0);
    expect(recalc).toContain('if (String(h.status ?? "") === "draft" && h.job_id && !isPrepaymentKind(h.invoice_kind)) {');
    expect(recalc.indexOf('.from("invoices")\n    .update(')).toBeGreaterThan(sync);
  });

  it("every creator of a bill on a job ends in the recalc", () => {
    const actions = code(read("src/app/(app)/billing/actions.ts"));
    for (const [fn, mark] of [
      ["createInvoiceFromQuote", "await recalcInvoice(supabase, invoice.id);"],
      ["createBlankInvoice", "if (input.job_id) await recalcInvoice(supabase, data.id);"],
      ["createMilestoneDraw", "await recalcInvoice(supabase, inv.id);"],
    ] as const) {
      expect(fnText(actions, fn), fn).toContain(mark);
    }
    expect(fnText(code(read("src/app/(app)/recurring/actions.ts")), "createProgressInvoice")).toContain("if (!(await recalcInvoice(supabase, inv.id))) {");
  });
});
