import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { titleCaseIn } from "../../../../../tests/title-case-words";

/**
 * WON · START THE JOB, THE SHEET (cn-v1176). The owner, 2026-11-21: "an instant create and approve
 * estimate button at the bottom which would run the proper cycle of things ... and pop into the new
 * job". The server decides what the sheet shows; these draw each answer in both languages, check that
 * Approve waits for every hole, that the sheet sends keys and typed numbers only, and pin the house
 * laws on the source: one Modal, never keyed or remounted; the id minted once per opening; no confirm;
 * the door waits for a real save; the address opens it and closing takes `won` off.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../won-actions", () => ({ readWonSheet: vi.fn(), approveVisitEstimate: vi.fn() }));
vi.mock("../start-job-actions", () => ({ startJobFromSale: vi.fn() }));
vi.mock("../actions", () => ({ linkAppointmentTo: vi.fn() }));
vi.mock("../../billing/request-actions", () => ({ readPaymentRequestSeed: vi.fn(), requestPayment: vi.fn() }));

import { WonSheet, WonSheetBody, WonSheetHost, overridesFromTyped, wonDepositDoor, type WonDeposit, type WonPhase, type WonTyped } from "./won-sheet";
import type { PaymentRequestSeed } from "@/app/(app)/billing/request-actions";
import type { WonLine, WonSheet as WonRead } from "@/lib/appointments/won-sheet";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const SHEET_SRC = src("src/app/(app)/appointments/[id]/won-sheet.tsx");
const INSPECTOR_SRC = src("src/app/(app)/appointments/[id]/inspector.tsx");

const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ open: m[0].match(/^<button[^>]*>/)![0], text: textOf(m[0]) }));
const TARGET = /min-h-\[44px\]|\bh-11\b|\bh-12\b/;

const priced: WonLine = { key: "scope:scope:R1", description: "Remodel scope", quantity: 2, unit: "EA", unitPrice: 500, amount: 1000, hole: null };
const zero: WonLine = { key: "typed:0", description: "200 ft wire", quantity: 1, unit: "ea", unitPrice: 0, amount: 0, hole: { kind: "zero", flag: null } };
const flagged: WonLine = { key: "task:t2:labor", description: "Hot tub wires", quantity: 0, unit: null, unitPrice: 0, amount: 0, hole: { kind: "flag", flag: "hours?" } };

type Ok = Extract<WonRead, { ok: true }>;
const estimate = (over: Partial<Extract<Ok, { state: "estimate" }>> = {}): Ok => ({
  ok: true,
  state: "estimate",
  source: "visit",
  quote: null,
  stamp: "abc12345",
  lines: [priced, zero],
  taxRate: 0,
  subtotal: 1000,
  tax: 0,
  total: 1000,
  billingKind: "tm",
  noCustomer: false,
  ...over,
});

const draw = (
  phase: WonPhase,
  over: { lang?: string; typed?: WonTyped; busy?: boolean; note?: string | null; billing?: "tm" | "fixed"; deposit?: WonDeposit; depositNote?: string | null } = {},
) =>
  renderToStaticMarkup(
    createElement(WonSheetBody, {
      phase,
      lang: over.lang ?? "en",
      billing: over.billing ?? "tm",
      onBilling: () => {},
      typed: over.typed ?? {},
      onTyped: () => {},
      busy: over.busy ?? false,
      note: over.note ?? null,
      onRetry: () => {},
      onApprove: () => {},
      onFinish: () => {},
      onChoosePlain: () => {},
      onStartPlain: () => {},
      deposit: over.deposit,
      depositNote: over.depositNote ?? null,
    }),
  );
const sheet = (s: Ok): WonPhase => ({ k: "sheet", sheet: s });
const approveButton = (html: string) => buttons(html).find((b) => /Approve and Start the Job|Aprobar y Empezar el Trabajo/.test(b.text))!;
const disabled = (b: { open: string }) => /\sdisabled=""/.test(b.open);

describe("each answer the server gives, drawn, in both languages", () => {
  const PHASES: [string, WonPhase][] = [
    ["reading", { k: "reading" }],
    ["failed", { k: "failed", error: "The read failed." }],
    ["estimate from the visit", sheet(estimate())],
    ["estimate that stands", sheet(estimate({ source: "existing", quote: { id: "q-1", number: "E-900" }, lines: [priced] }))],
    ["plain: nothing priced", sheet({ ok: true, state: "plain", why: "nothing_priced", billingKind: "tm", noCustomer: true })],
    ["plain: Estimates off", sheet({ ok: true, state: "plain", why: "estimates_off", billingKind: "fixed", noCustomer: false })],
    ["plain: chosen", { k: "plain_chosen", noCustomer: false }],
    ["finish", sheet({ ok: true, state: "finish", quote: { id: "q-1", number: "E-900" }, total: 1000, billingKind: "fixed" })],
    ["has a job", sheet({ ok: true, state: "has_job", job: { id: "j-1", number: "J-900" } })],
    ["refer", sheet({ ok: true, state: "refer", quote: { id: "q-1", number: "E-900" }, job: { id: "j-1", number: "J-900" } })],
    ["done: approved", { k: "done", how: "approve", quote: { id: "q-1", number: "E-900" }, total: 1234.5, job: { id: "j-1", number: "J-900" } }],
    ["done: plain", { k: "done", how: "plain", quote: null, total: null, job: { id: "j-1", number: "J-900" } }],
  ];
  const EN: Record<string, string[]> = {
    reading: ["Reading the inspection…"],
    failed: ["The read failed.", "Try Again"],
    "estimate from the visit": ["Remodel scope", "2 × $500.00 = $1,000.00", "No price yet", "Qty", "Price", "Remove", "Subtotal", "Total", "$1,000.00", "Billing", "Time & Material", "Fixed Price", "Approve and Start the Job", "Give each line without a price its number, or remove it.", "Start the Job with No Estimate"],
    // cn-v1176 fixes F1 + F8 (re-pinned): "will be approved" (nothing is approved yet), and no
    // "Start the Job with No Estimate" beside an estimate that stands (pinned below).
    "estimate that stands": ["E-900 will be approved as it stands.", "Approve and Start the Job"],
    "plain: nothing priced": ["Nothing priced was recorded on this inspection.", "Start the Job", "The job will have no customer until one is added."],
    "plain: Estimates off": ["Estimates is switched off for your company.", "Start the Job"],
    "plain: chosen": ["The job starts with no estimate.", "Start the Job"],
    finish: ["E-900 is accepted and has no job yet.", "Finish the Job from E-900"],
    "has a job": ["This inspection already has its job: J-900.", "Open the Job"],
    // cn-v1176 fix F9 (re-pinned): the sheet draws its own button and names it by its exact words.
    refer: ["E-900 is accepted and already has its job, J-900: tap Tie This Inspection to J-900.", "Tie This Inspection to J-900"],
    "done: approved": ["Approved · E-900 · $1,234.50", "Open the Job", "Open the Estimate"],
    "done: plain": ["Job started", "Open the Job"],
  };
  const ES: Record<string, string[]> = {
    reading: ["Leyendo la inspección…"],
    failed: ["Intentar de Nuevo"],
    "estimate from the visit": ["Todavía sin precio", "Cant.", "Precio", "Quitar", "Subtotal", "Total", "Facturación", "Tiempo y Material", "Precio Fijo", "Aprobar y Empezar el Trabajo", "Empezar el Trabajo sin Presupuesto"],
    "estimate that stands": ["E-900 se aprobará tal como está."],
    "plain: nothing priced": ["No se registró nada con precio en esta inspección.", "Empezar el Trabajo", "El trabajo no tendrá cliente hasta que se agregue uno."],
    "plain: Estimates off": ["Presupuestos está apagado para tu empresa."],
    "plain: chosen": ["El trabajo empieza sin presupuesto."],
    finish: ["E-900 está aceptado y todavía no tiene trabajo.", "Crear el Trabajo desde E-900"],
    "has a job": ["Esta inspección ya tiene su trabajo: J-900.", "Abrir el Trabajo"],
    refer: ["E-900 está aceptado y ya tiene su trabajo, J-900: toca Unir Esta Inspección a J-900.", "Unir Esta Inspección a J-900"],
    "done: approved": ["Aprobado · E-900", "Abrir el Trabajo", "Abrir el Presupuesto"],
    "done: plain": ["Trabajo empezado", "Abrir el Trabajo"],
  };
  for (const [name, phase] of PHASES) {
    it(`${name}: English`, () => {
      const t = textOf(draw(phase));
      for (const w of EN[name]) expect(t, w).toContain(w);
    });
    it(`${name}: Spanish, and no English door left`, () => {
      const html = draw(phase, { lang: "es" });
      const t = textOf(html);
      for (const w of ES[name]) expect(t, w).toContain(w);
      for (const b of buttons(html)) expect(b.text, b.text).not.toMatch(/\b(Start|Open|Approve|Remove|Finish|Try)\b/);
    });
    it(`${name}: every door is Title Case in both languages and 44px`, () => {
      for (const lang of ["en", "es"] as const) {
        for (const b of buttons(draw(phase, { lang }))) {
          if (!b.text) continue;
          expect(titleCaseIn(b.text, lang), `${lang}: ${b.text}`).toBe(true);
          expect(b.open, b.text).toMatch(TARGET);
        }
      }
    });
  }

  it("cn-v1178 (decision 2): an estimate that stands, and finish, SAY the paper's kind and offer no choice; only the visit's own lines ask", () => {
    const stands = draw(sheet(estimate({ source: "existing", quote: { id: "q-1", number: "E-900" }, lines: [priced], billingKind: "fixed" })));
    expect(textOf(stands)).toContain("The job bills as Fixed Price, as the paper says.");
    expect(stands).not.toContain('role="radiogroup"');
    const fin = draw(sheet({ ok: true, state: "finish", quote: { id: "q-1", number: "E-900" }, total: 1000, billingKind: "tm" }), { lang: "es" });
    expect(textOf(fin)).toContain("El trabajo se cobra como Tiempo y Material, como dice el documento.");
    expect(fin).not.toContain('role="radiogroup"');
    expect(draw(sheet(estimate()))).toContain('role="radiogroup"');
  });

  it("the done step: with no deposit door, Open the Job is the boxed one and the estimate's door is quiet", () => {
    const html = draw({ k: "done", how: "approve", quote: { id: "q-1", number: "E-900" }, total: 1234.5, job: { id: "j-1", number: "J-900" } });
    expect(html).toContain('href="/jobs/j-1"');
    expect(html).toContain('href="/quotes/q-1"');
    const [job, est] = buttons(html);
    expect(job.text).toBe("Open the Job");
    expect(job.open).toContain("bg-[rgb(var(--glass-ink))]");
    expect(est.text).toBe("Open the Estimate");
    expect(est.open).not.toContain("bg-[rgb(var(--glass-ink))]");
  });

  // cn-v1177: the slot the last release left ("cn-v1177: the deposit goes here") is filled.
  const REQ = { id: "inv-1", number: "INV-900", token: "tok", label: "Deposit", amount: 1000, balance: 1000, status: "sent" };
  const done = (how: "approve" | "plain"): WonPhase =>
    how === "approve"
      ? { k: "done", how, quote: { id: "q-1", number: "E-900" }, total: 12000, job: { id: "j-1", number: "J-900" } }
      : { k: "done", how, quote: null, total: null, job: { id: "j-1", number: "J-900" } };
  it("the done step's deposit, after an approval: Take the Deposit Now · $X, Get Paid on INV-900, or the paid line, in both languages", () => {
    const take = buttons(draw(done("approve"), { deposit: { k: "take", amount: 1000, quoteId: "q-1" } }));
    expect(take[0].text).toBe("Take the Deposit Now · $1,000.00");
    expect(take[0].open).toMatch(TARGET);
    expect(buttons(draw(done("approve"), { lang: "es", deposit: { k: "take", amount: 1000, quoteId: "q-1" } }))[0].text).toBe("Cobrar el Anticipo Ahora · $1,000.00");
    expect(titleCaseIn("Take the Deposit Now · $1,000.00")).toBe(true);
    expect(titleCaseIn("Cobrar el Anticipo Ahora · $1,000.00", "es")).toBe(true);
    const live = buttons(draw(done("approve"), { deposit: { k: "live", request: REQ } }));
    expect(live[0].text).toBe("Get Paid on INV-900");
    expect(buttons(draw(done("approve"), { lang: "es", deposit: { k: "live", request: REQ } }))[0].text).toBe("Cobrar INV-900");
    const paid = textOf(draw(done("approve"), { deposit: { k: "paid", request: { ...REQ, balance: 0 } } }));
    expect(paid).toContain("INV-900: the deposit is paid.");
    expect(buttons(draw(done("approve"), { deposit: { k: "paid", request: { ...REQ, balance: 0 } } }))[0].text).toBe("Open the Job");
    // A read that failed is said, with where to take it instead; a refusal is said as the server worded it.
    expect(textOf(draw(done("approve"), { deposit: { k: "unread" } }))).toContain("The deposit couldn't be read just now. Take it from the job's Invoices tab.");
    expect(textOf(draw(done("approve"), { deposit: { k: "take", amount: 5, quoteId: null }, depositNote: "Refused." }))).toContain("Refused.");
  });
  it("nothing on a plain start, and nothing when the seed says no deposit", () => {
    for (const d of [{ k: "take", amount: 1000, quoteId: null }, { k: "live", request: REQ }] as WonDeposit[]) {
      expect(buttons(draw(done("plain"), { deposit: d }))[0].text).toBe("Open the Job");
    }
    expect(buttons(draw(done("approve"), { deposit: { k: "none" } }))[0].text).toBe("Open the Job");
    // The slot sits between the warnings and the two doors.
    expect(SHEET_SRC).toMatch(/THE DEPOSIT \(cn-v1177\)[\s\S]*?<div className="flex flex-wrap gap-2">\n\s+<Link href=\{`\/jobs\/\$\{phase\.job\.id\}`\}>/);
  });
  it("wonDepositDoor: take only with a deposit due, a customer, a job not over and no live request", () => {
    const seed = (over: Partial<Extract<PaymentRequestSeed, { ok: true }>> = {}, deposit: Partial<Extract<PaymentRequestSeed, { ok: true }>["deposit"]> = {}): PaymentRequestSeed => ({
      ok: true,
      job: { id: "j-1", number: "J-900", over: false, hasCustomer: true },
      deposit: { due: 1000, quote: { id: "q-1", number: "E-900" }, request: null, ...deposit },
      materials: { unbilled: 0, suggested: 0 },
      requests: [],
      leftToNet: 0,
      canTakeCard: true,
      ...over,
    });
    expect(wonDepositDoor(seed())).toEqual({ k: "take", amount: 1000, quoteId: "q-1" });
    expect(wonDepositDoor(seed({ job: { id: "j-1", number: null, over: false, hasCustomer: false } }))).toEqual({ k: "none" });
    expect(wonDepositDoor(seed({ job: { id: "j-1", number: null, over: true, hasCustomer: true } }))).toEqual({ k: "none" });
    expect(wonDepositDoor(seed({}, { due: 0 }))).toEqual({ k: "none" });
    expect(wonDepositDoor(seed({}, { request: REQ }))).toEqual({ k: "live", request: REQ });
    expect(wonDepositDoor(seed({}, { request: { ...REQ, balance: 0 } }))).toEqual({ k: "paid", request: { ...REQ, balance: 0 } });
    expect(wonDepositDoor({ ok: false, error: "x" })).toEqual({ k: "unread" });
  });
  it("one tap, one request: the deposit's press is guarded while it is out, and it opens the EXISTING Get Paid sheet on the request's bill", () => {
    expect(SHEET_SRC).toMatch(/if \(deposit\.k !== "take" \|\| depositInFlight\.current\) return;\n\s+depositInFlight\.current = true;/);
    expect(SHEET_SRC).toContain('import { GetPaidButton } from "@/components/settle-up-button";');
    expect(SHEET_SRC).toMatch(/<GetPaidButton\s+key=\{payFor\.id\}\s+source="invoice"\s+invoiceId=\{payFor\.id\}\s+balance=\{payFor\.balance\}\s+trigger="none"\s+open=\{payOpen\}/);
    // The company's payment methods, Venmo and texting facts come with the seed when it has them (cn-v1177 seams).
    expect(SHEET_SRC).toContain("setPayFacts(seed.payDoor ?? null);");
    expect(SHEET_SRC).toMatch(/cardEnabled=\{cardOn\}\n\s+methods=\{payFacts\?\.methods\}\n\s+venmoConfigured=\{payFacts\?\.venmoConfigured\}\n\s+textReady=\{payFacts\?\.textReady\}/);
    // Read once, after an approval that made a job; a plain start never reads it.
    expect(SHEET_SRC.match(/void readDeposit\(/g)).toHaveLength(1);
    expect(SHEET_SRC).toMatch(/how: "approve"[^\n]*\n\s+router\.refresh\(\);\n\s+void readDeposit\(r\.job\.id\);/);
  });

  it("a warning is never dropped: each one is said under the done line, on both paths", () => {
    const plain = textOf(draw({ k: "done", how: "plain", quote: null, total: null, job: { id: "j-1", number: "J-900" }, warnings: ["The typed rows did not reach the job's list."] }));
    expect(plain).toMatch(/Job started The typed rows did not reach the job's list\. Open the Job/);
    const approved = textOf(draw({ k: "done", how: "approve", quote: { id: "q-1", number: "E-900" }, total: 10, job: { id: "j-1", number: "J-900" }, warnings: ["One.", "Two."] }));
    expect(approved).toContain("One. Two.");
    expect(SHEET_SRC).toContain("setPhase({ k: \"done\", how: \"plain\", quote: null, total: null, job: r.job, warnings: r.warnings });");
    expect(SHEET_SRC).toContain("setPhase({ k: \"done\", how: \"approve\", quote: r.quote, total: r.total, job: r.job, warnings: r.warnings });");
  });

  it("one button, one name: the Start a Job refusal quotes the Finish button's own words, in both languages", async () => {
    const { translator, fillText } = await import("@/lib/i18n");
    for (const lang of ["en", "es"] as const) {
      const t = translator(lang);
      expect(fillText(t("vp_saleEstimateAccepted"), { estimate: "E-900" }), lang).toContain(fillText(t("vi_btn_wonFinishFrom"), { n: "E-900" }));
    }
  });

  it("cn-v1176 fixes F1 + F8 + F9: each refusal names a button by the exact words the page shows, in both languages", async () => {
    const { translator, fillText } = await import("@/lib/i18n");
    for (const lang of ["en", "es"] as const) {
      const t = translator(lang);
      expect(fillText(t("vp_saleEstimateStands"), { estimate: "E-900" }), lang).toContain(t("vi_btn_approveAndStartTheJob"));
      expect(t("qs_wonNothingToApprove"), lang).toContain(t("vp_btn_startTheJob"));
      expect(t("vi_wonNoLinesLeft"), lang).toContain(t("vi_btn_wonPutBack"));
      expect(t("vi_wonNoLinesLeft"), lang).toContain(t("vi_btn_startTheJobWithNoEstimate"));
      const tie = fillText(t("vi_btn_wonTieTo"), { j: "J-900" });
      expect(fillText(t("qs_wonRefer"), { quote: "E-900", job: "J-900", tie }), lang).toContain(tie);
    }
  });

  it("finish preselects the kind the read says (its estimate's own word), never a guess", () => {
    expect(SHEET_SRC).toContain('(r.state === "estimate" || r.state === "plain" || r.state === "finish")) setBilling(r.billingKind);');
  });

  it("the billing kind the server read is the one preselected", () => {
    expect(draw(sheet(estimate()), { billing: "fixed" })).toMatch(/aria-checked="true"[^>]*>Fixed Price</);
    expect(draw(sheet(estimate()), { billing: "tm" })).toMatch(/aria-checked="true"[^>]*>Time &amp; Material</);
  });

  it("an existing estimate shows ITS lines and totals, and a hole there is ONE link, Open E-900", () => {
    const s = estimate({ source: "existing", quote: { id: "q-1", number: "E-900" }, lines: [priced, zero], subtotal: 1000, total: 1000 });
    const html = draw(sheet(s));
    const t = textOf(html);
    expect(t).toContain("E-900 has a line with no price. Open it and price that line first.");
    expect(html).toContain('href="/quotes/q-1"');
    expect(t).toContain("Open E-900");
    expect(disabled(approveButton(html))).toBe(true);
    expect(html).not.toContain('inputMode="decimal"'); // a hole on an existing estimate is answered there, not here
  });

  it("cn-v1176 fix F1: Start the Job with No Estimate is drawn ONLY on the visit's own lines, never beside an estimate that stands", () => {
    expect(textOf(draw(sheet(estimate())))).toContain("Start the Job with No Estimate");
    for (const lang of ["en", "es"] as const) {
      const t = textOf(draw(sheet(estimate({ source: "existing", quote: { id: "q-1", number: "E-900" }, lines: [priced] })), { lang }));
      expect(t, lang).not.toMatch(/Start the Job with No Estimate|Empezar el Trabajo sin Presupuesto/);
    }
    // A refusal from the plain start is said and the sheet reads again (it then shows what stands).
    expect(SHEET_SRC).toMatch(/const r = await startJobFromSale\(appointmentId, \{ billingType: billing \}\);[\s\S]*?setNote\(r\.error\);\n\s+await read\(true\);/);
  });

  it("cn-v1176 fix F3: a row with a price and no quantity keeps Approve shut and asks for its quantity, in both languages", () => {
    const noQty: WonLine = { key: "typed:5", description: "Weatherhead", quantity: 0, unit: "ea", unitPrice: 0, amount: 0, hole: { kind: "zero", flag: null } };
    const s = estimate({ lines: [priced, noQty] });
    const priceOnly = draw(sheet(s), { typed: { "typed:5": { price: "50" } } });
    expect(disabled(approveButton(priceOnly))).toBe(true);
    expect(textOf(priceOnly)).toContain("No quantity yet");
    expect(textOf(draw(sheet(s), { lang: "es", typed: { "typed:5": { price: "50" } } }))).toContain("Todavía sin cantidad");
    const both = draw(sheet(s), { typed: { "typed:5": { qty: "2", price: "50" } } });
    expect(disabled(approveButton(both))).toBe(false);
    expect(textOf(both)).toContain("$1,100.00");
  });

  it("cn-v1176 fix F7: an estimate that stands with NO lines is a hole: Approve shut, one sentence naming its one link, Open E-900", () => {
    for (const lang of ["en", "es"] as const) {
      const html = draw(sheet(estimate({ source: "existing", quote: { id: "q-1", number: "E-900" }, lines: [], subtotal: 0, total: 0 })), { lang });
      expect(disabled(approveButton(html)), lang).toBe(true);
      expect(html).toContain('href="/quotes/q-1"');
      expect(textOf(html)).toContain(lang === "en" ? "E-900 has no lines yet. Tap Open E-900 and add them first." : "E-900 todavía no tiene líneas. Toca Abrir E-900 y agrégalas primero.");
      expect(textOf(html)).toContain(lang === "en" ? "Open E-900" : "Abrir E-900");
    }
  });

  it("cn-v1176 fix F9: the refer state's ONE quiet button ties this inspection to that job through the attach door, then reads again", () => {
    const html = draw(sheet({ ok: true, state: "refer", quote: { id: "q-1", number: "E-900" }, job: { id: "j-1", number: "J-900" } }));
    expect(buttons(html).map((b) => b.text)).toEqual(["Tie This Inspection to J-900"]);
    const noNumber = draw(sheet({ ok: true, state: "refer", quote: { id: "q-1", number: null }, job: { id: "j-1", number: null } }));
    expect(textOf(noNumber)).toContain("tap Tie This Inspection to the Job.");
    expect(SHEET_SRC).toContain('const r = await linkAppointmentTo(appointmentId, "job", job.id);');
    expect(SHEET_SRC).toMatch(/async function tie\(job: WonRef\) \{[\s\S]*?await read\(true\);/);
    expect(SHEET_SRC).toContain("onTie={(job) => void tie(job)}");
  });

  it("cn-v1176 fix F2: where the page draws no Inspector, a small host opens the one sheet from `?won=1` by the same address rule", () => {
    expect(renderToStaticMarkup(createElement(WonSheetHost, { appointmentId: "a-1", wonAsked: true }))).toBe("");
    const host = SHEET_SRC.slice(SHEET_SRC.indexOf("export function WonSheetHost"), SHEET_SRC.indexOf("export function WonSheetBody"));
    expect(host).toMatch(/if \(wonAsked\) \{\n\s+fromAddressRef\.current = true;[\s\S]*?router\.replace\(addressWithoutWon\(pathname, search, hash\), \{ scroll: false \}\);/);
    expect(host).toContain("<WonSheet appointmentId={appointmentId} open={open} onClose={() => setOpen(false)} />");
    expect(host).not.toMatch(/\bkey=/);
    const page = src("src/app/(app)/appointments/[id]/page.tsx");
    expect(page).toContain("{wonDoor && !(showInspector && !inspectionUnread) && <WonSheetHost appointmentId={a.id} wonAsked={openWon} />}");
  });

  it("nothing new is amber (amber is a real clock)", () => {
    expect(SHEET_SRC).not.toMatch(/amber/);
  });
});

describe("Approve waits for every hole, and the sheet sends keys and typed numbers only", () => {
  it("disabled while a hole stands, with one sentence; enabled once the hole is priced; totals redraw", () => {
    const before = draw(sheet(estimate()));
    expect(disabled(approveButton(before))).toBe(true);
    const after = draw(sheet(estimate()), { typed: { "typed:0": { price: "40" } } });
    expect(disabled(approveButton(after))).toBe(false);
    expect(textOf(after)).toContain("$1,040.00");
    expect(textOf(after)).not.toContain("Give each line without a price its number");
  });
  it("a flagged line says its flag, as the estimate editor does, and is answered by a price", () => {
    const s = estimate({ lines: [priced, flagged] });
    expect(textOf(draw(sheet(s)))).toContain("hours?");
    const answered = draw(sheet(s), { typed: { "task:t2:labor": { qty: "3", price: "90" } } });
    expect(disabled(approveButton(answered))).toBe(false);
    expect(textOf(answered)).toContain("$1,270.00");
  });
  it("Remove takes the line out of the total and offers it back; every line removed keeps Approve shut", () => {
    const removed = draw(sheet(estimate()), { typed: { "typed:0": { remove: true } } });
    expect(disabled(approveButton(removed))).toBe(false);
    expect(textOf(removed)).toContain("Put It Back");
    const none = draw(sheet(estimate()), { typed: { "typed:0": { remove: true }, "scope:scope:R1": { remove: true } } });
    expect(disabled(approveButton(none))).toBe(true);
    // cn-v1176 fix F8 (re-pinned): the two doors by their exact Title Case words, both on the page here.
    expect(textOf(none)).toContain("Every line was removed: tap Put It Back on one, or Start the Job with No Estimate.");
    expect(buttons(none).map((b) => b.text)).toEqual(expect.arrayContaining(["Put It Back", "Start the Job with No Estimate"]));
    const noneEs = textOf(draw(sheet(estimate()), { lang: "es", typed: { "typed:0": { remove: true }, "scope:scope:R1": { remove: true } } }));
    expect(noneEs).toContain("Se quitaron todas las líneas: toca Volver a Ponerla en una, o Empezar el Trabajo sin Presupuesto.");
  });
  it("busy: Approve and every door are shut while a call is out", () => {
    const html = draw(sheet(estimate()), { typed: { "typed:0": { price: "40" } }, busy: true });
    for (const b of buttons(html)) expect(disabled(b), b.text).toBe(true);
  });
  it("the overrides: by key, removed or typed, never a number the door would refuse", () => {
    const lines = [priced, zero, flagged];
    expect(overridesFromTyped(lines, {})).toEqual([]);
    expect(overridesFromTyped(lines, { "typed:0": { remove: true } })).toEqual([{ key: "typed:0", remove: true }]);
    // A count typed on a line whose price is known sends the price the box shows with it.
    expect(overridesFromTyped(lines, { "scope:scope:R1": { qty: "3" } })).toEqual([{ key: "scope:scope:R1", quantity: 3, unitPrice: 500 }]);
    expect(overridesFromTyped(lines, { "typed:0": { price: "$1,250.5" } })).toEqual([{ key: "typed:0", quantity: 1, unitPrice: 1250.5 }]);
    // Zero or below as a count, below zero or text as a price: not sent.
    expect(overridesFromTyped(lines, { "task:t2:labor": { qty: "0", price: "-4" } })).toEqual([]);
    expect(overridesFromTyped(lines, { "task:t2:labor": { qty: "abc", price: "0" } })).toEqual([{ key: "task:t2:labor", unitPrice: 0 }]);
    // Put back: nothing sent for it.
    expect(overridesFromTyped(lines, { "typed:0": { remove: false } })).toEqual([]);
    // A key the read did not show is never sent.
    expect(overridesFromTyped(lines, { "typed:9": { price: "5" } })).toEqual([]);
  });
});

describe("the house laws, on the source", () => {
  it("ONE Modal, never keyed; the Inspector draws the sheet for the office whatever the door says, never keyed", () => {
    expect(SHEET_SRC.match(/<Modal\s/g)).toHaveLength(1); // the one drawn (a comment's "<Modal>" is not one)
    expect(SHEET_SRC).toContain('<Modal open={open} onClose={onClose} title={t("vi_btn_wonStartTheJob")} holdOpen={busy || depositBusy} size="md">');
    expect(INSPECTOR_SRC.match(/<WonSheet\b/g)).toHaveLength(1);
    expect(INSPECTOR_SRC).toContain("{office && <WonSheet appointmentId={appointmentId} open={wonOpen} onClose={closeWon} />}");
    expect(INSPECTOR_SRC).not.toMatch(/<WonSheet[^>]*\bkey=/);
    // Each opening is reset with state, never with a key.
    expect(SHEET_SRC).toMatch(/if \(open && !wasOpen\.current\) \{[\s\S]*?setTyped\(\{\}\);[\s\S]*?void read\(\);/);
  });
  it("closed, it draws nothing; open, it is the one sheet with its title", () => {
    expect(renderToStaticMarkup(createElement(WonSheet, { appointmentId: "a-1", open: false, onClose: () => {} }))).toBe("");
    const open = textOf(renderToStaticMarkup(createElement(WonSheet, { appointmentId: "a-1", open: true, onClose: () => {} })));
    expect(open).toContain("Won · Start the Job");
    expect(open).toContain("Reading the inspection…");
  });
  it("the id for a new estimate is minted once per opening and reused on every retry of it", () => {
    expect(SHEET_SRC.match(/crypto\.randomUUID\(\)/g)).toHaveLength(1);
    expect(SHEET_SRC).toMatch(/if \(open && !wasOpen\.current\) \{\n\s+openingRef\.current \+= 1;\n\s+quoteIdRef\.current = crypto\.randomUUID\(\);/);
    expect(SHEET_SRC).toContain("void approve(quoteIdRef.current, s.stamp, overridesFromTyped(s.lines, typed));");
    // An existing estimate and a finish approve by that estimate's own id, with no lines of the sheet's.
    expect(SHEET_SRC).toContain("void approve(s.quote.id, s.stamp, []);");
    expect(SHEET_SRC).toContain('onFinish={(quote) => void approve(quote.id, "", [])}');
    // Buttons are shut while a call is out, and the X too (holdOpen).
    expect(SHEET_SRC).toContain("if (busy) return;");
  });
  it("no browser confirm anywhere in the sheet or the door", () => {
    expect(SHEET_SRC).not.toMatch(/\bconfirm\(/);
    const door = INSPECTOR_SRC.slice(INSPECTOR_SRC.indexOf("// ── WON · START THE JOB (cn-v1176)"), INSPECTOR_SRC.indexOf("const setAnswer = "));
    expect(door.length).toBeGreaterThan(200);
    expect(door).not.toMatch(/\bconfirm\(/);
  });
  it("the sheet draws only the server's answer and sends back keys and typed numbers (the plain path names the billing kind only)", () => {
    expect(SHEET_SRC).toContain("const r = await readWonSheet(appointmentId);");
    expect(SHEET_SRC).toContain("const r = await approveVisitEstimate({ appointmentId, quoteId, stamp, overrides, billingType: billing });");
    expect(SHEET_SRC).toContain("const r = await startJobFromSale(appointmentId, { billingType: billing });");
    // A reread when the server asks for one; job:null is said, then read again.
    expect(SHEET_SRC).toMatch(/setNote\(r\.error\);\n\s+if \(r\.reread\) await read\(true\);/);
    expect(SHEET_SRC).toMatch(/if \(r\.ok\) \{[\s\S]*?setNote\(r\.warnings\.join\(" "\)[\s\S]*?await read\(true\);/);
  });
});

describe("the door waits for a real save, and the address opens the sheet", () => {
  it("flushNow sends what is pending, waits for a write already out, and answers whether it landed", () => {
    expect(INSPECTOR_SRC).toMatch(
      /async function flushNow\(\): Promise<boolean> \{\n\s+if \(timer\.current\) clearTimeout\(timer\.current\);\n\s+const prior = inflightRef\.current;\n\s+if \(prior\) await prior;[\s\S]*?return flush\(\);\n\s+\}/,
    );
    expect(INSPECTOR_SRC).toContain("function flush(explicit = false): Promise<boolean> {");
    // Nothing to write is a landed save; a refusal, a failure or no signal is not; a write is ok only when every part said ok.
    expect(INSPECTOR_SRC).toContain("if (explicit) setSavedAt(Date.now());\n      return Promise.resolve(true);");
    expect(INSPECTOR_SRC).toMatch(/const restore = \(msg: string, again = true\) => \{[\s\S]*?settle\(false\);\n\s+\};/);
    expect(INSPECTOR_SRC).toMatch(/setSavedAt\(Date\.now\(\)\);\n\s+settle\(true\);/);
    expect(INSPECTOR_SRC).toContain("inflightRef.current = done;");
    expect(INSPECTOR_SRC).toMatch(/start\(async \(\) => \{[\s\S]*?\}\);\n\s+return done;\n\s+\}/);
  });
  it("the door opens the sheet only after flushNow says the save landed; Start the Estimate waits too", () => {
    expect(INSPECTOR_SRC).toContain("if (await flushNow()) setWonOpen(true);");
    expect(INSPECTOR_SRC).toContain("if (await flushNow()) router.push(href);");
    expect(INSPECTOR_SRC).toMatch(/\{office && wonDoor && \(\n\s+<Button type="button" variant="outline" disabled=\{wonWaiting\} onClick=\{\(\) => void openWon\(\)\}>/);
  });
  it("`?won=1` opens it on first load and when the address gains it: `won` comes off first (no scroll jump), then it opens", () => {
    expect(INSPECTOR_SRC).toMatch(
      /useEffect\(\(\) => \{\n\s+if \(!office\) return;\n\s+if \(wonAsked\) \{\n\s+wonFromAddressRef\.current = true;[\s\S]*?router\.replace\(addressWithoutWon\(pathname, search, hash\), \{ scroll: false \}\);\n\s+return;\n\s+\}\n\s+if \(wonFromAddressRef\.current\) \{\n\s+wonFromAddressRef\.current = false;\n\s+void openWon\(\);/,
    );
    expect(INSPECTOR_SRC).toContain("}, [wonAsked]);");
    // Closing changes no address under the Modal's own history step.
    expect(INSPECTOR_SRC).toMatch(/function closeWon\(\) \{\n\s+setWonOpen\(false\);\n\s+\}/);
  });
});
