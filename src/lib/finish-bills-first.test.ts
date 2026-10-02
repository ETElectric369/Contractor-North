import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, normalize, sep } from "node:path";
import { paidDoorVerdict, type FinishBillingStep } from "./finish-bills-first";
import { jobBillsItsActuals } from "./invoice-import-rule";
import { codeOnly, liveFunctionBody } from "@/lib/migration-body.test-util";
import type { NotBilled } from "./finish-job-words";

/**
 * WHAT A PAID BILL MAY DO WITH THE BILLING STEP'S ANSWER (M3, the money seam).
 *
 * The step itself is one read shared by both doors that end a job (Finish Job and the paid-in-full gate);
 * its behaviour through the gate is pinned in lib/complete-job-when-paid.test.ts, and through the press in
 * jobs/finish-job.test.ts. THIS is the decision table in between, pure: given what the step found, may the
 * money finish the job, and what does the person get told?
 */
const TAO: NotBilled = { hours: 19.5, laborAmount: 2437.5, billsCount: 2, billsBilled: 473.62, stockCount: 0, stockBilled: 0 };
const SAID = "41 Larkspur · J-002 — Marla Finch";

const plan = (door: Extract<FinishBillingStep, { kind: "plan" }>["door"], over: Partial<Extract<FinishBillingStep, { kind: "plan" }>> = {}): FinishBillingStep => ({
  kind: "plan",
  door,
  draft: null,
  drawBilled: false,
  work: 2911.12,
  lump: 0,
  notBilled: TAO,
  ...over,
});

describe("paidDoorVerdict — may money end this job, and what is the person told", () => {
  it("nothing to bill: the job finishes, and nothing extra is said", () => {
    expect(paidDoorVerdict({ kind: "skip" }, SAID)).toEqual({ finish: true, say: null, title: null, why: "" });
  });

  /**
   * EVERY DOOR THAT WOULD BUILD A BILL REFUSES THE FINISH. This gate cannot build one — the invoice
   * builders are "use server" actions behind requireStaff and the Stripe webhook has no staff session —
   * and it must not, because a draft it built would itself be the "other open bill" the gate's third rule
   * refuses. So the inference "paid, therefore done" simply does not hold while work is waiting.
   */
  it.each([
    ["draw", { kind: "draw" as const, label: "Create Progress Payment for $2,911.12", amount: 2911.12 }],
    ["create", { kind: "create" as const, label: "Create Invoice for $2,911.12", amount: 2911.12 }],
    ["add", { kind: "add" as const, label: "Add to INV-078 ($2,911.12)", amount: 2911.12 }],
    ["open", { kind: "open" as const, label: "Open INV-078", href: "/billing/x" }],
  ])("a %s door: the job is NOT finished, and the hours, the receipts and the money are named", (_name, door) => {
    const v = paidDoorVerdict(plan(door), SAID);
    expect(v.finish).toBe(false);
    expect(v.say).toContain("19.5 h and 2 bills ($2,911.12)");
    expect(v.say).toContain(SAID);
    expect(v.say).toContain("NOT finished yet");
    // No dead end: the sentence carries the one door that bills it.
    expect(v.say).toContain("This Is The Last Bill");
    // The log line is short and the person's sentence is not — they are two different jobs.
    expect(v.why).toBe("the job has work no bill claims yet, so it isn't finished");
    expect(v.title).toBe("Still to bill");
  });

  /**
   * THE ONE DOOR THAT FINISHES *AND* SPEAKS. A deposit not yet taken off a bill covers the work, so no
   * bill will ever be built for it (the draw door refuses one whose net is $0) and the job is genuinely
   * over. There is no later bill to carry the figures, so they are said here — the same sentence Finish
   * Job says, from the same function, including the part a person has to act on.
   */
  it("a deposit that covers the work: the job finishes, and the figures go with it", () => {
    const v = paidDoorVerdict(plan({ kind: "covered", note: "covered" }, { work: 500, lump: 5000 }), SAID);
    expect(v.finish).toBe(true);
    expect(v.say).toContain(SAID);
    expect(v.say).toContain("$5,000.00");
    expect(v.say).toContain("$500.00");
    expect(v.say).toContain("settle the difference with the customer");
    expect(v.title).toBe("Job finished");
  });

  it("a deposit that covers the work EXACTLY: finished, said, and nothing to settle", () => {
    const v = paidDoorVerdict(plan({ kind: "covered", note: "covered" }, { work: 5000, lump: 5000 }), SAID);
    expect(v.finish).toBe(true);
    expect(v.say).not.toContain("settle the difference");
  });

  /**
   * A READ THAT FAILED IS NEVER "NOTHING TO BILL" — the whole class of bug this closes. The job is left
   * exactly as it was and the person is told: a tile reading "in progress" for one more press is
   * recoverable, 19.5 unbilled hours are not.
   */
  it("a read that failed: the job is NOT finished, and the refusal reaches a person in words", () => {
    const v = paidDoorVerdict(
      {
        kind: "error",
        error: "Couldn't read this job's hours and bills just now, so it wasn't finished and nothing was billed. Try again in a moment.",
        said: "the app couldn't read this job's hours and receipts, so it wasn't finished and nothing was billed.",
      },
      SAID,
    );
    expect(v.finish).toBe(false);
    expect(v.say).toContain(SAID);
    expect(v.say).toContain("was paid off, but the app couldn't read this job's hours and receipts");
  });

  /**
   * NOBODY PRESSED ANYTHING, SO THE SENTENCE DOESN'T ASK THEM TO PRESS AGAIN (review of this lane).
   *
   * The error arm used to re-use the Finish Job wording verbatim, lower-cased: "…was paid off, but
   * couldn't read this job's bills just now… Try again in a moment." — subject-less, and sent as a PUSH
   * off a customer's own payment to people who tapped nothing. And it went out titled "Still to bill",
   * which is a claim about the job's money that nothing had checked; on a fixed-price job it is the one
   * alarm that must never ring, because the extension IS the price.
   */
  it("the paid door's refusal has a subject, no 'try again', and its own title", () => {
    const v = paidDoorVerdict(
      { kind: "error", error: "Couldn't read this job's bills just now, so it wasn't finished. Try again in a moment.", said: "the app couldn't check what this job still has to bill, so it wasn't finished." },
      SAID,
    );
    expect(v.say).toBe(`${SAID} was paid off, but the app couldn't check what this job still has to bill, so it wasn't finished.`);
    expect(v.say).not.toMatch(/try again/i);
    expect(v.title).toBe("Couldn't check this job's bills");
    expect(v.title).not.toBe("Still to bill");
  });

  /** Every door kind the card can hand back is decided here, so a new one is a decision somebody makes. */
  it("no door kind falls through unconsidered — and an unknown one refuses, which is the safe direction", () => {
    const kinds = ["add", "open", "create", "draw", "covered"];
    const finishes = kinds.filter((k) => paidDoorVerdict(plan({ kind: k, label: "x", amount: 1, href: "x", note: "n" } as never), SAID).finish);
    expect(finishes).toEqual(["covered"]);
    // A kind nobody has written yet: not finished, and said, rather than quietly ending the job.
    const unknown = paidDoorVerdict(plan({ kind: "something-new" } as never), SAID);
    expect(unknown.finish).toBe(false);
    expect(unknown.say).toBeTruthy();
  });

  it("figures that round to nothing still refuse out loud, never wordlessly", () => {
    const v = paidDoorVerdict(plan({ kind: "create", label: "x", amount: 0 }, { notBilled: { hours: 0, laborAmount: 0, billsCount: 0, billsBilled: 0 } }), SAID);
    expect(v.finish).toBe(false);
    expect(v.say).toBe(`${SAID} has work no bill claims yet, so it is not finished.`);
    expect(v.title).toBe("Still to bill");
  });
});

/**
 * WHY THE BILLING TYPE MAY BE READ FIRST AND ALONE (review of this lane, medium).
 *
 * The step asks jobBillsItsActuals(type, 0) before it has issued the payment-schedule read, and returns
 * "skip" on a no — so a fixed-price job can never be blocked, or announced, by a read whose answer cannot
 * change its verdict. That shortcut is only sound while milestones are MONOTONIC: a schedule can turn a
 * yes into a no, never a no into a yes. This is the pin. If the rule ever grows a clause where a count
 * above zero makes a job bill its actuals, this fails, and whoever writes it reads this note and moves the
 * read back up with it.
 */
describe("the billing type decides first: milestones can only ever take the answer away", () => {
  it("no billing type and no count makes a job bill its actuals that type alone would not", () => {
    const types = ["tm", "fixed", "cost_plus", "", null, undefined];
    for (const t of types) {
      for (const n of [0, 1, 2, 7, 99]) {
        if (jobBillsItsActuals(t, n)) {
          expect(jobBillsItsActuals(t, 0), `billing type ${String(t)} bills its actuals with ${n} milestones but not with none`).toBe(true);
        }
      }
    }
    // And the one type that can: T&M with nothing on a schedule.
    expect(jobBillsItsActuals("tm", 0)).toBe(true);
    expect(jobBillsItsActuals("fixed", 0)).toBe(false);
  });
});

/**
 * THE TEETH UNDER "ONE PLACE DECIDES": THE BILLING STEP STAYS CALLABLE FROM THE STRIPE WEBHOOK.
 *
 * The whole seam rests on both doors calling the same function, and the paid door is a Route Handler
 * (src/app/api/stripe/webhook/route.ts) running on a service client with no cookie session. One import
 * of the staff guard, or of a "use server" actions module, and the webhook 500s on a real payment —
 * which Stripe then retries while the customer sees nothing. So the module's whole import graph is
 * walked here and nothing in it may need a request context.
 *
 * Verified by hand first: the graph is 28 modules, and the only one that even mentions next/headers is
 * lib/observe (through createServiceClient, which uses no cookies) — and lib/complete-job-when-paid
 * already imported observe and already ran from this webhook before this lane touched anything.
 */
describe("the billing step is callable from the Stripe webhook, not just from a Server Action", () => {
  const SPEC = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  const resolve = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = join("src", spec.slice(2));
    else if (spec.startsWith(".")) base = normalize(join(dirname(from), spec));
    else return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      if (existsSync(c) && statSync(c).isFile()) return c.split(sep).join("/");
    }
    return null;
  };

  const graph = (() => {
    const root = "src/lib/finish-bills-first.ts";
    const seen = new Set([root]);
    const stack = [root];
    const out: { f: string; src: string }[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      const src = readFileSync(join(process.cwd(), cur), "utf8");
      out.push({ f: cur, src });
      for (const m of src.matchAll(SPEC)) {
        const r = resolve(cur, m[1] || m[2]);
        if (r && !seen.has(r)) {
          seen.add(r);
          stack.push(r);
        }
      }
    }
    return out;
  })();

  it("the walk really read the graph — the step and the readers it leans on", () => {
    const names = graph.map((g) => g.f);
    expect(names.length).toBeGreaterThan(15);
    expect(names).toContain("src/lib/unbilled-work.ts");
    expect(names).toContain("src/lib/actuals-draw.ts");
    expect(names).toContain("src/lib/finish-job-words.ts");
  });

  it("nothing in it is a Server Action module or asks for a staff session", () => {
    const needsAPerson = graph
      .filter((g) => /^\s*["']use server["']/.test(g.src.slice(0, 400)) || /from\s*["']@\/lib\/staff-guard["']/.test(g.src))
      .map((g) => g.f);
    expect(
      needsAPerson,
      "The billing step runs in the Stripe webhook on a service client with no cookie session. A " +
        '"use server" module or requireStaff in its graph makes that a 500 on a real customer payment, ' +
        "which Stripe retries silently. Keep the step a plain lib: pass the client in, read nothing from a request.",
    ).toEqual([]);
  });
});

/**
 * THE TRIPWIRE UNDER "ONE RULE ONE PLACE": NO DOOR REACHES THE WORK WITHOUT SAYING WHICH CLIENT IT HOLDS.
 *
 * WHAT WENT WRONG. unbilledWorkForJob takes an OPTIONAL org scope, and says in its own doc comment that
 * a service-role caller must pass one "because the service role would otherwise read the first org it
 * found". The step omitted it. On main that was harmless — the only caller was a "use server" module on a
 * staff session — and this lane then wired the same function into the Stripe webhook's service client,
 * where the omission silently priced ET's hours with another company's rates and let a deposit "cover"
 * $2,925 of work. An optional scope on a shared helper is exactly what produced it, so the caller's
 * identity is a REQUIRED argument and this walk is the teeth: tsc catches a door that passes nothing, and
 * these catch a door that passes something meaningless, or a future read inside the step that drops it.
 *
 * (What the step does WITH it is behaviour, not shape, and is pinned where money can be counted:
 * lib/paid-door-prices-the-work.test.ts runs the real step on both clients over the same books.)
 */
describe("every door that ends a job on money says which client it is holding", () => {
  /**
   * Source with comments removed, through THE one stripper every bypass tripwire reads
   * (lib/migration-body.test-util: codeOnly), so prose can neither satisfy nor trip an assertion
   * about code. THIS ONE SCANS THE WHOLE APP: a doc comment anywhere in 200+ files that happened
   * to write `completeJobWhenPaid(db, id)` as prose would be reported as a door that forgot its
   * client, and a comment in the step's own header that wrote `access?:` while explaining why an
   * optional scope was the defect would fail "`access` may not be optional". The repo's house
   * style names its functions in prose constantly; it is one hyphen from happening.
   */
  const read = (f: string) => codeOnly(readFileSync(join(process.cwd(), f), "utf8"));
  const SRC = (() => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const f = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(f);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$|\.test-util\.ts$/.test(e.name)) out.push(f);
      }
    };
    walk("src");
    return out;
  })();

  it("the walk found the app, including the Stripe webhook and the Finish Job action", () => {
    expect(SRC.length).toBeGreaterThan(200);
    expect(SRC).toContain("src/app/api/stripe/webhook/route.ts");
    expect(SRC).toContain("src/app/(app)/jobs/actions.ts");
    expect(SRC).toContain("src/lib/complete-job-when-paid.ts");
  });

  it("finishBillingStep takes the caller's identity, and it is not optional", () => {
    const body = read("src/lib/finish-bills-first.ts");
    expect(
      /access:\s*BillingAccess\s*,/.test(body),
      "finishBillingStep must take `access: BillingAccess` — REQUIRED. An optional scope is what let the " +
        "Stripe webhook price one company's hours with another company's rates, silently.",
    ).toBe(true);
    expect(/access\?:/.test(body), "`access` may not be optional: a door that forgets it is the defect.").toBe(false);
  });

  it("the step hands that identity to the read that prices the work — never a bare (supabase, jobId)", () => {
    const body = read("src/lib/finish-bills-first.ts");
    const calls = [...body.matchAll(/unbilledWorkForJob\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(calls.length, "the step is the one place that reads a job's unbilled work for a finish").toBe(1);
    expect(
      calls[0],
      "unbilledWorkForJob must be called with the scope the caller's identity decided (undefined for a " +
        "staff client, { orgId } for the service role). Two arguments is the unscoped read: profile_pay " +
        "answers nothing, `organizations ... limit(1)` is an arbitrary tenant, job_codes is every tenant.",
    ).toBe("supabase, jobId, scope");
    // And that scope follows the CALLER, not the job: a staff client given one reads profiles.bill_rate,
    // which 0216 revokes from the authenticated role, and every Finish Job press becomes a refusal.
    expect(/const scope = access\.kind === "service" \? \{ orgId: access\.orgId \} : undefined;/.test(body)).toBe(true);
  });

  /** The whole argument list of a call, parens balanced — a one-line call and a wrapped one read alike. */
  const callArgs = (body: string, name: string): string[] => {
    const out: string[] = [];
    const call = new RegExp(`(?<![\\w.$])${name}\\s*\\(`, "g");
    for (const m of body.matchAll(call)) {
      let depth = 1;
      let k = m.index! + m[0].length;
      while (k < body.length && depth > 0) {
        const c = body[k];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        k++;
      }
      out.push(body.slice(m.index! + m[0].length, k - 1));
    }
    return out;
  };

  it("the arg walker really reads a call, wrapped over lines or not", () => {
    expect(callArgs("await foo(a, b);", "foo")).toEqual(["a, b"]);
    expect(callArgs("foo(\n  a,\n  { b: c(1) },\n);", "foo")).toEqual(["\n  a,\n  { b: c(1) },\n"]);
    // A longer name ending in the same word is not this call.
    expect(callArgs("notFoo(x); obj.foo(y);", "foo")).toEqual([]);
  });

  it("every call site of the step, the gate and the payment helpers names its client", () => {
    const missing: string[] = [];
    for (const f of SRC) {
      const body = read(f);
      for (const args of callArgs(body, "finishBillingStep")) {
        // The definition itself, not a call.
        if (/:\s*BillingAccess/.test(args)) continue;
        if (args.split(",").length < 3) missing.push(`${f}: finishBillingStep(${args.trim()})`);
      }
      for (const name of ["completeJobWhenPaid", "afterPaymentLanded", "recordStripeInvoicePayment"]) {
        if (new RegExp(`export async function ${name}\\(`).test(body)) continue; // its own module
        for (const args of callArgs(body, name)) {
          if (!/\baccess\b/.test(args)) missing.push(`${f}: ${name}(${args.trim().slice(0, 60)}…) with no access`);
        }
      }
    }
    expect(
      missing,
      "A door that ends a job on money must say which client it holds, so the work is priced in the right " +
        "company. Pass { kind: 'staff' } from a requireStaff session, { kind: 'service', orgId } from a " +
        "service client (see lib/finish-bills-first's module note).",
    ).toEqual([]);
  });

  it("the Stripe webhook — the one service-client door — says so, and nothing else claims the service role", () => {
    const hook = read("src/app/api/stripe/webhook/route.ts");
    expect(/createServiceClient\(\)/.test(hook)).toBe(true);
    expect(/access: \{ kind: "service", orgId/.test(hook)).toBe(true);
    const liars = SRC.filter((f) => f !== "src/app/api/stripe/webhook/route.ts" && /access: \{ kind: "service"/.test(read(f)));
    expect(
      liars,
      "Only a door holding a service client may claim one. A staff client given an org scope reads the pay " +
        "columns 0216 revokes, and every Finish Job press comes back a refusal.",
    ).toEqual([]);
  });
});

/**
 * WHY THE APP-SIDE REFUSAL IS THE ONLY NET — pinned against the database's own words (0371).
 *
 * Needs You's "Done, Not Billed" pile exists to catch finished work nothing has billed. Its finished_jobs
 * arm excludes any job that has an invoice outside ('draft','void') — so a job with a PAID bill is never
 * in it, which is exactly the shape this lane's defect produced. Nothing here is a bug in 0371: the pile
 * is "finished and nothing billed at all", and widening it to "finished and something still unbilled"
 * needs a MIGRATION, which this lane deliberately does not write.
 *
 * This test is the pin. If somebody lands that migration, it FAILS — and whoever lands it reads this note,
 * decides whether the app-side refusal is still the load-bearing one, and updates both together.
 */
describe("migration 0371's Done, Not Billed pile cannot catch a paid job (so the app has to)", () => {
  it("the finished_jobs arm still excludes a job that has any non-draft, non-void bill", () => {
    const live = liveFunctionBody("needs_you_done_not_billed");
    expect(live, "needs_you_done_not_billed is not defined by any migration — the net is gone, which is itself the news").not.toBeNull();
    const body = live!.body.replace(/\s+/g, " ").toLowerCase();
    const arm = body.slice(body.indexOf("finished_jobs as ("));
    expect(arm).toContain("j.status = 'complete'");
    // A PAID invoice is outside ('draft','void'), so this `not exists` keeps the job out of the pile.
    expect(arm).toContain("b.status not in ('draft', 'void')");
    // And it asks nothing at all about hours, receipts or the job's billing type: it counts documents.
    expect(arm).not.toContain("time_entries");
    expect(arm).not.toContain("billing_type");
  });
});
