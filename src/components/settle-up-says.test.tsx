import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dict, translator } from "@/lib/i18n";
import { esTitleCase, titleCaseIn } from "../../tests/title-case-words";

/**
 * THE JOB'S GET PAID SAYS WHAT IT DOES (cn-v1179, decision E), the sheet's half, in both languages:
 * what it says when it opens (JobOwedLines, from the server's one read), and what it says after Record It
 * (paymentLandedWords: the bill, then the job; never "Done" alone). The server's halves are pinned in
 * billing/get-paid-facts.test and billing/settle-up-says.test. Stand-ins only: INV-900 and on.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
// THE SERVER'S OWN READ, for the paid-ahead line (skeptic #82, S1): readGetPaidFacts over the stand-in that
// honours what a read asks, so the sheet is pinned to what the server really says, not to a typed figure.
const gp = vi.hoisted(() => ({ client: null as any, lang: "en" }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: gp.client, userId: "user-1", orgId: "org-larkspur", role: "owner" })) }));
vi.mock("@/lib/lang-of", () => ({ callerLang: vi.fn(async () => gp.lang) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: string; children?: ReactNode; footer?: ReactNode }) => createElement("div", { "data-modal": title }, children, footer),
  ModalActions: () => null,
}));

const { LangProvider } = await import("@/components/lang-provider");
const { JobOwedLines, PaidAheadLine, billFirstMove, paymentLandedWords } = await import("./settle-up-button");
const { readGetPaidFacts } = await import("@/app/(app)/billing/request-actions");
const { fakeDb } = await import("@/lib/prepayment-db.test-util");

const SRC = readFileSync(join(process.cwd(), "src/components/settle-up-button.tsx"), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const draw = (el: ReactElement, lang: "en" | "es" = "en") => renderToStaticMarkup(createElement(LangProvider as never, { lang }, el));
const owed = (facts: unknown, lang: "en" | "es" = "en") => draw(createElement(JobOwedLines as never, { facts }), lang);

const bill = (over: Record<string, unknown> = {}) => ({ id: "inv-900", number: "INV-900", balance: 1250, draft: false, request: false, ...over });
const ok = (over: Record<string, unknown>) => ({ ok: true, open: [], owed: { kind: "bills" }, paidAhead: 0, ...over });

describe("what the job's sheet says when it opens", () => {
  it("one open bill: named with what is left; a draft said as a draft; a payment request said as one", () => {
    expect(text(owed(ok({ open: [bill()] })))).toBe("INV-900 · $1,250.00 left The payment goes on this bill.");
    expect(text(owed(ok({ open: [bill({ draft: true })] })))).toContain("INV-900 (draft) · $1,250.00 left");
    expect(text(owed(ok({ open: [bill({ request: true, balance: 500 })] })))).toBe("Payment Request INV-900 · $500.00 left The payment goes on this payment request.");
    expect(text(owed(ok({ open: [bill()] }), "es"))).toBe("INV-900 · quedan $1,250.00 El pago se registra en esta factura.");
    expect(text(owed(ok({ open: [bill({ request: true, balance: 500 })] }), "es"))).toContain("Solicitud de Pago INV-900 · quedan $500.00");
  });

  it("two or more open bills: each listed with its own door to that bill, in place of a box the server would refuse", () => {
    const html = owed(ok({ open: [bill({ request: true, balance: 500 }), bill({ id: "inv-901", number: "INV-901", balance: 2000 })] }));
    expect(text(html)).toContain("This job has 2 open bills. Take the payment on the one they're paying:");
    expect(html).toContain('href="/billing/inv-900"');
    expect(html).toContain('href="/billing/inv-901"');
    expect(html).toContain('aria-label="Open Payment Request INV-900"');
    expect(html.match(/min-h-11/g)?.length).toBe(2);
    expect(text(owed(ok({ open: [bill(), bill({ id: "inv-901" })] }), "es"))).toContain("Este trabajo tiene 2 facturas abiertas.");
    // The sheet draws no card panel and no amount box under that list.
    expect(SRC).toMatch(/\{manyBills \? null : \(\s*<>\s*\{card\.panel\}\s*\{other\.panel\(!!card\.panel, transferPending\)\}/);
  });

  it("time and material work on no bill (row 6), or a fixed price not all billed (row 7): one sentence, ONE door, the box still there", () => {
    const work = text(owed(ok({ owed: { kind: "work", amount: 812.4 } })));
    expect(work).toBe("Work recorded on this job isn't on a bill yet ($812.40). Bill it first, or record what they paid below as its own invoice. Bill the Work First");
    const price = text(owed(ok({ owed: { kind: "price", contract: 5000, billed: 2000, left: 3000 } })));
    expect(price).toBe("The price is $5,000.00: $2,000.00 is billed and $3,000.00 isn't on a bill yet. Bill it first, or record what they paid below as its own invoice. Bill the Work First");
    expect(text(owed(ok({ owed: { kind: "work", amount: 812.4 } }), "es"))).toContain("Facturar el Trabajo Primero");
  });

  /**
   * RE-PINNED ON PURPOSE (cn-v1179, caught by reading before anyone tapped it). The door was first written
   * as router.push(...) then close() in one tick. In this app a sheet's close steps history back to take
   * its own entry off, the router reads that step as a Back, and a Back discards the navigation still on
   * its way: the sheet would have closed and gone nowhere. On the job's own page the tab changes in place
   * (the tab strip's own way), on the sheet's own entry, and only then does the sheet close.
   */
  it("Bill the Work First: the tab changes IN PLACE on the job's page, then the sheet closes; never a push and a close in one tick", () => {
    expect(billFirstMove("/jobs/j-900", "", "j-900")).toEqual({ kind: "inPlace", url: "/jobs/j-900?tab=invoices" });
    // another tab open, another param in the address: the tab is replaced and the param kept
    expect(billFirstMove("/jobs/j-900", "?tab=tasks&from=lead", "j-900")).toEqual({ kind: "inPlace", url: "/jobs/j-900?tab=invoices&from=lead" });
    expect(billFirstMove("/jobs/j-900/", "?tab=invoices", "j-900")).toEqual({ kind: "inPlace", url: "/jobs/j-900?tab=invoices" });
    // from any other page (another job's page too) it is a navigation to this job's Invoices tab
    expect(billFirstMove("/planner", "", "j-900")).toEqual({ kind: "go", href: "/jobs/j-900?tab=invoices" });
    expect(billFirstMove("/jobs/j-901", "?tab=job", "j-900")).toEqual({ kind: "go", href: "/jobs/j-900?tab=invoices" });
    const fn = SRC.slice(SRC.indexOf("function billFirst()"), SRC.indexOf("function openSheet()"));
    // in place: replaceState, THEN close
    expect(fn).toMatch(/window\.history\.replaceState\(null, "", move\.url\);\n\s+close\(\);/);
    // a navigation leaves the sheet up: the push is followed by a return, never by close()
    expect(fn).toMatch(/router\.push\(move\.href\);\n\s+return;/);
    expect(fn).not.toMatch(/router\.push\([^)]*\);\s*close\(\)/);
  });

  it("nothing owed (row 14), a read behind it lost, the read still on its way, the read refused", () => {
    expect(text(owed(ok({ owed: { kind: "nothing" } })))).toBe("Nothing is owed on this job. An amount recorded here makes a new invoice.");
    expect(text(owed(ok({ owed: { kind: "nothing" } }), "es"))).toBe("No se debe nada en este trabajo. Un monto registrado aquí crea una factura nueva.");
    expect(text(owed(ok({ owed: { kind: "unread" } })))).toBe("Couldn't check what this job still has to bill just now.");
    expect(text(owed(null))).toBe("Reading this job's bills…");
    expect(text(owed({ ok: false, error: "Couldn't read this job's bills just now." }))).toBe("Couldn't read this job's bills just now.");
  });

  it("the sheet reads it once per open, drops a stale answer, prefills only the one open bill's balance and never over a typed figure", () => {
    expect(SRC).toMatch(/readGetPaidFacts\(jobId\)\.then\(/);
    expect(SRC).toContain("if (factsGen.current !== g) return;");
    expect(SRC).toContain("if (f.ok && f.open.length === 1) other.prefill(f.open[0].balance);");
    expect(SRC).toContain('setAmount((was) => (String(was).trim() ? was : balance.toFixed(2)));');
  });

  it("paid ahead is said only from the sheet's own read (money paid, where it comes off), never from the page's prop", () => {
    // RE-PINNED (skeptic #82, S1): the line is its own exported piece, drawn on the same condition.
    expect(SRC).toContain("{jobId && <PaidAheadLine facts={facts} />}");
    expect(SRC).toContain("if (!(facts?.ok && facts.paidAhead > 0.005)) return null;");
    expect(SRC).not.toMatch(/money\(paidAhead\)/);
  });

  it("skeptic #82, S1: a fixed price with money PAID ahead draws no 'comes off' sentence (what is left is already net of it), in both languages", async () => {
    const ORG = "org-larkspur";
    const JOB = "job-900";
    const db = {
      jobs: [{ id: JOB, org_id: ORG, status: "in_progress", billing_type: "fixed", job_number: "J-900", name: "Larkspur Rewire" }],
      quotes: [{ id: "q-900", org_id: ORG, job_id: JOB, status: "accepted", total: 5000, created_at: "2026-10-01T00:00:00Z" }],
      invoices: [{ id: "inv-900", org_id: ORG, job_id: JOB, invoice_kind: "prepayment", title: "Deposit", status: "paid", invoice_number: "INV-900", total: 1000, amount_paid: 1000, created_at: "2026-10-01T00:00:00Z" }],
      invoice_items: [{ id: "inv-900-line", org_id: ORG, invoice_id: "inv-900", description: "Deposit", quantity: 1, unit_price: 1000, line_total: 1000, import_source: "prepayment", prepaid_invoice_id: null }],
      customer_credits: [],
      payments: [],
      payment_milestones: [],
    };
    gp.client = fakeDb(db as never, { org: ORG, writes: [], seq: { n: 100 } });
    for (const lang of ["en", "es"] as const) {
      gp.lang = lang;
      const facts = await readGetPaidFacts(JOB);
      expect(facts).toMatchObject({ ok: true, owed: { kind: "price", left: 4000 } });
      const said = text(draw(createElement("div", null, createElement(JobOwedLines as never, { facts }), createElement(PaidAheadLine as never, { facts })), lang));
      expect(said).toContain(lang === "en" ? "$4,000.00 isn't on a bill yet" : "$4,000.00");
      const comesOff = dict(lang).su_pa_aheadLine.split("{amount}")[1].trim();
      expect(said).not.toContain(comesOff);
      expect(said).not.toContain(dict(lang).su_pa_aheadLine.split("{amount}")[0].trim());
    }
    // and where it IS true, the piece says it, in both languages
    const where = { ok: true, open: [], owed: { kind: "nothing" }, paidAhead: 500 };
    expect(text(draw(createElement(PaidAheadLine as never, { facts: where })))).toBe("Paid ahead and not yet used: $500.00. It comes off this bill.");
    expect(text(draw(createElement(PaidAheadLine as never, { facts: where }), "es"))).toBe("Pagado por adelantado y aún sin usar: $500.00. Se descuenta de esta factura.");
  });
});

describe("what the sheet says after Record It: the bill, then the job, never 'Done' alone", () => {
  const en = translator("en");
  const es = translator("es");
  const l = (over: Record<string, unknown> = {}) => ({ number: "INV-905", made: false, request: false, draft: false, job: "untouched", ...over }) as never;

  it("the bill that took it: made just now, an existing bill, a payment request; a re-tap says it was already recorded", () => {
    expect(paymentLandedWords(l({ made: true, job: "price" }), "$2,000.00", "cash", en)).toEqual([
      "$2,000.00 cash recorded on INV-905, an invoice made just now.",
      "The job stays open: part of its price isn't billed yet. Bill the rest, or tap Finish Job if that's all of it.",
    ]);
    expect(paymentLandedWords(l({ number: "INV-900", job: "finished" }), "$1,250.00", "check", en)).toEqual(["$1,250.00 check recorded on INV-900.", "The job is finished."]);
    expect(paymentLandedWords(l({ number: "INV-900", request: true }), "$500.00", "cash", en)).toEqual([
      "$500.00 cash recorded on the payment request INV-900.",
      "The job's status didn't change.",
    ]);
    expect(paymentLandedWords(l({ number: "INV-900", again: true }), "$500.00", "cash", en)).toEqual(["Already recorded on INV-900: nothing was added."]);
    expect(paymentLandedWords(l({ number: null, again: true }), "$500.00", "cash", en)).toEqual(["Already recorded: nothing was added."]);
    // A bill on no job says nothing of a job.
    expect(paymentLandedWords(l({ job: null }), "$5.00", "cash", en)).toEqual(["$5.00 cash recorded on INV-905."]);
  });

  it("what became of the job, each verdict in both languages", () => {
    const say = (job: string, t: typeof en) => paymentLandedWords(l({ job }), "$1.00", "cash", t)[1];
    expect(say("work", en)).toBe("The job stays open: recorded work isn't on a bill yet.");
    expect(say("not_started", en)).toBe("The job stays open: it hasn't started yet.");
    expect(say("finished", es)).toBe("El trabajo está terminado.");
    expect(say("price", es)).toBe("El trabajo sigue abierto: parte de su precio aún no está facturado. Factura el resto, o toca Terminar el Trabajo si eso es todo.");
    expect(paymentLandedWords(l({ made: true }), "$300.00", "efectivo", es)[0]).toBe("$300.00 en efectivo registrado en INV-905, una factura creada ahora mismo.");
  });

  it("never 'Done' alone: the old toasts are gone from the catalog and the sheet", () => {
    expect(dict("en").su_paidMethodDone).toBeUndefined();
    expect(SRC).not.toMatch(/su_paidMethodDone|su_paidVenmoDone/);
    for (const k of Object.keys(dict("en")).filter((k) => k.startsWith("su_gp_"))) {
      expect(dict("en")[k], k).not.toMatch(/\bDone\b/);
      expect(dict("es")[k], k).toBeTruthy();
    }
  });
});

describe("cash gets the receipt door the card path has", () => {
  it("after Record It the sheet stays on what it did, with the receipt row; never on a draft, never on a re-tap", () => {
    const body = SRC.slice(SRC.indexOf("function useOtherWay("), SRC.indexOf("export function GetPaidButton("));
    expect(body).toMatch(/\{l && !l\.again && \(l\.draft \? \(/);
    expect(body).toContain("<CashReceiptRow invoiceId={recorded.invoiceId} amount={recorded.amount} textReady={props.textReady} />");
    // Record It and Venmo's They Paid both end there, not in a bare close.
    expect(body).toMatch(/landedOn\(id, amt\(\), method, landed\);/);
    expect(body).toMatch(/landedOn\(at\.invoiceId, at\.amount, method,/);
    // It still never reaches the card door, which builds a pay link (and promotes a draft on a yes).
    expect(body).not.toContain("collectArtifacts(");
  });

  it("the cash receipt goes through the one review sheet, and never carries the card's 'paid by card' sentence", () => {
    const row = SRC.slice(SRC.indexOf("function CashReceiptRow("), SRC.indexOf("/** The outcome, named (Apple 5.9)"));
    expect(row.match(/<SendButton kind="receipt"/g)).toHaveLength(2);
    expect(row).not.toMatch(/customerReceiptWords|sms:|navigator\.share|qr/i);
  });
});

describe("the new words", () => {
  it("every new door is Title Case in both languages", () => {
    for (const k of ["su_btn_gp_billWorkFirst", "su_btn_gp_open"]) {
      expect(titleCaseIn(dict("en")[k], "en"), k).toBe(true);
      expect(esTitleCase(dict("es")[k]), k).toBe(true);
    }
  });
  it("the two lines that promised a bill a card never writes now say what is true (G5)", () => {
    expect(dict("en").su_cardOnJobLine).not.toMatch(/writes one|writes the bill/);
    expect(dict("en").su_cardOnVisitLine).not.toMatch(/writes the bill/);
    expect(dict("es").su_cardOnJobLine).not.toMatch(/escribe una/);
    expect(dict("es").su_cardOnVisitLine).not.toMatch(/escribe la factura/);
  });
});
