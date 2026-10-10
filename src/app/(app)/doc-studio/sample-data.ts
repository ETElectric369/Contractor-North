/**
 * SAMPLE PAPER for the Document studio — realistic rows (the shape of a real invoice: labor by
 * person, material lines with quantities, the supplies-&-tax remainder) so what a company styles
 * is what its documents actually look like, not lorem. Pure data, no fetch: the studio must render
 * instantly and identically for every org, so nothing here names a real crew, customer, supplier
 * or town (Wave 0: every company's staff sees this page; the letterhead is already its own).
 */

import type { TaskDetail } from "@/lib/estimate/line-map";

export interface SampleItem {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
  import_source?: string | null;
  /** A task line's breakdown (0386), so the studio shows what "Tasks With Labor And Parts" prints. */
  detail?: TaskDetail | null;
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
  line("s1", "Labor — Lead", 17, "hr", 111, "labor"),
  line("s2", "Labor — Helper", 17, "hr", 75, "labor"),
  line("s3", "5/6 in RL, 900/1200LM 5CCT D2W", 50, "ea", 32.11, "costs"),
  line("s4", "Adjustable Gimball 5/6 inch LED", 6, "ea", 43.53, "costs"),
  line("s5", "4 in RL 600/900LM 5CCT D2W", 2, "ea", 29.81, "costs"),
  line("s6", "15A 125V GFCI RCPT", 1, "ea", 21.04, "costs"),
  line("s7", "SP 3WY WHT BXD DMR", 1, "ea", 34.95, "costs"),
  line("s8", "Supplies & tax — Your Supplier", 1, "ea", 264.43, "costs"),
];

export const SAMPLE_QUOTE_ITEMS: SampleItem[] = [
  line("q1", "Recessed lighting — great room\n5/6 in RL 900/1200LM 5CCT, dimmer-ready, patch & paint by others", 12, "ea", 118, null),
  line("q2", "Under-cabinet lighting run, kitchen", 1, "lot", 640, null),
  line("q3", "Dedicated 20A small-appliance circuit", 2, "ea", 385, null),
  // A line BUILT FROM A TASK: 2 h × $125 + two breakers at $20 = $290, the same figure as the line,
  // so the breakdown prints under the detailed format and the line alone under the plain one.
  {
    ...line("q4", "Panel work: two tandem breakers, labeling, torque check", 1, "ea", 290, null),
    detail: {
      task_id: "sample",
      hours: 2,
      rate: 125,
      units: null,
      kit_id: null,
      materials: [{ code: null, name: "Tandem breaker, 20A", qty: 2, cost: null, sell: 20 }],
    },
  },
];

export const SAMPLE_DESCRIPTION =
  "Recessed lighting package for the main floor — fixtures supplied, installed, and dimmed per the inspection. All penetrations fire-caulked; switch legs labeled at the panel.";

export function sampleTotals(items: SampleItem[]) {
  const subtotal = Math.round(items.reduce((t, i) => t + i.line_total, 0) * 100) / 100;
  return { subtotal, tax: 0, total: subtotal };
}

export const SAMPLE_CUSTOMER = {
  name: "Sample Customer",
  company_name: null,
  address: "123 Main St",
  unit: null,
  city: "Anytown",
  state: "ST",
  zip: "12345",
};

/** The job site the sample paper prints, and its title. */
export const SAMPLE_TITLE = "123 Main St — main floor";

export const SAMPLE_SITE = {
  address: "123 Main St",
  unit: null,
  city: "Anytown",
  state: "ST",
  zip: "12345",
  source: "job",
  complete: true,
} as const;
