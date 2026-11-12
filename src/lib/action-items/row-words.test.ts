import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, dict, translator } from "@/lib/i18n";
import { AFFORDANCES, KIND_GROUP, type ActionItem, type ActionKind, type PileInfo } from "./types";
import { FEEDER_SAY_KEYS } from "./feeder-keys";
import { NY_EN, ageWords, nyWord, pileLabelKey, pileListLabelWords, pileTitleWords, rowWords, sayIt, type RowWordsCtx } from "./row-words";
import { DATED_EN, datedWhen, relativeWhen } from "./dated-when";
import { PILE_DEFS, ORGANIZE_PILE_MIXED } from "./piles";

/**
 * WHAT A NEEDS YOU ROW SAYS (the redraw, cn-v1161): WHO in bold, WHAT under it, one thing at the
 * right edge. The English lives once, inline (NY_EN), and must equal the catalog's; a Spanish reader
 * reads the catalog through the caller's translator; a tech never reads an amount.
 */
const TZ = "America/Los_Angeles";
const TODAY = "2026-11-11";
const en: RowWordsCtx = { isStaff: true, todayStr: TODAY, tz: TZ };
const es: RowWordsCtx = { lang: "es", words: translator("es"), isStaff: true, todayStr: TODAY, tz: TZ };
const tech: RowWordsCtx = { ...en, isStaff: false };

let seq = 0;
const row = (kind: ActionKind, o: Partial<ActionItem> = {}): ActionItem => ({
  id: `r${++seq}`,
  kind,
  group: KIND_GROUP[kind],
  title: `Row ${seq}`,
  when: null,
  urgency: 1,
  done: false,
  href: `/x/${seq}`,
  affordances: AFFORDANCES[kind],
  ...o,
});

describe("the one English table", () => {
  it("every value equals the catalog's English, key by key, so the two can never drift", () => {
    const d = dict("en");
    for (const [k, v] of Object.entries(NY_EN)) expect(d[k], k).toBe(v);
    for (const [k, v] of Object.entries(DATED_EN)) expect(d[k], k).toBe(v);
  });

  it("every key a feeder can emit is in the table, with Spanish of its own", () => {
    const esD = dict("es");
    expect(FEEDER_SAY_KEYS.length).toBeGreaterThan(80);
    for (const k of FEEDER_SAY_KEYS) {
      expect(NY_EN[k], `${k} has no English in NY_EN`).toBeTypeOf("string");
      expect(esD[k], `${k} has no Spanish`).toBeTypeOf("string");
      expect(esD[k], `${k} reads the same in Spanish`).not.toBe(NY_EN[k]);
    }
  });

  it("every ny_ key a feeder's source names is in the table (read from the feeders, not from a list)", () => {
    const feeders = ["query.ts", "switches.ts", "done-not-billed.ts", "permit-inspection-items.ts", "supplier-paper-item.ts", "supplier-pay-item.ts", "no-job-hours-item.ts", "jobs-needing-a-day.ts"];
    const named = new Set<string>();
    for (const f of feeders) {
      const src = readFileSync(join(process.cwd(), "src/lib/action-items", f), "utf8");
      for (const m of src.matchAll(/"(ny_[A-Za-z_]+)"/g)) named.add(m[1]);
    }
    const missing = [...named].filter((k) => !(k in NY_EN));
    expect(missing).toEqual([]);
  });

  it("the catalog is the 31st, prefix ny_, naming the box's four screens", () => {
    const ny = CATALOGS.find((c) => c.prefix === "ny_")!;
    expect(ny).toBeTruthy();
    expect(ny.files).toEqual([
      "src/components/action-items/action-list.tsx",
      "src/components/action-items/needs-you-tiles.tsx",
      "src/components/action-items/level-mark.tsx",
      "src/components/action-items/waiting-fold.tsx",
    ]);
    // Reused, never re-added under ny_.
    const nyEnglish = new Set(Object.values(ny.en));
    for (const k of ["su_didntReachServer", "ag_btn_backOn", "ld_btn_openTheInspection", "ag_cal_btn_moreFor", "md_needsYou", "md_nothingNeedsYou"]) {
      expect(dict("en")[k], k).toBeTypeOf("string");
      expect(nyEnglish.has(dict("en")[k]), `${k}'s words are re-added under ny_`).toBe(false);
    }
  });

  it("Spanish says the words the rest of the app says: Prospecto, Presupuesto, Factura, Trabajo, Agenda", () => {
    const d = dict("es");
    expect(d.ny_w_leadNew).toMatch(/^Prospecto/);
    expect(d.ny_docEstimate).toBe("Presupuesto");
    expect(d.ny_w_invoice).toMatch(/^Factura/);
    expect(d.ny_btn_pile_jobsNeedingADay).toMatch(/^Trabajos/);
    expect(d.ny_btn_seeAllOnSchedule).toContain("Agenda");
    // The same words the other catalogs already chose for the same doors.
    expect(d.ny_btn_pickADay).toBe(d.ag_rail_btn_pickADay);
    expect(d.ny_btn_snooze).toBe(d.ag_rail_btn_snooze);
    expect(d.ny_btn_takeOffHold).toBe(d.ag_rail_btn_takeOffHold);
    expect(d.ny_btn_getPaid).toBe(d.su_btn_getPaid);
    expect(d.ny_btn_recordIt).toBe(d.su_btn_recordIt);
    expect(d.ny_btn_didntHappen).toBe(d.ip_btn_didntHappen);
    expect(d.ny_btn_lostVisit).toBe(d.ip_btn_lost);
  });
});

describe("a Say, said", () => {
  it("days, money, a visit's type and another key, each by its slot's name; the tail after", () => {
    expect(sayIt({ key: "ny_w_docOfferEnds", vars: { docKey: "ny_docEstimate", ref: "E-036", day: "2026-11-20" } }, en)).toBe("Estimate E-036 · offer ends Nov 20");
    expect(sayIt({ key: "ny_w_docOfferEnds", vars: { docKey: "ny_docEstimate", ref: "E-036", day: "2026-11-20" } }, es)).toBe("Presupuesto E-036 · la oferta termina el 20 nov");
    expect(sayIt({ key: "ny_w_payBySavesOne", vars: { day: "2026-12-10", money: 35.5, n: 1 } }, en)).toBe("Pay by Dec 10 · saves $35.50 on 1 invoice");
    expect(sayIt({ key: "ny_w_toWriteUp", vars: { type: "estimate" } }, en)).toMatch(/ · to write up$/);
    expect(sayIt({ key: "ny_w_toWriteUp", vars: { type: "estimate" } }, es)).toMatch(/ · por redactar$/);
    expect(sayIt({ key: "ny_w_saidYes", vars: { ref: "E-031" }, tail: "Larkspur · J-047" }, en)).toBe("Said yes to E-031 · needs a day · Larkspur · J-047");
    expect(sayIt({ key: "ny_w_hoursSpan", vars: { hours: 9.25, day: "2026-10-02", day2: "2026-10-07" } }, en)).toBe("9.25 h, Oct 2 to Oct 7");
    // A year that is not this one is said.
    expect(sayIt({ key: "ny_w_quietSince", vars: { day: "2025-12-03" } }, en)).toBe("Quiet since Dec 3, 2025");
  });

  it("a second phrase rides after the first (andKey), its count from andN when given", () => {
    expect(sayIt({ key: "ny_w_toBuy", vars: { n: 5, text: "2× breaker", andKey: "ny_w_plusMore", andN: 2 } }, en)).toBe("5 to buy · 2× breaker · +2 more");
    expect(sayIt({ key: "ny_w_workedNothingNext", vars: { day: "2026-09-25", andKey: "ny_w_nToBuy", n: 6 } }, en)).toBe("Worked Sep 25, nothing next · 6 to buy");
    expect(sayIt({ key: "ny_w_payBySavesOne", vars: { day: "2026-12-10", money: 35.5, n: 1, andKey: "ny_w_alreadySent", money2: 200 } }, en)).toBe(
      "Pay by Dec 10 · saves $35.50 on 1 invoice · $200.00 already sent",
    );
    expect(sayIt({ key: "ny_w_holdNoDay", vars: { textKey: "ny_w_noReason" } }, es)).toBe("En pausa, sin día · sin motivo guardado");
  });

  it("a Couldn't Check line's label is another key; never a raw key, never an open slot", () => {
    expect(sayIt({ key: "ny_who_unread", vars: { labelKey: "ny_lbl_holds" } }, en)).toBe("Holds · Couldn't Check");
    expect(sayIt({ key: "ny_who_unread", vars: { labelKey: "ny_btn_pile_permitInspections" } }, es)).toBe("Inspecciones de Permisos · No Se Pudo Revisar");
    for (const k of FEEDER_SAY_KEYS) {
      const out = sayIt({ key: k, vars: { n: 2, ref: "E-1", text: "x", name: "Sam", day: "2026-11-01", day2: "2026-11-02", money: 1, money2: 2, hours: 3, docKey: "ny_docQuote", labelKey: "ny_lbl_holds", type: "estimate" } }, es);
      expect(out, k).not.toMatch(/ny_|\{\w+\}/);
    }
  });

  it("nyWord: English inline with no translator, the catalog's Spanish with one", () => {
    expect(nyWord("ny_btn_seeAllOnBills", {})).toBe("See All on Bills");
    expect(nyWord("ny_btn_seeAllOnBills", { lang: "es", words: translator("es") })).toBe("Ver Todos en Cuentas");
    // Spanish asked for with no translator handed in: English, never a raw key.
    expect(nyWord("ny_btn_seeAllOnBills", { lang: "es" })).toBe("See All on Bills");
  });
});

describe("the feeders' slot conventions (Lane 2's rows), in English and Spanish", () => {
  it("1. a slot named <x>Key holds another key whose words fill {x}: labelKey, docKey, textKey", () => {
    expect(sayIt({ key: "ny_who_unread", vars: { labelKey: "ny_lbl_receipts" } }, en)).toBe("Receipts · Couldn't Check");
    expect(sayIt({ key: "ny_who_unread", vars: { labelKey: "ny_lbl_receipts" } }, es)).toBe("Recibos · No Se Pudo Revisar");
    expect(sayIt({ key: "ny_w_docNotSent", vars: { docKey: "ny_docQuote", ref: "Q-007" } }, en)).toBe("Quote Q-007 · not sent");
    expect(sayIt({ key: "ny_w_docNotSent", vars: { docKey: "ny_docQuote", ref: "Q-007" } }, es)).toBe("Cotización Q-007 · sin enviar");
    expect(sayIt({ key: "ny_w_holdBack", vars: { textKey: "ny_w_noReason" } }, en)).toBe("Hold is back · no reason saved");
    expect(sayIt({ key: "ny_w_holdBack", vars: { textKey: "ny_w_noReason" } }, es)).toBe("Pausa vencida · sin motivo guardado");
  });

  it("2. andKey is a second phrase after \" · \", reading the same slots, its {n} from andN when given", () => {
    const toBuy = { key: "ny_w_toBuy", vars: { n: 5, text: "2× breaker", andKey: "ny_w_plusMore", andN: 2 } };
    expect(sayIt(toBuy, en)).toBe("5 to buy · 2× breaker · +2 more");
    expect(sayIt(toBuy, es)).toBe("5 por comprar · 2× breaker · +2 más");
    const hold = { key: "ny_w_holdNoDay", vars: { textKey: "ny_w_noReason", andKey: "ny_w_nToBuy", n: 3 } };
    expect(sayIt(hold, en)).toBe("On hold, no day set · no reason saved · 3 to buy");
    expect(sayIt(hold, es)).toBe("En pausa, sin día · sin motivo guardado · 3 por comprar");
    const pay = { key: "ny_w_payBySavesMany", vars: { day: "2026-12-10", money: 35.5, n: 7, andKey: "ny_w_alreadySent", money2: 200 } };
    expect(sayIt(pay, en)).toBe("Pay by Dec 10 · saves $35.50 on 7 invoices · $200.00 already sent");
    expect(sayIt(pay, es)).toBe("Paga antes del 10 dic · ahorras $35.50 en 7 facturas · Ya se envió $200.00");
  });

  it("3. type is the raw stored visit type, said by the app's one visit-type label rule", () => {
    expect(sayIt({ key: "ny_w_visitNotClosed", vars: { type: "service_call" } }, en)).toBe("Service Call · not closed out");
    expect(sayIt({ key: "ny_w_visitNotClosed", vars: { type: "service_call" } }, es)).toBe(`${dict("es").jb_apptServiceCall} · sin cerrar`);
    expect(sayIt({ key: "ny_w_toWriteUpTitled", vars: { text: "Panel swap", type: "inspection" } }, en)).toBe("Panel swap · Inspection · to write up");
  });

  it("4. n can be a string (a capped read's \"12+\"): printed as given", () => {
    expect(sayIt({ key: "ny_who_supplierBills", vars: { n: "12+" } }, en)).toBe("Supplier Bills · 12+");
    expect(sayIt({ key: "ny_who_hoursNoJob", vars: { n: "12+" } }, es)).toBe("Horas sin Trabajo · 12+");
  });
});

describe("WHO, WHAT and the right edge", () => {
  it("WHO is the row's who, else its whoSay said, else the title", () => {
    expect(rowWords(row("invoice_overdue", { who: "Dana Rook", title: "INV-090 · Dana Rook" }), en).who).toBe("Dana Rook");
    expect(rowWords(row("time_stray", { who: null, whoSay: { key: "ny_who_hoursNoJob", vars: { n: 3 } } }), es).who).toBe("Horas sin Trabajo · 3");
    expect(rowWords(row("organize", { title: "IMG_0412" }), en).who).toBe("IMG_0412");
  });

  it("WHAT is the row's what said, else its subtitle, else nothing", () => {
    expect(rowWords(row("contract_unsigned", { what: { key: "ny_w_contractNotSigned", vars: { ref: "C-004" }, tail: "Snowbell · J-051" } }), en).what).toBe(
      "Contract C-004 · not signed · Snowbell · J-051",
    );
    expect(rowWords(row("contract_unsigned", { subtitle: "Old words" }), en).what).toBe("Old words");
    expect(rowWords(row("contract_unsigned"), en).what).toBe("");
  });

  it("the money holds the right edge for staff, and the age rides the WHAT line", () => {
    const inv = row("invoice_overdue", { who: "Theo Vance", amount: 1250, when: "2026-10-08", what: { key: "ny_w_invoice", vars: { ref: "INV-090" } } });
    expect(rowWords(inv, en)).toEqual({ who: "Theo Vance", what: "Invoice INV-090 · 34d overdue", right: "$1,250.00", rightKind: "money" });
    expect(rowWords(inv, es)).toEqual({ who: "Theo Vance", what: "Factura INV-090 · 34d de retraso", right: expect.stringContaining("1,250.00"), rightKind: "money" });
  });

  it("…unless the phrase names its own day", () => {
    const pay = row("supplier_pay", { who: "Casey Loam Supply", amount: 900, when: "2026-11-14", what: { key: "ny_w_payBySavesOne", vars: { day: "2026-11-14", money: 18, n: 1 } } });
    expect(rowWords(pay, en)).toEqual({ who: "Casey Loam Supply", what: "Pay by Nov 14 · saves $18.00 on 1 invoice", right: "$900.00", rightKind: "money" });
  });

  it("no money: the age at the right edge; nothing at zero", () => {
    const visit = row("appointment", { who: "Sam Tillery", when: "2026-11-09", what: { key: "ny_w_visitNotClosed", vars: { type: "service" } } });
    expect(rowWords(visit, en).right).toBe("2d ago");
    expect(rowWords(visit, en).rightKind).toBe("age");
    expect(rowWords(visit, es).right).toBe("hace 2d");
    expect(rowWords(row("invoice_draft", { amount: 0, when: "2026-11-10" }), en)).toMatchObject({ right: "Yesterday", rightKind: "age" });
    expect(rowWords(row("supplier_paper"), en)).toMatchObject({ right: null, rightKind: null });
  });

  it("a tech never gets an amount, even when the row carries one", () => {
    const inv = row("invoice_overdue", { who: "Theo Vance", amount: 1250, when: "2026-10-08", what: { key: "ny_w_invoice", vars: { ref: "INV-090" } } });
    const w = rowWords(inv, tech);
    expect(w).toEqual({ who: "Theo Vance", what: "Invoice INV-090", right: "34d overdue", rightKind: "age" });
    expect(JSON.stringify(w)).not.toContain("$");
    const pile = row("invoice_overdue", { id: "pile:late_invoices", amount: 5000, pile: { ...PILE_DEFS.late_invoices, name: "late_invoices", count: 3, capped: false } });
    expect(JSON.stringify(rowWords(pile, tech))).not.toContain("$");
  });

  it("dated words read since first: a No Answer Yet row says the day it was SENT, not its follow-up day (defect D1)", () => {
    const q = row("quote_awaiting", { dated: "Sent", since: "2026-10-01T17:00:00Z", when: "2026-11-15", amount: 4200, what: { key: "ny_w_docNoAnswer", vars: { docKey: "ny_docEstimate", ref: "E-030" } } });
    expect(rowWords(q, en).what).toBe("Estimate E-030 · no answer yet · Sent Oct 1");
    expect(rowWords(q, es).what).toBe("Presupuesto E-030 · sin respuesta · Se envió el 1 oct");
    expect(rowWords({ ...q, amount: null }, en).right).toBe("Sent Oct 1");
    // With no since, the row's when is its day (a win, a draft).
    expect(ageWords(row("quote_accepted", { dated: "Accepted", when: "2026-06-24T17:00:00Z" }), en)).toBe("Accepted Jun 24");
  });

  it("an undated row falls back to since, said as how long ago (never overdue)", () => {
    expect(ageWords(row("job_to_schedule", { since: "2026-11-01" }), en)).toBe("10d ago");
    expect(ageWords(row("job_to_schedule", { since: "2026-11-01", id: "needday-unread" }), en)).toBeNull();
  });

  it("a pile: its own line and its sum", () => {
    const pile = row("quote_draft", { id: "pile:estimates_not_sent", amount: 2340, subtitle: "$2,340.00 across 2", pile: { ...PILE_DEFS.estimates_not_sent, name: "estimates_not_sent", count: 2, capped: false } });
    expect(rowWords(pile, en)).toEqual({ who: "Estimates Not Sent · 2", what: "", right: "$2,340.00", rightKind: "money" });
    expect(rowWords(pile, es).who).toBe("Presupuestos sin Enviar · 2");
  });
});

describe("a pile's words", () => {
  const p = (name: PileInfo["name"], o: Partial<PileInfo> = {}): PileInfo => ({ ...PILE_DEFS[name], name, count: 6, capped: false, ...o });

  it("English is piles.ts's own, byte for byte; Spanish by the pile's name", () => {
    for (const name of Object.keys(PILE_DEFS) as PileInfo["name"][]) {
      expect(pileTitleWords(p(name), {})).toBe(`${PILE_DEFS[name].label} · 6`);
      expect(NY_EN[pileLabelKey(p(name))], name).toBe(PILE_DEFS[name].label);
      const said = pileTitleWords(p(name), { lang: "es", words: translator("es") });
      expect(said, name).not.toMatch(/ny_/);
      expect(said, name).not.toBe(`${PILE_DEFS[name].label} · 6`);
    }
    expect(pileTitleWords(p("estimates_not_sent", { capped: true, count: 50 }), { lang: "es", words: translator("es") })).toBe("Presupuestos sin Enviar · 50+");
  });

  it("the Leads-off name and the mixed papers' name are said by their own words", () => {
    const esC = { lang: "es", words: translator("es") };
    expect(pileTitleWords(p("leads_to_call", { label: PILE_DEFS.leads_to_call.labelLeadsOff! }), esC)).toBe("Solicitudes por Llamar · 6");
    expect(pileTitleWords(p("notes_to_review", { label: ORGANIZE_PILE_MIXED }), esC)).toBe("Por Archivar en Organizar · 6");
  });

  it("See All on its list page, in the reader's language", () => {
    for (const name of Object.keys(PILE_DEFS) as PileInfo["name"][]) {
      const label = PILE_DEFS[name].listLabel;
      expect(pileListLabelWords(p(name), {})).toBe(label);
      if (label) expect(pileListLabelWords(p(name), { lang: "es", words: translator("es") }), name).not.toBe(label);
    }
  });
});

describe("dated-when in the reader's language", () => {
  it("English with no language handed in, as before; Spanish through the catalog", () => {
    expect(datedWhen("Sent", "2026-06-13T02:00:00Z", "2026-11-04", TZ)).toBe("Sent Jun 12");
    expect(datedWhen("Since", "2026-07-03", "2026-11-04", TZ, { lang: "es", words: translator("es") })).toBe("Since 3 jul");
    expect(datedWhen("Accepted", "2025-12-03T17:00:00Z", "2026-11-04", TZ, { lang: "es", words: translator("es") })).toBe("Se aceptó el 3 dic 2025");
    expect(relativeWhen("2026-11-10", TODAY, TZ, true)).toBe("1d overdue");
    expect(relativeWhen("2026-11-10", TODAY, TZ, false)).toBe("Yesterday");
    expect(relativeWhen("2026-11-12", TODAY, TZ, true, { lang: "es", words: translator("es") })).toBe("Mañana");
    expect(relativeWhen("2026-11-11T17:30:00Z", TODAY, TZ, true)).toBe("9:30 AM");
    expect(relativeWhen("2026-11-11T17:30:00Z", TODAY, TZ, true, { lang: "es", words: translator("es") })).toBe("9:30 a. m.");
  });
});
