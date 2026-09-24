/**
 * J-011 / INV-078 as it stood on 2026-09-24 after the corrections, read-only from production: every
 * line, the entries each labor line claims (first names and clock times only), the purchase dates each
 * material line comes from, and the six payments. The figures the customer portal must reproduce to
 * the cent. No customer name, no address: the rows are the money and nothing else.
 */
import type { LedgerInvoiceIn, LedgerLineIn, LedgerPaymentIn } from "./stretch-ledger";

export const INV_078: LedgerInvoiceIn = {"id":"inv-078","invoice_number":"INV-078","status":"draft","subtotal":8318.62,"tax":0,"total":8318.62,"amount_paid":6760,"created_at":"2026-09-24T07:46:35.032941+00:00","sent_at":null};
type E = [string, string, string | null, number];
type S = [string | null, string | null];
const RAW_LINES: { invoice_id: string; sort_order: number; description: string; quantity: number; unit: string; unit_price: number; line_total: number; import_source: string; entries?: E[]; sources?: S[] }[] = [
  {"invoice_id":"inv-078","sort_order":0,"description":"Labor - Erik","quantity":50.5,"unit":"hr","unit_price":100,"line_total":5050,"import_source":"labor","entries":[["Erik","2026-07-14T23:30:00+00:00","2026-07-15T00:30:00+00:00",0],["Erik","2026-07-31T21:02:00+00:00","2026-08-01T00:32:00+00:00",30],["Erik","2026-08-03T19:00:00+00:00","2026-08-03T23:00:00+00:00",30],["Erik","2026-08-05T22:00:00+00:00","2026-08-06T01:30:32.917+00:00",0],["Erik","2026-08-10T20:00:00+00:00","2026-08-11T01:00:00+00:00",0],["Erik","2026-08-19T22:00:00+00:00","2026-08-20T00:30:00+00:00",0],["Erik","2026-08-20T18:00:00+00:00","2026-08-21T00:00:00+00:00",0],["Erik","2026-08-21T16:00:00+00:00","2026-08-21T19:00:00+00:00",0],["Erik","2026-08-28T22:30:00+00:00","2026-08-29T01:00:00+00:00",0],["Erik","2026-08-29T18:30:00+00:00","2026-08-30T01:30:00+00:00",0],["Erik","2026-08-30T19:00:00+00:00","2026-08-30T23:00:00+00:00",0],["Erik","2026-08-31T19:00:00+00:00","2026-08-31T22:30:00+00:00",0],["Erik","2026-09-19T00:00:00+00:00","2026-09-19T01:00:00+00:00",0],["Erik","2026-09-22T19:30:00+00:00","2026-09-23T00:30:00+00:00",0]]},
  {"invoice_id":"inv-078","sort_order":1,"description":"Labor - Brian","quantity":10,"unit":"hr","unit_price":50,"line_total":500,"import_source":"labor","entries":[["Brian","2026-08-10T20:00:00+00:00","2026-08-11T01:00:00+00:00",0],["Brian","2026-09-22T19:00:00+00:00","2026-09-23T00:00:00+00:00",0]]},
  {"invoice_id":"inv-078","sort_order":2,"description":"Labor - Jimmy","quantity":11,"unit":"hr","unit_price":50,"line_total":550,"import_source":"labor","entries":[["Jimmy","2026-08-29T18:30:00+00:00","2026-08-30T01:30:00+00:00",0],["Jimmy","2026-08-30T19:00:00+00:00","2026-08-30T23:00:00+00:00",0]]},
  {"invoice_id":"inv-078","sort_order":3,"description":"4 in RL 600/900LM 5CCT D2W (RL4LS9FSD2W1EWH)","quantity":4,"unit":"ea","unit_price":27.43,"line_total":109.72,"import_source":"costs","sources":[["2026-09-24","2026-09-24T07:45:57.088346+00:00"]]},
  {"invoice_id":"inv-078","sort_order":4,"description":"Supplies & tax — Consolidated Electrical Dist.","quantity":1,"unit":"ea","unit_price":9.87,"line_total":9.87,"import_source":"costs","sources":[["2026-09-24","2026-09-24T07:45:57.088346+00:00"]]},
  {"invoice_id":"inv-078","sort_order":5,"description":"14-3 NM W/G BLUE 25 FT","quantity":1,"unit":"ea","unit_price":74.75,"line_total":74.75,"import_source":"costs","sources":[["2026-08-29","2026-09-24T07:45:17.238965+00:00"]]},
  {"invoice_id":"inv-078","sort_order":6,"description":"14-2 NM W/G 100 FT","quantity":2,"unit":"ea","unit_price":96.6,"line_total":193.2,"import_source":"costs","sources":[["2026-08-29","2026-09-24T07:45:17.238965+00:00"]]},
  {"invoice_id":"inv-078","sort_order":7,"description":"4 in HALO IC AIRTIGHT NC HOUSING","quantity":2,"unit":"ea","unit_price":24.12,"line_total":48.24,"import_source":"costs","sources":[["2026-08-29","2026-09-24T07:45:17.238965+00:00"]]},
  {"invoice_id":"inv-078","sort_order":9,"description":"Supplies & tax — The Home Depot","quantity":1,"unit":"ea","unit_price":26.12,"line_total":26.12,"import_source":"costs","sources":[["2026-08-29","2026-09-24T07:45:17.238965+00:00"]]},
  {"invoice_id":"inv-078","sort_order":10,"description":"Flexbox single gang 20.5 cu in","quantity":33,"unit":"ea","unit_price":1.54,"line_total":50.82,"import_source":"costs","sources":[["2026-07-31","2026-07-31T23:49:14.172749+00:00"]]},
  {"invoice_id":"inv-078","sort_order":11,"description":"Flexbox two gang 40 cu in OWB","quantity":2,"unit":"ea","unit_price":7.81,"line_total":15.62,"import_source":"costs","sources":[["2026-07-31","2026-07-31T23:49:14.172749+00:00"]]},
  {"invoice_id":"inv-078","sort_order":12,"description":"Flexbox two gang 43.5 cu in","quantity":10,"unit":"ea","unit_price":2.97,"line_total":29.7,"import_source":"costs","sources":[["2026-07-31","2026-07-31T23:49:14.172749+00:00"]]},
  {"invoice_id":"inv-078","sort_order":13,"description":"Flexbox 3.5 in ceiling","quantity":8,"unit":"ea","unit_price":4.27,"line_total":34.16,"import_source":"costs","sources":[["2026-07-31","2026-07-31T23:49:14.172749+00:00"]]},
  {"invoice_id":"inv-078","sort_order":14,"description":"4 in LED shallow IC housing","quantity":3,"unit":"ea","unit_price":13.6,"line_total":40.8,"import_source":"costs","sources":[["2026-07-31","2026-07-31T23:49:14.172749+00:00"]]},
  {"invoice_id":"inv-078","sort_order":15,"description":"6 in LED housing","quantity":1,"unit":"ea","unit_price":14.18,"line_total":14.18,"import_source":"costs","sources":[["2026-07-31","2026-07-31T23:49:14.172749+00:00"]]},
  {"invoice_id":"inv-078","sort_order":16,"description":"NMB 12/2 w/gnd 250 ft coil","quantity":250,"unit":"ea","unit_price":0.76,"line_total":190,"import_source":"costs","sources":[["2026-07-31","2026-07-31T23:49:14.172749+00:00"]]},
  {"invoice_id":"inv-078","sort_order":18,"description":"Supplies & tax — Consolidated Electrical Dist.","quantity":1,"unit":"ea","unit_price":33.84,"line_total":33.84,"import_source":"costs","sources":[["2026-07-31","2026-07-31T23:49:14.172749+00:00"]]},
  {"invoice_id":"inv-078","sort_order":19,"description":"Flexbox BH bar hanger ground","quantity":1,"unit":"ea","unit_price":10.14,"line_total":10.14,"import_source":"costs","sources":[["2026-08-19","2026-09-11T18:20:07.050473+00:00"]]},
  {"invoice_id":"inv-078","sort_order":20,"description":"NMB 12/2 w/gnd wire 250 ft coil","quantity":250,"unit":"ea","unit_price":0.76,"line_total":190,"import_source":"costs","sources":[["2026-08-19","2026-09-11T18:20:07.050473+00:00"]]},
  {"invoice_id":"inv-078","sort_order":21,"description":"Flexbox single gang 16 cu in","quantity":2,"unit":"ea","unit_price":5.12,"line_total":10.24,"import_source":"costs","sources":[["2026-08-19","2026-09-11T18:20:07.050473+00:00"]]},
  {"invoice_id":"inv-078","sort_order":22,"description":"Supplies & tax — Consolidated Electrical Dist.","quantity":1,"unit":"ea","unit_price":19.02,"line_total":19.02,"import_source":"costs","sources":[["2026-08-19","2026-09-11T18:20:07.050473+00:00"]]},
  {"invoice_id":"inv-078","sort_order":23,"description":"WIRE NMB 10/3 w/GND 50 ft coil","quantity":50,"unit":"ea","unit_price":1.85,"line_total":92.5,"import_source":"costs","sources":[["2026-08-20","2026-09-11T18:20:28.865138+00:00"]]},
  {"invoice_id":"inv-078","sort_order":24,"description":"AIM PC213BHG Flexbox BH bar hanger ground","quantity":6,"unit":"ea","unit_price":10.15,"line_total":60.9,"import_source":"costs","sources":[["2026-08-20","2026-09-11T18:20:28.865138+00:00"]]},
  {"invoice_id":"inv-078","sort_order":25,"description":"RACO 292 3-1/2 in round 1/2D NMC box","quantity":1,"unit":"ea","unit_price":5.19,"line_total":5.19,"import_source":"costs","sources":[["2026-08-20","2026-09-11T18:20:28.865138+00:00"]]},
  {"invoice_id":"inv-078","sort_order":26,"description":"Supplies & tax — Consolidated Electrical Dist.","quantity":1,"unit":"ea","unit_price":14.22,"line_total":14.22,"import_source":"costs","sources":[["2026-08-20","2026-09-11T18:20:28.865138+00:00"]]},
  {"invoice_id":"inv-078","sort_order":27,"description":"WHT DEC 15A T-PRF RCPT","quantity":31,"unit":"ea","unit_price":2.45,"line_total":75.95,"import_source":"costs","sources":[["2026-09-22","2026-09-22T20:52:49.109896+00:00"]]},
  {"invoice_id":"inv-078","sort_order":28,"description":"SP 3WY CFL DMR","quantity":11,"unit":"ea","unit_price":40.33,"line_total":443.63,"import_source":"costs","sources":[["2026-09-22","2026-09-22T20:52:49.109896+00:00"]]},
  {"invoice_id":"inv-078","sort_order":29,"description":"1P 120V SEN SWITCH","quantity":2,"unit":"ea","unit_price":45.73,"line_total":91.46,"import_source":"costs","sources":[["2026-09-22","2026-09-22T20:52:49.109896+00:00"]]},
  {"invoice_id":"inv-078","sort_order":30,"description":"WHT 15A125V 3WAY SW","quantity":2,"unit":"ea","unit_price":3.25,"line_total":6.5,"import_source":"costs","sources":[["2026-09-22","2026-09-22T20:52:49.109896+00:00"]]},
  {"invoice_id":"inv-078","sort_order":31,"description":"15A 125V GFCI RCPT","quantity":6,"unit":"ea","unit_price":19.36,"line_total":116.16,"import_source":"costs","sources":[["2026-09-22","2026-09-22T20:52:49.109896+00:00"]]},
  {"invoice_id":"inv-078","sort_order":33,"description":"UNDERCAB LED FIXT 32 in BROWN","quantity":1,"unit":"ea","unit_price":101.27,"line_total":101.27,"import_source":"costs","sources":[["2026-09-22","2026-09-22T20:52:49.109896+00:00"]]},
  {"invoice_id":"inv-078","sort_order":34,"description":"2 GANG DECORA PLATE","quantity":12,"unit":"ea","unit_price":1.12,"line_total":13.44,"import_source":"costs","sources":[["2026-09-22","2026-09-22T20:52:49.109896+00:00"]]},
  {"invoice_id":"inv-078","sort_order":35,"description":"1 GANG DECORA PLATE","quantity":33,"unit":"ea","unit_price":0.57,"line_total":18.81,"import_source":"costs","sources":[["2026-09-22","2026-09-22T20:52:49.109896+00:00"]]},
  {"invoice_id":"inv-078","sort_order":36,"description":"Supplies & tax — Consolidated Electrical Dist.","quantity":1,"unit":"ea","unit_price":78.17,"line_total":78.17,"import_source":"costs","sources":[["2026-09-22","2026-09-22T20:52:49.109896+00:00"]]},
];
export const PAYMENTS: LedgerPaymentIn[] = [{"invoice_id":"inv-078","amount":1850,"paid_at":"2026-08-10T19:00:00+00:00","method":"cash"},{"invoice_id":"inv-078","amount":300,"paid_at":"2026-08-29T19:00:00+00:00","method":"cash"},{"invoice_id":"inv-078","amount":2550,"paid_at":"2026-08-31T19:00:00+00:00","method":"venmo"},{"invoice_id":"inv-078","amount":1200,"paid_at":"2026-08-31T19:00:00+00:00","method":"cash"},{"invoice_id":"inv-078","amount":500,"paid_at":"2026-09-23T19:00:00+00:00","method":"cash"},{"invoice_id":"inv-078","amount":360,"paid_at":"2026-09-23T19:00:00+00:00","method":"cash"}];

export const LINES: LedgerLineIn[] = RAW_LINES.map((l) => ({
  ...l,
  entries: l.entries?.map(([person, clock_in, clock_out, lunch_minutes]) => ({ person, clock_in, clock_out, lunch_minutes })),
  sources: l.sources?.map(([date, at]) => ({ date, at })),
}));

/** The four stretches exactly as Erik named them. */
export const STRETCHES = [
  { id: "s1", label: "Rough-in Start", starts_on: "2026-07-14", ends_on: "2026-08-10" },
  { id: "s2", label: "Rough-in", starts_on: "2026-08-19", ends_on: "2026-08-31" },
  { id: "s3", label: "Trim", starts_on: "2026-09-18", ends_on: "2026-09-23" },
  { id: "s4", label: "Fixtures", starts_on: "2026-09-24", ends_on: "2026-09-24" },
];
