/**
 * SAMPLE PAPER for the Document studio — realistic rows (the shape of a real ET Electric
 * invoice: labor by name, fixture bundles with quantities, the supplies-&-tax remainder) so
 * what Erik styles is what his documents actually look like, not lorem. Pure data, no fetch:
 * the studio must render instantly and identically for every org.
 */

export interface SampleItem {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
  import_source?: string | null;
}

const line = (
  id: string,
  description: string,
  quantity: number,
  unit: string,
  unit_price: number,
  import_source: string | null = null,
): SampleItem => ({ id, description, quantity, unit, unit_price, line_total: Math.round(quantity * unit_price * 100) / 100, import_source });

export const SAMPLE_INVOICE_ITEMS: SampleItem[] = [
  line("s1", "Labor — Erik", 17, "hr", 111, "labor"),
  line("s2", "Labor — Brian", 17, "hr", 75, "labor"),
  line("s3", "5/6 in RL, 900/1200LM 5CCT D2W", 50, "ea", 32.11, "costs"),
  line("s4", "Adjustable Gimball 5/6 inch LED", 6, "ea", 43.53, "costs"),
  line("s5", "4 in RL 600/900LM 5CCT D2W", 2, "ea", 29.81, "costs"),
  line("s6", "15A 125V GFCI RCPT", 1, "ea", 21.04, "costs"),
  line("s7", "SP 3WY WHT BXD DMR", 1, "ea", 34.95, "costs"),
  line("s8", "Supplies & tax — Consolidated Electrical Distributors, Inc.", 1, "ea", 264.43, "costs"),
];

export const SAMPLE_QUOTE_ITEMS: SampleItem[] = [
  line("q1", "Recessed lighting — great room\n5/6 in RL 900/1200LM 5CCT, dimmer-ready, patch & paint by others", 12, "ea", 118, null),
  line("q2", "Under-cabinet lighting run, kitchen", 1, "lot", 640, null),
  line("q3", "Dedicated 20A small-appliance circuit", 2, "ea", 385, null),
  line("q4", "Panel work: two tandem breakers, labeling, torque check", 1, "lot", 290, null),
];

export const SAMPLE_DESCRIPTION =
  "Recessed lighting package for the main floor — fixtures supplied, installed, and dimmed per the walk-through. All penetrations fire-caulked; switch legs labeled at the panel.";

export function sampleTotals(items: SampleItem[]) {
  const subtotal = Math.round(items.reduce((t, i) => t + i.line_total, 0) * 100) / 100;
  return { subtotal, tax: 0, total: subtotal };
}

export const SAMPLE_CUSTOMER = {
  name: "Nora & Fermin Arnoso",
  company_name: null,
  address: "85 Whitney Place",
  unit: null,
  city: "Truckee",
  state: "CA",
  zip: "96161",
};

export const SAMPLE_SITE = {
  address: "85 Whitney Place",
  unit: null,
  city: "Truckee",
  state: "CA",
  zip: "96161",
  source: "job",
  complete: true,
} as const;
