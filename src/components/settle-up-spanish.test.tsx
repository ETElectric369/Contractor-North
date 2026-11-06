import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, dict, fillText, translator } from "@/lib/i18n";
import { TEXTS_NOT_READY_LINE } from "@/lib/sms-readiness";
import { sendFirstDetail, sendFirstQuestion } from "@/lib/pay-door-words";
import { esTitleCase, titleCaseIn } from "../../tests/title-case-words";

/**
 * THE SETTLE UP BUTTON IN SPANISH (the visit-page-in-Spanish wave, cn-v1144, su_). The one Get Paid
 * sheet rendered inside a LangProvider with "es": its doors read the catalog's Title Case Spanish, its
 * lines its sentences, a slot is filled, and no English door is left on it. The English renders are the
 * sheet's own test (settle-up-button.test), untouched, with no provider: English is the default, byte
 * for byte — and the table at the bottom pins every su_ key's English to the literal it replaced.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
// The sheet drawn open, so what it says can be read (the real Modal renders nothing while closed).
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: string; children?: ReactNode; footer?: ReactNode }) =>
    createElement("div", { "data-modal": title }, children, footer),
  ModalActions: ({ saveLabel, cancelLabel }: { saveLabel?: string; cancelLabel?: string }) =>
    createElement("div", { "data-actions": `${cancelLabel} / ${saveLabel}` }),
}));

const { LangProvider } = await import("@/components/lang-provider");
const { GetPaidButton, SettleUpButton, holdCardLine, customerReceiptWords, customerPayLinkText } = await import("./settle-up-button");

const es = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="es">{el}</LangProvider>);
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const INV = { source: "invoice" as const, invoiceId: "09ff65de-2ec8-4884-a31f-583a8943b09a", balance: 1558.62 };
const sheet = (props: Record<string, unknown>) => es(createElement(GetPaidButton as never, props));
const t = translator("es");

describe("the Get Paid sheet speaks Spanish to a Spanish reader", () => {
  it("the door, the title with what is owed, the card panel first, then Or They Paid Another Way with its fields", () => {
    const html = sheet({ ...INV, cardEnabled: true, methods: ["Cash", "Check", "Credit Card", "Venmo"] });
    expect(html).toContain('data-modal="Cobrar $1,558.62"');
    const body = text(html);
    expect(body).toMatch(/^Cobrar /);
    const card = body.indexOf("Mostrar QR de Tarjeta");
    const other = body.indexOf("O Pagaron de Otra Forma");
    expect(card).toBeGreaterThan(-1);
    expect(other).toBeGreaterThan(card);
    for (const w of ["Dinero que se movió fuera de Stripe", "Monto", "Cómo pagaron", "Fecha de Pago", "Nota", "Registrarlo"]) expect(body, w).toContain(w);
    expect(html).toContain('placeholder="$ monto"');
    expect(html).toContain('placeholder="p. ej. cheque #1042"');
    expect(html).not.toMatch(/Show Card QR|Or They Paid Another Way|Record It|Date Paid|How they paid/);
  });

  it("the four methods the sheet names itself read in Spanish; a brand and the company's own spelling stay as typed", () => {
    const html = sheet({ ...INV, cardEnabled: true, methods: ["Cash", "Check", "Transfer", "Other", "Venmo", "Credit Card", "Apple Cash"] });
    for (const w of [">Efectivo<", ">Cheque<", ">Transferencia<", ">Otro<", ">Venmo<", ">Apple Cash<"]) expect(html, w).toContain(w);
    expect(html).not.toContain(">Cash<");
    expect(html).not.toContain(">Credit Card<"); // Card is the card panel's, dropped by key as always
  });

  it("with cards off: Cómo Pagaron, and where cards get switched on", () => {
    const body = text(sheet({ ...INV, cardEnabled: false, methods: ["Cash"] }));
    expect(body).toContain("Cómo Pagaron");
    expect(body).not.toContain("O Pagaron de Otra Forma");
    expect(body).toContain("Las tarjetas aún no están activadas para esta empresa: Ajustes → Cobros → Configurar Pagos con Tarjeta toma unos cinco minutos.");
    expect(body).not.toContain("Set Up Card Payments");
  });

  it("a bank transfer on its way: the page's sentence, then don't record it by hand, in Spanish", () => {
    const body = text(sheet({ ...INV, cardEnabled: true, transferPending: "Una transferencia bancaria de $1,558.62 viene en camino." }));
    expect(body).toContain("Una transferencia bancaria de $1,558.62 viene en camino. No lo registres a mano, o se cuenta dos veces.");
  });

  it("the small link under a draft asks ¿Cobrar Ahora?; the job hub's and the visit's SettleUpButton opens Cobrar and sends the bill first", () => {
    expect(text(sheet({ ...INV, trigger: "link" }))).toMatch(/^¿Cobrar Ahora\?/);
    const job = es(createElement(SettleUpButton as never, { source: "job", id: "j-1", compact: true, cardEnabled: true, methods: ["Cash"] }));
    expect(job).toContain('data-modal="Cobrar"');
    expect(text(job)).toContain("Enviar la Factura y Mostrar QR de Tarjeta");
    expect(text(job)).toContain("Una tarjeta se cobra sobre la factura abierta del trabajo");
    const visit = text(es(createElement(SettleUpButton as never, { source: "appointment", id: "a-1", cardEnabled: true, methods: ["Cash"] })));
    expect(visit).toContain("Una tarjeta escribe la factura, la envía y marca la visita como hecha");
    expect(visit).not.toMatch(/Send the Bill|Get Paid/);
  });

  it("the last sentence before Apple owns the screen carries the door's own cents, in Spanish; English is the default", () => {
    expect(holdCardLine(606803, "es")).toBe("Acerca su tarjeta a la parte de arriba del teléfono: $6,068.03");
    expect(holdCardLine(606803)).toBe("Hold their card to the top of the phone: $6,068.03");
    expect(holdCardLine(123, "en")).toBe("Hold their card to the top of the phone: $1.23");
  });

  it("Send INV-078 as the bill first?: the shared words say it in Spanish when handed the language, and in English by default", () => {
    expect(sendFirstQuestion("INV-078", "es", t)).toBe("¿Enviar INV-078 como factura primero?");
    expect(sendFirstQuestion(null, "es", t)).toBe("¿Enviar esta factura como factura primero?"); // mirrors "Send this invoice as the bill first?" word for word
    expect(sendFirstDetail("INV-078", "card", "es", t)).toMatch(/^INV-078 sigue en borrador, así que aún no hay factura que pagar\./);
    expect(sendFirstDetail(null, "payment", "es", t)).toMatch(/^Esta factura sigue en borrador, y esto la paga completa\./);
    // The server refusal (lib/pay-door-send) and every caller that hands no language: the old English, byte for byte.
    expect(sendFirstQuestion("INV-078")).toBe("Send INV-078 as the bill first?");
    expect(sendFirstQuestion(null)).toBe("Send this invoice as the bill first?");
    expect(sendFirstDetail("INV-078")).toBe(fillText(dict("en").su_sendFirstCard, { doc: "INV-078" }));
    expect(sendFirstDetail(null, "payment")).toBe(fillText(dict("en").su_sendFirstPayment, { doc: "This invoice" }));
    // A translator handed with "en" still answers English: say() only turns to the catalog for "es".
    expect(sendFirstQuestion("INV-078", "en", translator("en"))).toBe("Send INV-078 as the bill first?");
  });

  it("the sheet's source reads every word through t(): no English literal, no *_LINE constant", () => {
    const src = readFileSync(join(process.cwd(), "src/components/settle-up-button.tsx"), "utf8");
    expect(src).toContain('import { useLang } from "@/components/lang-provider";');
    expect(src).toContain('import { fillText, translator } from "@/lib/i18n";');
    expect(src).not.toContain("TEXTS_NOT_READY_LINE");
    expect(src).not.toContain("ASK_ADMIN");
    expect(src).not.toContain("UPDATE_IOS");
  });

  it("what the CUSTOMER reads from the tech's phone stays English under a Spanish reader — the receipt's share text, its sms body and the pay-link text — while the sheet's own words are Spanish (the customer has no language yet)", () => {
    const src = readFileSync(join(process.cwd(), "src/components/settle-up-button.tsx"), "utf8");
    // The mechanism, on the source: one translator pinned to English for the customer, the way start-job-actions pins the office bell.
    expect(src).toContain('const customer_t = translator("en");');
    expect(src).toContain("({ title, line } = customerReceiptWords(outcome, receipt, amount));");
    expect(src).toContain("await navigator.share({ title, text: line, url: link });");
    expect(src).toContain("href={`sms:?body=${encodeURIComponent(`${line} ${link}`)}`}");
    expect(src).toContain("encodeURIComponent(customerPayLinkText(art.invoiceNumber, amount, art.payUrl))");
    expect(src).toContain("href={`sms:?body=${smsBody}`}");
    // The customer's date is en-US too: it sits inside the customer's line, never the reader's locale.
    expect(src).toContain('date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })');
    expect(src).not.toContain("toLocaleDateString(localeOf(lang)");
    // No customer-bound key is read through the tech's t(): each appears only inside customer_t(…).
    const customerKeys = ["su_invoiceN", "su_yourInvoice", "su_receiptTitle", "su_declinedTitle", "su_paidLine", "su_declinedLine", "su_payLinkSms", "su_invoiceDash"];
    expect(src).not.toMatch(new RegExp(`\\bt\\((?:outcome === "paid" \\? )?"(?:${customerKeys.join("|")})"`));
    for (const k of customerKeys) {
      const reads = src.split(`"${k}"`).length - 1;
      expect(reads, k).toBeGreaterThan(0);
      expect(src.split(new RegExp(`customer_t\\((?:outcome === "paid" \\? )?"${k}"|customer_t\\(outcome === "paid" \\? "su_\\w+" : "${k}"`)).length - 1, k).toBe(reads);
    }
    expect(src.split("customer_t(").length - 1).toBe(6); // the receipt's inv (two), its title and line, the pay link's text and inv
    // The composed strings: English, byte for byte the old sentences, whatever language the sheet is drawn in.
    const receipt = { link: "https://x", business: "Larkspur Electric", invoiceNumber: "1042" };
    const on = new Date("2026-11-05T12:00:00Z");
    expect(customerReceiptWords("paid", receipt, 150, on)).toEqual({
      title: "Receipt — Invoice 1042",
      line: "Larkspur Electric: Invoice 1042 — $150.00 paid by card on Nov 5, 2026. Your receipt:",
    });
    expect(customerReceiptWords("declined", receipt, 150, on)).toEqual({
      title: "Card declined — Invoice 1042",
      line: "Larkspur Electric: Invoice 1042 — $150.00 card payment declined on Nov 5, 2026; nothing was charged. The invoice is still open:",
    });
    expect(customerReceiptWords("paid", { business: "", invoiceNumber: null }, 42, on).line).toBe("Your invoice — $42.00 paid by card on Nov 5, 2026. Your receipt:");
    expect(customerPayLinkText("1042", 150, "https://x")).toBe("Invoice 1042 — $150.00. Pay by card here: https://x");
    expect(customerPayLinkText(null, 150, "https://x")).toBe("$150.00. Pay by card here: https://x");
    // The same sheet drawn for a Spanish reader: its doors are Spanish, and the customer's words carry no Spanish —
    // they are the catalog's English through translator("en"), the sentences the old sheet assembled.
    expect(text(sheet({ ...INV, cardEnabled: true, methods: ["Cash"] }))).toContain("Mostrar QR de Tarjeta");
    const en = translator("en");
    const line = customerReceiptWords("paid", receipt, 150, on).line;
    const pay = customerPayLinkText("1042", 150, "https://x");
    for (const s of [line, pay]) expect(s).not.toMatch(/Factura|Recibo|pagado|Paga con tarjeta/);
    expect(line).toBe(fillText(en("su_paidLine"), { who: "Larkspur Electric: ", inv: fillText(en("su_invoiceN"), { n: "1042" }), amount: "$150.00", date: "Nov 5, 2026" }));
    expect(pay).toBe(fillText(en("su_payLinkSms"), { inv: fillText(en("su_invoiceDash"), { n: "1042" }), amount: "$150.00", url: "https://x" }));
    // The dormant Spanish is still there, by design, until a customer carries a language.
    expect(dict("es").su_paidLine).not.toBe(dict("en").su_paidLine);
    expect(dict("es").su_payLinkSms).not.toBe(dict("en").su_payLinkSms);
  });
});

describe("the Settle Up catalog (su_)", () => {
  const su = CATALOGS.find((c) => c.prefix === "su_")!;
  /** English Title Case through the one judge (tests/title-case-words, cn-v1148). */
  const titleCase = (s: string) => titleCaseIn(s, "en");

  it("names the one screen that reads it, and nothing else", () => {
    expect(su).toBeTruthy();
    expect(su.files).toEqual(["src/components/settle-up-button.tsx"]);
  });

  it("every su_btn_ key is Title Case in both languages; Apple's short form is Apple's in both and is not a su_btn_ key", () => {
    const doors = Object.keys(su.en).filter((k) => k.startsWith("su_btn_"));
    expect(doors.length).toBeGreaterThanOrEqual(28);
    for (const k of doors) {
      expect(titleCase(su.en[k]), `en:${k} "${su.en[k]}"`).toBe(true);
      expect(esTitleCase(su.es[k]), `es:${k} "${su.es[k]}"`).toBe(true); // Spanish: the significant words (cn-v1147)
    }
    expect(su.en.su_apple_tapToPay).toBe("Tap to Pay");
    expect(su.es.su_apple_tapToPay).toBe("Tap to Pay");
    expect(su.sameInBoth).toContain("su_apple_tapToPay");
    // The full name in a sentence is Apple's own Spanish.
    expect(su.es.su_gettingReady).toContain("Tap to Pay en el iPhone");
    expect(su.es.su_askAdmin).toContain("Tap to Pay en el iPhone");
  });

  it("the house words: Cobrar, Factura, Borrador, Recibo, Hecho, Ajustes › Cobros, Intentar de Nuevo, Cancelar, Atrás", () => {
    expect(su.es.su_btn_getPaid).toBe("Cobrar");
    expect(dict("es").jb_getPaid).toBe(su.es.su_btn_getPaid);
    expect(su.es.su_btn_done).toBe(dict("es").ag_btn_done);
    expect(su.es.su_btn_cancel).toBe(dict("es").ag_btn_cancel);
    expect(su.es.su_btn_saving).toBe(dict("es").ag_btn_saving);
    expect(su.es.su_btn_tryAgain).toBe(dict("es").sh_tryAgain);
    expect(su.es.su_btn_back).toBe(dict("es").sh_back);
    expect(su.es.su_cardsNotOn).toContain(`${dict("es").sh_settings} → ${dict("es").nv_set_getpaid}`);
    expect(su.es.su_receipt).toBe("Recibo");
    expect(su.es.su_sendFirstCard).toContain("borrador");
  });

  it("every English value is the literal it replaced, byte for byte", () => {
    const replaced: Record<string, string> = {
      su_btn_getPaid: "Get Paid",
      su_btn_gettingPaidNow: "Getting Paid Now?",
      su_getPaidAmount: "Get Paid {amount}",
      su_cardsNotOnForCompany: "Cards aren't switched on for this company yet: Settings → Getting Paid → Set Up Card Payments takes about five minutes.",
      su_apple_tapToPay: "Tap to Pay",
      su_cardOnJobLine: "A card is taken on the job's open bill (or writes one if there's none), then the card door goes in front of the customer.",
      su_cardOnVisitLine: "A card writes the bill, sends it, and marks the visit done — then the card door goes in front of the customer.",
      su_btn_gettingItReady: "Getting It Ready…",
      su_btn_showCardQr: "Show Card QR",
      su_btn_sendBillShowCardQr: "Send the Bill & Show Card QR",
      su_draftAtOpen: "{doc} is still a draft, so a card asks to send it as the bill first. Money recorded below doesn't.",
      su_thisInvoiceCap: "This invoice",
      su_scanToPay: "Scan to pay — {amount}",
      su_scanToPayByCard: "Scan to pay by card",
      su_cardApplePayLine: "Card, Apple Pay or Google Pay on their phone. It records itself the moment it lands.",
      su_btn_textThePayLink: "Text the Pay Link",
      su_btn_copied: "Copied",
      su_btn_copyLink: "Copy Link",
      su_waitingForPayment: "Waiting for the payment…",
      su_payLinkNote: "Text the Pay Link sends from this phone’s number. Copy Link to send it from the business line.",
      su_payLinkSms: "{inv}{amount}. Pay by card here: {url}",
      su_invoiceDash: "Invoice {n} — ",
      su_holdCard: "Hold their card to the top of the phone: {amount}",
      su_gettingReady: "Getting Tap to Pay on iPhone ready…",
      su_gettingReadyPct: "Getting Tap to Pay on iPhone ready… {percent}%",
      su_appleSettingUp: "Apple is setting this iPhone up as a card reader — the first time takes a minute or two.",
      su_processingPayment: "Processing the payment…",
      su_confirmingStripe: "Confirming with Stripe — a few seconds.",
      su_turningOnTap: "Turning on Tap to Pay on iPhone — Apple's terms come up first.",
      su_appleGuideUp: "Apple's guide to Tap to Pay on iPhone is up.",
      su_appleGuideUnavailable: "Apple's guide isn't available on this iPhone — the steps are in Settings › Getting Paid › How to Tap.",
      su_balanceChanged: "The balance changed while Apple's terms were up. Press Tap to Pay again for the new amount.",
      su_cardApprovedChecking: "Card approved — checking with Stripe…",
      su_askAdmin: "Ask an owner or admin to enable Tap to Pay on iPhone first.",
      su_updateIos: "Update iOS to use Tap to Pay on iPhone.",
      su_declined: "Declined",
      su_timedOut: "Timed out",
      su_notEnabledYet: "Not enabled yet",
      su_didntGoThrough: "Didn't go through",
      su_timeoutFlips: "If the card was read, this flips to Paid on its own within a minute. If it doesn’t, press Tap to Pay again.",
      su_btn_tryAgain: "Try Again",
      su_btn_cancel: "Cancel",
      su_appleSheetCloses: "Apple’s sheet closes on its own once the terms are accepted or declined.",
      su_closeAppleGuide: "Close Apple’s guide when you’re done — the card is next.",
      su_flipsToPaid: "This flips to Paid the moment the payment lands on the invoice.",
      su_paidAmount: "Paid — {amount}",
      su_recordedOnInvoice: "Recorded on the invoice. The money lands in your Stripe balance.",
      su_btn_done: "Done",
      su_paidByCardDone: "Paid — {amount} by card. Done.",
      su_couldntBuildCode: "Couldn't build the payment code.",
      su_cardsNotOn: "Card payments aren't switched on yet — Settings → Getting Paid → Set Up Card Payments.",
      su_didntReachServer: "That didn't reach the server — check your connection and try again.",
      su_couldntRecord: "Couldn't record that.",
      su_couldntSettle: "Couldn't settle that.",
      su_sendFirstQuestion: "Send {doc} as the bill first?",
      su_thisInvoice: "this invoice",
      su_sendFirstCard: "{doc} is still a draft, so there's no bill to pay yet. Sending records it as sent today, then the card can be taken. Nothing is emailed or texted.",
      su_sendFirstPayment:
        "{doc} is still a draft, and this pays all of it. A draft never reads as paid, so sending records it as sent today, then the payment goes on it. Nothing is emailed or texted.",
      su_btn_notNow: "Not Now",
      su_btn_sendIt: "Send It",
      su_sendingAsBill: "Sending {inv} as the bill.",
      su_theInvoice: "the invoice",
      su_receipt: "Receipt",
      su_gettingReceiptLink: "Getting the receipt link…",
      su_btn_textReceipt: "Text Receipt",
      su_btn_texted: "Texted",
      su_btn_sending: "Sending…",
      su_btn_textFromThisPhone: "Text from This Phone",
      su_btn_emailReceipt: "Email Receipt",
      su_btn_emailed: "Emailed",
      su_btn_share: "Share",
      su_btn_hideQr: "Hide QR",
      su_btn_showQr: "Show QR",
      su_noPhoneOnFile: "No phone number on file for this customer — text it from this phone instead.",
      su_textsNotReady: TEXTS_NOT_READY_LINE,
      su_untilThenTextFromPhone: "Until then, text it from this phone.",
      su_scanForReceipt: "Scan for the receipt",
      su_noteTextReceipt: "Text Receipt sends from the business’s number.",
      su_noteTextFromPhone: "Text from This Phone sends from this phone’s number.",
      su_noteEmailReceipt: "Email Receipt sends from the business’s email.",
      su_noteShare: "Share opens this phone’s share sheet.",
      su_receiptTexted: "Receipt texted — the paid invoice, from the business's number.",
      su_textingNotSetUp: "Texting isn't set up yet, so the business can't text it. Text from This Phone sends it from yours.",
      su_textDidntSend: "The text didn't send — open the invoice and send it from there.",
      su_textDidntReach: "The text didn't reach the server — check your connection and try again.",
      su_receiptEmailed: "Receipt emailed — the paid invoice.",
      su_emailDidntSend: "The email didn't send — open the invoice and send it from there.",
      su_emailDidntReach: "The email didn't reach the server — check your connection and try again.",
      su_shareFailed: "Couldn't open the share sheet — use Text or Email instead.",
      su_invoiceN: "Invoice {n}",
      su_yourInvoice: "Your invoice",
      su_receiptTitle: "Receipt — {inv}",
      su_declinedTitle: "Card declined — {inv}",
      su_paidLine: "{who}{inv} — {amount} paid by card on {date}. Your receipt:",
      su_declinedLine: "{who}{inv} — {amount} card payment declined on {date}; nothing was charged. The invoice is still open:",
      su_declinedDraftNoLink: "Nothing was charged, and this invoice is still a draft, so there's no link to send yet. Finish it and send it when you're ready.",
      su_couldntGetReceiptLink: "Couldn't get the receipt link — open the invoice and share it from there.",
      su_orTheyPaidAnotherWay: "Or They Paid Another Way",
      su_howTheyPaid: "How They Paid",
      su_moneyOutsideStripe: "Money that moved outside Stripe — cash, a check, a transfer, Venmo.",
      su_dontRecordByHand: "Don't record it by hand, or it counts twice.",
      su_amount: "Amount",
      su_amountPlaceholder: "$ amount",
      su_howTheyPaidLower: "How they paid",
      su_btn_showVenmoQr: "Show Venmo QR",
      su_btn_sendBillShowVenmoQr: "Send the Bill & Show Venmo QR",
      su_datePaid: "Date Paid",
      su_note: "Note",
      su_notePlaceholder: "e.g. check #1042",
      su_btn_saving: "Saving…",
      su_btn_recordIt: "Record It",
      su_enterWhatTheyPaid: "Enter what they paid.",
      su_enterWhatTheyrePaying: "Enter what they're paying.",
      su_addVenmoFirst: "Add your Venmo username in Settings → Payment methods first.",
      su_paidMethodDone: "Paid — {amount} {method}. Done.",
      su_paidVenmoDone: "Paid — {amount} Venmo. Done.",
      su_venmoHandleAmount: "Venmo @{handle} — {amount}",
      su_venmoQrCode: "Venmo QR code",
      su_venmoTheyScan: "They scan, they pay. Venmo can't tell the app when it lands — tap the button when it does.",
      su_btn_theyPaidRecordIt: "They Paid — Record It",
      su_btn_back: "Back",
      su_btn_method_cash: "Cash",
      su_btn_method_check: "Check",
      su_btn_method_transfer: "Transfer",
      su_btn_method_other: "Other",
    };
    // The table is the catalog, whole: a key added to one and not the other is a hole.
    expect(Object.keys(replaced).sort()).toEqual(Object.keys(su.en).sort());
    for (const [k, literal] of Object.entries(replaced)) expect(dict("en")[k], k).toBe(literal);
    // The sentences the old sheet assembled, re-assembled through the slots, are the old sentences.
    expect(fillText(dict("en").su_paidByCardDone, { amount: "$420.00" })).toBe("Paid — $420.00 by card. Done.");
    expect(fillText(dict("en").su_paidMethodDone, { amount: "$50.00", method: "cash" })).toBe("Paid — $50.00 cash. Done.");
    expect(fillText(dict("en").su_sendingAsBill, { inv: dict("en").su_theInvoice })).toBe("Sending the invoice as the bill.");
    expect(fillText(dict("en").su_payLinkSms, { inv: fillText(dict("en").su_invoiceDash, { n: "1042" }), amount: "$150.00", url: "https://x" })).toBe(
      "Invoice 1042 — $150.00. Pay by card here: https://x",
    );
    expect(fillText(dict("en").su_paidLine, { who: "Larkspur Electric: ", inv: "Invoice 1042", amount: "$150.00", date: "Nov 5, 2026" })).toBe(
      "Larkspur Electric: Invoice 1042 — $150.00 paid by card on Nov 5, 2026. Your receipt:",
    );
  });
});
