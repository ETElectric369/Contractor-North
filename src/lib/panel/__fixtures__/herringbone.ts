import type { CircuitKind, CircuitWork, JobCircuit, JobPanel, QuoteCircuit } from "@/lib/types";
import type { HaveItem } from "../model";

/**
 * J-011, 13897 HERRINGBONE — the night of 2026-09-24/25, as data (Panel plan, phase 1).
 *
 * FINAL_MAP is the "Final Circuit Map" built by hand that night (v3): 3 lighting 1P 15A (one of
 * them reused: the kitchen-and-living lights, whose door label is "Entry Lights"), 16 outlet and
 * dedicated 1P 20A (one reused: the fridge, which the panel calls "Mini Fridge"), the bath floor
 * heat 2P 20A, the dryer 2P 30A, and the range on the EXISTING 2P 50A GFCI.
 *
 * PHOTO_EXISTING is what the panel photo shows that the hand map didn't draw: Garage x2, Mud Rm
 * AFCI, a 40A 2-pole, GDO #1 and #2 on the SPD, Garage 15 AFCI and Smokes AFCI. Where the photo
 * doesn't show the amps they are left null, not guessed.
 *
 * TICKET is CED 8802-SO-257555 as plain pole groups (the decoder is phase 3): 8 x Q2020 (a twin
 * of two 1P 20A) and 1 x Q21530CT (a quad of two 1P 15A and a 2P 30A).
 *
 * E017 is the estimate's circuit take-off exactly as it sits in quotes.circuits (read 2026-09-25).
 */

export const J011 = "8760a051-b6f8-4a6b-b3a5-6ac7078f9ac1";
export const PANEL_ID = "panel-herringbone-main";

export const PANEL: JobPanel = {
  id: PANEL_ID,
  org_id: "org-et",
  job_id: J011,
  name: "Main Panel",
  brand: "Siemens",
  bus_amps: 125,
  main_amps: 125,
  spaces: 32,
  numbering: "top_down",
  dead_spaces: [],
  twin_spaces: [],
  photo_document_id: null,
  notes: null,
  shown_on_portal: false,
  created_by: null,
  created_at: "2026-09-25T08:00:00Z",
  updated_by: null,
  updated_at: "2026-09-25T08:00:00Z",
  removed_at: null,
  removed_by: null,
};

let seq = 0;
export function circuit(over: Partial<JobCircuit> & { room: string | null; description: string | null }): JobCircuit {
  seq++;
  return {
    id: `c${seq}`,
    org_id: "org-et",
    job_id: J011,
    panel_id: PANEL_ID,
    panel_label: null,
    amps: null,
    poles: 1,
    kind: null,
    wire: null,
    wire_tag: null,
    space: null,
    half: null,
    work: "new",
    progress: "planned",
    state: "kept",
    source: "hand",
    source_quote_id: null,
    source_document_id: null,
    source_row: null,
    verified: false,
    verified_by: null,
    verified_at: null,
    sort_order: seq,
    created_by: null,
    created_at: "2026-09-25T08:00:00Z",
    updated_by: null,
    updated_at: "2026-09-25T08:00:00Z",
    removed_at: null,
    removed_by: null,
    ...over,
  };
}

const c15 = (room: string, description: string, work: CircuitWork = "new", panel_label: string | null = null) =>
  circuit({ room, description, amps: 15, poles: 1, wire: "14/2", work, panel_label });
const c20 = (room: string, description: string, work: CircuitWork = "new", panel_label: string | null = null) =>
  circuit({ room, description, amps: 20, poles: 1, wire: "12/2", work, panel_label });

export const FINAL_MAP: JobCircuit[] = [
  // Lighting, 15 A
  c15("Bath", "Bath Lights"),
  c15("Bedroom", "Bedroom And Chandelier Lights"),
  c15("Kitchen", "Kitchen And Living Lights", "reused", "Entry Lights"),
  // Outlets and dedicated, 20 A
  c20("Kitchen", "Outlets Right"),
  c20("Kitchen", "Outlets Left"),
  c20("Kitchen", "Disposal And Insta-Hot"),
  c20("Kitchen", "Fridge", "reused", "Mini Fridge"),
  c20("Bar", "Bar"),
  c20("Bar", "Wine Cooler"),
  c20("Living", "Outlets East"),
  c20("Living", "Outlets North"),
  c20("Living", "TV And Entertainment"),
  c20("Office", "Duplex Right"),
  c20("Office", "Duplex Left"),
  c20("Bedroom", "Outlets East"),
  c20("Bedroom", "Outlets West"),
  c20("Bath", "GFI Outlets"),
  c20("Laundry", "Washer"),
  c20("Stairs", "Dedicated"),
  // 240-volt
  circuit({ room: "Bath", description: "Floor Heat", amps: 20, poles: 2, wire: "12/2" }),
  circuit({ room: "Laundry", description: "Dryer", amps: 30, poles: 2, wire: "10/3" }),
  circuit({ room: "Kitchen", description: "Range", amps: 50, poles: 2, kind: "gfci", wire: "6/3", work: "existing" }),
];

const existing = (panel_label: string, amps: number | null, poles = 1, kind: CircuitKind | null = null, room: string | null = null) =>
  circuit({ room, description: null, panel_label, amps, poles, kind, work: "existing", source: "photo" });

export const PHOTO_EXISTING: JobCircuit[] = [
  existing("Garage", 20, 1, null, "Garage"),
  existing("Garage", 20, 1, null, "Garage"),
  existing("Mud Rm", null, 1, "afci", "Mud Room"),
  existing("40A 2-Pole", 40, 2),
  existing("GDO #1", null, 1, "spd", "Garage"),
  existing("GDO #2", null, 1, "spd", "Garage"),
  existing("Garage 15", 15, 1, "afci", "Garage"),
  existing("Smokes", null, 1, "afci"),
];

export const TICKET: HaveItem[] = [
  { label: "Q2020", qty: 8, form: "twin", slots: [{ poles: 1, amps: 20, kind: null }, { poles: 1, amps: 20, kind: null }] },
  {
    label: "Q21530CT",
    qty: 1,
    form: "quad",
    slots: [
      { poles: 1, amps: 15, kind: null },
      { poles: 1, amps: 15, kind: null },
      { poles: 2, amps: 30, kind: null },
    ],
  },
];

export const E017_ID = "0e685ab4-4d2a-4065-bc56-9a59e381cf96";
export const E017: QuoteCircuit[] = [
  { ckt: "1", load: "Countertop GFCI receptacles", wire: "12/2", breaker: "20A", description: "Kitchen small-appliance #1" },
  { ckt: "2", load: "Countertop GFCI receptacles", wire: "12/2", breaker: "20A", description: "Kitchen small-appliance #2" },
  { ckt: "3", load: "DW + garbage disposal (one circuit)", wire: "12/2", breaker: "20A", description: "Dishwasher + disposal" },
  { ckt: "4", load: "Fridge + freezer (one circuit)", wire: "12/2", breaker: "20A", description: "Refrigerator + freezer" },
  { ckt: "5", load: "GFCI bath recept", wire: "12/2", breaker: "20A", description: "Bath receptacles" },
  { ckt: "6", load: "Living/bedroom recepts", wire: "12/2", breaker: "20A", description: "General receptacles" },
  { ckt: "7", load: "Recessed cans + inserts", wire: "14/2", breaker: "15A", description: "Lighting #1" },
  { ckt: "8", load: "3-way runs / gimbals", wire: "14/2", breaker: "15A", description: "Lighting #2" },
  { ckt: "9", load: "LED cove tape + under-cabinet", wire: "14/2", breaker: "15A", description: "Lighting #3 / cove" },
  { ckt: "10", load: "110CFM exhaust + bath light", wire: "14/2", breaker: "15A", description: "Bath fan / lighting" },
  { ckt: "11", load: "14-50R range", wire: "6/3", breaker: "2P 50A", description: "Range" },
  { ckt: "12", load: "14-30R dryer", wire: "10/3", breaker: "2P 30A", description: "Dryer" },
];
