import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { titleCaseIn } from "../../tests/title-case-words";
import { LangProvider } from "@/components/lang-provider";
import type { PaymentRequestSeed, PrepaymentView } from "@/app/(app)/billing/request-actions";
import type { RequestRef } from "@/lib/payment-request";

/**
 * REQUEST A PAYMENT (cn-v1177). The form draws what the job's seed recorded and nothing else: a deposit
 * the accepted estimate stored, the marked-up materials no bill carries yet, or an EMPTY box that asks.
 * One live deposit request per estimate is shown with its doors, never a second Create. The made step
 * hands the bill to the EXISTING send sheet and the EXISTING Get Paid sheet. Stand-ins: J-900, E-900,
 * INV-900.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
// The sheet drawn open, so what it says can be read (the real Modal renders nothing while closed).
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: string; children?: ReactNode; footer?: ReactNode }) => createElement("div", { "data-modal": title }, children, footer),
  ModalActions: () => null,
}));
vi.mock("@/app/(app)/billing/request-actions", () => ({ readPaymentRequestSeed: vi.fn(), requestPayment: vi.fn() }));

const { RequestPaymentBody, PaidAheadCard, prefillFor, typedAmount, firstPurpose, refusalKey, requestPaidWord } = await import("./request-payment");
const { SettleUpButton } = await import("./settle-up-button");
type Body = Parameters<typeof RequestPaymentBody>[0];

const SRC = readFileSync(join(process.cwd(), "src/components/request-payment.tsx"), "utf8");
const SETTLE = readFileSync(join(process.cwd(), "src/components/settle-up-button.tsx"), "utf8");

const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const buttons = (html: string) => [...html.matchAll(/<(button|a)[^>]*>[\s\S]*?<\/\1>/g)].map((m) => textOf(m[0]));
const inputValue = (html: string, id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0].match(/value="([^"]*)"/)?.[1] ?? null;

type SeedOk = Extract<PaymentRequestSeed, { ok: true }>;
const REQ: RequestRef = { id: "inv-1", number: "INV-900", token: "tok-1", label: "Deposit", amount: 1000, balance: 1000, status: "sent" };
const seed = (over: Partial<SeedOk> = {}, deposit: Partial<SeedOk["deposit"]> = {}, materials: Partial<SeedOk["materials"]> = {}): SeedOk => ({
  ok: true,
  job: { id: "j-1", number: "J-900", over: false, hasCustomer: true },
  deposit: { due: 1000, quote: { id: "q-1", number: "E-900" }, request: null, ...deposit },
  materials: { unbilled: 0, suggested: 0, ...materials },
  requests: [],
  leftToNet: 0,
  canTakeCard: true,
  ...over,
});

const draw = (phase: Body["phase"], over: Partial<Body> = {}) =>
  renderToStaticMarkup(
    createElement(RequestPaymentBody, {
      phase,
      lang: "en",
      purpose: "deposit",
      amount: "",
      name: "",
      note: null,
      busy: false,
      onPurpose: () => {},
      onAmount: () => {},
      onName: () => {},
      onRetry: () => {},
      onCreate: () => {},
      onSend: () => {},
      onTake: () => {},
      onDone: () => {},
      ...over,
    }),
  );

describe("what the Amount box starts with is what was recorded, or nothing", () => {
  it("a deposit: the figure the accepted estimate stored; none stored, or a live request for it, is an empty box", () => {
    expect(prefillFor(seed(), "deposit")).toBe("1000.00");
    expect(prefillFor(seed({}, { due: 0 }), "deposit")).toBe("");
    expect(prefillFor(seed({}, { request: REQ }), "deposit")).toBe("");
  });
  it("materials: the seed's suggested figure; nothing recorded (or all of it already asked for ahead) is EMPTY, never the estimate's figure", () => {
    expect(prefillFor(seed({}, {}, { unbilled: 812.5, suggested: 612.5 }), "materials")).toBe("612.50");
    expect(prefillFor(seed({}, { due: 1000 }, { unbilled: 0, suggested: 0 }), "materials")).toBe("");
    expect(prefillFor(seed({ leftToNet: 900 }, {}, { unbilled: 400, suggested: 0 }), "materials")).toBe("");
    expect(prefillFor(seed(), "other")).toBe("");
  });
  it("the opening's purpose: Deposit while one is due with no live request, else Materials", () => {
    expect(firstPurpose(seed())).toBe("deposit");
    expect(firstPurpose(seed({}, { request: REQ }))).toBe("materials");
    expect(firstPurpose(seed({}, { due: 0 }))).toBe("materials");
  });
  it("a typed amount: above $0, dollar signs and commas allowed", () => {
    expect(typedAmount("$1,250.5")).toBe(1250.5);
    expect(typedAmount("0")).toBeNull();
    expect(typedAmount("")).toBeNull();
    expect(typedAmount("abc")).toBeNull();
    expect(typedAmount("-5")).toBeNull();
  });
});

describe("the form, drawn", () => {
  it("Deposit, with the estimate's figure: the three choices, the line it comes off, Create the Request", () => {
    const s = seed();
    const html = draw({ k: "form", seed: s }, { amount: prefillFor(s, "deposit") });
    expect(inputValue(html, "rq-amount")).toBe("1000.00");
    const text = textOf(html);
    expect(text).toContain("The deposit E-900 states.");
    expect(text).toContain("It comes off this job's next invoice.");
    expect(buttons(html)).toEqual(["Deposit", "Materials", "Other", "Create the Request"]);
  });
  it("ONE LIVE DEPOSIT REQUEST PER ESTIMATE: INV-900 already asks for it, its doors are drawn, and there is no Create", () => {
    const html = draw({ k: "form", seed: seed({}, { request: REQ }) });
    expect(textOf(html)).toContain("INV-900 already asks for this deposit.");
    const b = buttons(html);
    expect(b).not.toContain("Create the Request");
    expect(b).toEqual(expect.arrayContaining(["Send the Link", "Take It Now", "Open INV-900"]));
    expect(html).toContain('href="/billing/inv-1"');
    expect(inputValue(html, "rq-amount")).toBeNull();
    // Paid already: no Take It Now, and said.
    const paid = draw({ k: "form", seed: seed({}, { request: { ...REQ, balance: 0 } }) });
    expect(buttons(paid)).not.toContain("Take It Now");
    expect(textOf(paid)).toContain("INV-900 is paid.");
  });
  it("Materials with nothing recorded: an EMPTY box and the line that asks; with materials recorded, the facts under it", () => {
    const none = draw({ k: "form", seed: seed() }, { purpose: "materials", amount: "" });
    expect(inputValue(none, "rq-amount")).toBe("");
    expect(textOf(none)).toContain("No materials are recorded on this job yet. Type the amount.");
    const s = seed({ leftToNet: 200 }, {}, { unbilled: 812.5, suggested: 612.5 });
    const some = textOf(draw({ k: "form", seed: s }, { purpose: "materials", amount: prefillFor(s, "materials") }));
    expect(some).toContain("Materials recorded on this job and not yet billed: $812.50");
    expect(some).toContain("Already asked for ahead: $200.00");
    expect(textOf(draw({ k: "form", seed: seed({}, {}, { unbilled: 50, suggested: 50 }) }, { purpose: "materials" }))).not.toContain("Already asked for ahead");
  });
  it("Other asks its name, which the customer reads on the bill", () => {
    const html = draw({ k: "form", seed: seed() }, { purpose: "other" });
    expect(html).toContain('id="rq-name"');
    expect(textOf(html)).toContain("The customer reads this name on the bill.");
  });
  it("a job that is over, or has no customer: the reason in one sentence naming one action, and no form", () => {
    const over = draw({ k: "form", seed: seed({ job: { id: "j-1", number: "J-900", over: true, hasCustomer: true } }) });
    expect(textOf(over)).toContain("This job is finished or cancelled, so there is no next invoice for a payment to come off. Bill it with a new invoice.");
    expect(over).not.toContain('id="rq-amount"');
    const nobody = draw({ k: "form", seed: seed({ job: { id: "j-1", number: "J-900", over: false, hasCustomer: false } }) });
    expect(textOf(nobody)).toContain("This job has no customer to ask. Add the customer on the job's Overview first.");
    expect(buttons(nobody)).toEqual(["Done"]);
    expect(refusalKey(seed())).toBeNull();
  });
  it("reading, a failed read (said, with Try Again), a refusal said as the server worded it with the request in the way", () => {
    expect(textOf(draw({ k: "reading" }))).toContain("Reading this job's payments…");
    const failed = draw({ k: "failed", error: "The read failed." });
    expect(textOf(failed)).toContain("The read failed.");
    expect(buttons(failed)).toEqual(["Try Again"]);
    const refused = draw({ k: "form", seed: seed() }, { note: "Refused in one sentence.", blocking: REQ });
    expect(textOf(refused)).toContain("Refused in one sentence.");
    expect(buttons(refused)).toEqual(expect.arrayContaining(["Open INV-900"]));
  });
  it("while the request is out the button says so and is shut", () => {
    const html = draw({ k: "form", seed: seed() }, { busy: true });
    const create = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Creating…<\/button>/)?.[0] ?? "";
    expect(create).toMatch(/\sdisabled=""/);
  });
});

describe("the made step: the bill goes to the doors that already exist", () => {
  it("its number, name and amount, then Send the Link, Take It Now, Open INV-900 and Done", () => {
    const html = draw({ k: "made", seed: seed(), request: { ...REQ, label: "Materials Payment", amount: 612.5, balance: 612.5 }, existing: false });
    expect(textOf(html)).toContain("INV-900 asks for $612.50: Materials Payment.");
    expect(buttons(html)).toEqual(["Send the Link", "Take It Now", "Open INV-900", "Done"]);
    const again = textOf(draw({ k: "made", seed: seed(), request: REQ, existing: true }));
    expect(again).toContain("INV-900 already asks for this deposit, so nothing new was made.");
  });
  it("Send the Link is the review-before-send sheet (kind invoice) and Take It Now the one Get Paid sheet (source invoice), for that bill", () => {
    expect(SRC).toContain('import { SendSheet } from "@/components/send-sheet";');
    expect(SRC).toContain('import { GetPaidButton } from "@/components/settle-up-button";');
    expect(SRC).toMatch(/<SendSheet kind="invoice" id=\{sendFor\.id\}/);
    expect(SRC).toMatch(/<GetPaidButton\s+key=\{payFor\.id\}\s+source="invoice"\s+invoiceId=\{payFor\.id\}\s+balance=\{payFor\.balance\}\s+trigger="none"\s+open=\{payOpen\}/);
    // It makes a payment request and nothing else: never a deposit draw.
    expect(SRC).not.toContain("createProgressInvoice");
  });
  it("in Spanish", () => {
    const html = draw({ k: "made", seed: seed(), request: REQ, existing: false }, { lang: "es" });
    expect(buttons(html)).toEqual(["Enviar el Enlace", "Cobrarlo Ahora", "Abrir INV-900", "Hecho"]);
    expect(buttons(draw({ k: "form", seed: seed() }, { lang: "es" }))).toEqual(["Anticipo", "Materiales", "Otro", "Crear la Solicitud"]);
    expect(textOf(draw({ k: "form", seed: seed() }, { lang: "es", purpose: "materials" }))).toContain("Aún no hay materiales registrados en este trabajo. Escribe el monto.");
  });
  it("every door is Title Case in both languages", () => {
    const all = [
      ...buttons(draw({ k: "form", seed: seed({}, { request: REQ }) })),
      ...buttons(draw({ k: "made", seed: seed(), request: REQ, existing: false })),
      "Request a Payment",
      "Request a Deposit or Materials Payment",
      "Create the Request",
      "Open the Request",
    ];
    for (const b of all) expect(titleCaseIn(b), b).toBe(true);
    const es = [
      ...buttons(draw({ k: "form", seed: seed({}, { request: REQ }) }, { lang: "es" })),
      ...buttons(draw({ k: "made", seed: seed(), request: REQ, existing: false }, { lang: "es" })),
      "Solicitar un Pago",
      "Solicitar un Anticipo o Pago de Materiales",
      "Crear la Solicitud",
      "Abrir la Solicitud",
    ];
    for (const b of es) expect(titleCaseIn(b, "es"), b).toBe(true);
  });
});

describe("one Spanish word for a deposit (cn-v1177 seams)", () => {
  it("every Spanish value of the form's, Paid Ahead's and the Won sheet's keys says anticipo, never depósito, and never the old 'no se hizo'", async () => {
    const { dict } = await import("@/lib/i18n");
    const es = dict("es");
    const mine = Object.keys(es).filter((k) => /^su_(?:rp_|pa_|btn_rp|btn_request)|^vi_(?:btn_won(?:TakeDeposit|GetPaidOn)|wonDeposit|wonTheDeposit)/.test(k));
    expect(mine.length).toBeGreaterThanOrEqual(50);
    for (const k of mine) {
      expect(es[k], k).not.toMatch(/dep[oó]sito/i);
      expect(es[k], k).not.toMatch(/no se hizo/i);
    }
    expect(es.su_btn_rpDeposit).toBe("Anticipo");
    expect(es.vi_btn_wonGetPaidOnTheDeposit).toBe("Cobrar el Anticipo");
    expect(es.vi_wonDepositPaid).toBe("{n}: el anticipo está pagado.");
  });
});

describe("the house laws, on the source", () => {
  it("ONE Modal, never keyed; each opening resets its fields with state and reads once", () => {
    expect(SRC.match(/<Modal\s/g)).toHaveLength(1);
    expect(SRC).not.toMatch(/<Modal[^>]*\bkey=/);
    expect(SRC).toMatch(/if \(open && !wasOpen\.current\) \{[\s\S]*?setName\(""\);[\s\S]*?setAmount\(""\);[\s\S]*?void read\(\);/);
  });
  it("ONE REQUEST PER PRESS: the flight is claimed before the request goes out and let go only when it is back", () => {
    const create = SRC.slice(SRC.indexOf("async function create()"), SRC.indexOf("const cardEnabled ="));
    expect(create).toMatch(/if \(phase\.k !== "form" \|\| inFlight\.current\) return;/);
    expect(create.indexOf("inFlight.current = true;")).toBeGreaterThan(-1);
    expect(create.indexOf("inFlight.current = true;")).toBeLessThan(create.indexOf("await requestPayment("));
    expect(create).toMatch(/finally \{\n\s+inFlight\.current = false;/);
    // No await between the check and the claim: a second tap in the same tick finds it taken.
    const between = create.slice(create.indexOf("inFlight.current) return;"), create.indexOf("inFlight.current = true;"));
    expect(between).not.toContain("await");
    // A live deposit request for the estimate is never asked for twice from here.
    expect(create).toContain('if (purpose === "deposit" && seed.deposit.request) return;');
  });
});

describe("the job hub's Get Paid: one quiet link, and the sheet's own behavior unchanged", () => {
  it("source job draws Request a Deposit or Materials Payment inside the same Get Paid sheet; the visit's does not", () => {
    const job = textOf(renderToStaticMarkup(createElement(SettleUpButton as never, { source: "job", id: "j-1", compact: true, cardEnabled: true, methods: ["Cash"] })));
    expect(job).toContain("Send the Bill & Show Card QR");
    expect(job).toContain("Request a Deposit or Materials Payment");
    const visit = textOf(renderToStaticMarkup(createElement(SettleUpButton as never, { source: "appointment", id: "a-1", cardEnabled: true, methods: ["Cash"] })));
    expect(visit).not.toContain("Request a Deposit");
    const es = textOf(renderToStaticMarkup(createElement(LangProvider as never, { lang: "es" }, createElement(SettleUpButton as never, { source: "job", id: "j-1", compact: true, cardEnabled: true }))));
    expect(es).toContain("Solicitar un Anticipo o Pago de Materiales");
  });
  it("money paid ahead and not yet used is said in the job's sheet, in both languages; the sheet prefills nothing from the work", () => {
    const job = (over: Record<string, unknown>) => ({ source: "job", id: "j-1", compact: true, cardEnabled: true, methods: ["Cash"], ...over });
    expect(textOf(renderToStaticMarkup(createElement(SettleUpButton as never, job({ paidAhead: 1000 }))))).toContain("Paid ahead and not yet used: $1,000.00. It comes off this bill.");
    expect(textOf(renderToStaticMarkup(createElement(SettleUpButton as never, job({ paidAhead: 0 }))))).not.toContain("Paid ahead");
    expect(textOf(renderToStaticMarkup(createElement(SettleUpButton as never, job({}))))).not.toContain("Paid ahead");
    const es = textOf(renderToStaticMarkup(createElement(LangProvider as never, { lang: "es" }, createElement(SettleUpButton as never, job({ paidAhead: 250 })))));
    expect(es).toContain("Pagado por adelantado y aún sin usar: $250.00. Se descuenta de esta factura.");
    // The job's amount box starts empty: no figure from the work to lower.
    const html = renderToStaticMarkup(createElement(SettleUpButton as never, job({ paidAhead: 1000 })));
    expect(html.match(/<input[^>]*id="rp-amount"[^>]*>/)?.[0]).toMatch(/value=""/);
  });
  it("the hand-off opens the form FIRST and closes the sheet in the next commit (the form is on top when the sheet's entry comes off)", () => {
    expect(SETTLE).toMatch(/handOff\.onPress\(\);\n\s+setHandingOff\(true\);/);
    expect(SETTLE).toMatch(/useEffect\(\(\) => \{\n\s+if \(!handingOff\) return;\n\s+setHandingOff\(false\);\n\s+close\(\);/);
    // The form is mounted on its first opening and never keyed.
    expect(SETTLE).toMatch(/\{formMounted && \(\n\s+<RequestPaymentSheet\n\s+jobId=\{jobId\}\n\s+open=\{formOpen\}/);
    // settleUp stays the sheet's own door: the job hub's sheet is still GetPaidButton source "job".
    expect(SETTLE).toMatch(/<GetPaidButton\n\s+source="job"\n\s+id=\{jobId\}/);
  });
});

describe("Paid Ahead", () => {
  const view = (over: Partial<PrepaymentView> = {}): PrepaymentView => ({ ...REQ, paid: 0, refunded: 0, taken: [], left: 1000, moneyLeft: 0, ...over });
  const card = (s: Parameters<typeof PaidAheadCard>[0]) => renderToStaticMarkup(createElement(PaidAheadCard, s));
  it("nothing when the job has no live request; the failed read said", () => {
    expect(card({ seed: { requests: [], leftToNet: 0, jobOver: false } })).toBe("");
    expect(textOf(card({ seed: null, readError: true }))).toBe("The payments asked for ahead on this job couldn't be read just now. Reload the page.");
  });
  it("each request: number, name, amount, Paid or Unpaid (never amber), what each bill took off, and what comes off next", () => {
    const html = card({
      seed: {
        requests: [view({ paid: 1000, balance: 0, taken: [{ invoiceId: "inv-2", number: "INV-901", amount: 400 }], left: 600 }), view({ id: "inv-3", number: "INV-902", label: "Materials Payment", amount: 500, balance: 300, paid: 200, left: 500 })],
        leftToNet: 1100,
        jobOver: false,
      },
    });
    const text = textOf(html);
    expect(text).toContain("Paid Ahead");
    expect(text).toMatch(/INV-900 · Deposit \$1,000\.00 Paid/);
    expect(text).toContain("INV-901 took off $400.00");
    expect(text).toMatch(/INV-902 · Materials Payment \$500\.00 Unpaid \$200\.00 paid so far/);
    expect(text).toContain("Comes off the next invoice: $1,100.00");
    expect(text).not.toContain("never used");
    expect(html).not.toMatch(/amber/);
    expect(requestPaidWord({ balance: 0.004 })).toBe("su_pa_paid");
  });
  it("a job that is over with money in hand no bill used: the sentence and the door to the request's bill", () => {
    const html = card({ seed: { requests: [view({ paid: 1000, balance: 0, moneyLeft: 1000, left: 0 })], leftToNet: 0, jobOver: true } });
    expect(textOf(html)).toContain("$1,000.00 was paid and never used. Refund it from INV-900.");
    expect(html.match(/href="\/billing\/inv-1"/g)?.length).toBe(2);
  });
});

