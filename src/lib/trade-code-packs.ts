/**
 * Curated starter job-code packs, one per trade. "Import a trade's codes" in Settings → Scheduling
 * bulk-adds a pack into the org's job_codes (skipping any code it already has), so a new org isn't
 * staring at an empty list. Codes are the cost/labor buckets the crew picks at clock-in — kept short
 * and trade-real, not a formal standard. billable defaults true; the few overhead codes are false.
 * Pure data (no server imports) so the Settings client can render the picker from it directly.
 */
export type TradeCode = { code: string; description: string; billable?: boolean };
export type TradeCodePack = { id: string; label: string; codes: TradeCode[] };

// Shared overhead/tail codes most trades want (travel, material runs, cleanup, warranty, admin).
const OVERHEAD: TradeCode[] = [
  { code: "TRAVEL", description: "Travel / drive time" },
  { code: "MTL", description: "Material pickup", billable: false },
  { code: "CLEAN", description: "Job-site cleanup" },
  { code: "WARR", description: "Warranty / callback", billable: false },
  { code: "ADMIN", description: "Admin / paperwork", billable: false },
];

export const TRADE_CODE_PACKS: TradeCodePack[] = [
  {
    id: "electrical",
    label: "Electrical",
    codes: [
      { code: "SVC", description: "Service call" },
      { code: "TRBL", description: "Troubleshooting / diagnostics" },
      { code: "ROUGH", description: "Rough-in wiring" },
      { code: "TRIM", description: "Trim-out / devices" },
      { code: "PANEL", description: "Panel / service upgrade" },
      { code: "METER", description: "Meter / service entrance" },
      { code: "LIGHT", description: "Lighting install" },
      { code: "CUSTOM", description: "Custom lighting design & fab" },
      { code: "LV", description: "Low-voltage / data / AV" },
      { code: "EV", description: "EV charger install" },
      { code: "GEN", description: "Generator / backup power" },
      { code: "SOLAR", description: "Solar / battery storage" },
      { code: "FIRE", description: "Fire alarm / smoke detectors" },
      { code: "DEMO", description: "Demolition / removal" },
      { code: "INSP", description: "Inspection / permit" },
      ...OVERHEAD,
    ],
  },
  {
    id: "deck",
    label: "Deck / Carpentry",
    codes: [
      { code: "DEMO", description: "Demolition / tear-out" },
      { code: "FOOT", description: "Footings / concrete" },
      { code: "FRAME", description: "Framing / structure" },
      { code: "DECK", description: "Decking install" },
      { code: "RAIL", description: "Railings" },
      { code: "STAIR", description: "Stairs" },
      { code: "FASCIA", description: "Fascia / trim" },
      { code: "PERGOLA", description: "Pergola / shade structure" },
      { code: "FENCE", description: "Fence" },
      { code: "WPROOF", description: "Waterproofing / flashing" },
      { code: "FINISH", description: "Finish / detail" },
      { code: "INSP", description: "Inspection / permit" },
      ...OVERHEAD,
    ],
  },
  {
    id: "hvac",
    label: "HVAC",
    codes: [
      { code: "SVC", description: "Service call" },
      { code: "TRBL", description: "Diagnostics" },
      { code: "INSTALL", description: "Equipment install" },
      { code: "DUCT", description: "Ductwork" },
      { code: "MAINT", description: "Maintenance / tune-up" },
      { code: "REFRIG", description: "Refrigerant / charging" },
      { code: "THERM", description: "Thermostat / controls" },
      { code: "INSP", description: "Inspection / permit" },
      ...OVERHEAD,
    ],
  },
  {
    id: "plumbing",
    label: "Plumbing",
    codes: [
      { code: "SVC", description: "Service call" },
      { code: "TRBL", description: "Diagnostics" },
      { code: "ROUGH", description: "Rough-in" },
      { code: "TRIM", description: "Fixture set / trim" },
      { code: "DRAIN", description: "Drain / sewer" },
      { code: "WHTR", description: "Water heater" },
      { code: "GAS", description: "Gas line" },
      { code: "REPIPE", description: "Repipe" },
      { code: "INSP", description: "Inspection / permit" },
      ...OVERHEAD,
    ],
  },
  {
    id: "general",
    label: "General / other trade",
    codes: [
      { code: "LABOR", description: "General labor" },
      { code: "SVC", description: "Service call" },
      { code: "INSTALL", description: "Install" },
      { code: "REPAIR", description: "Repair" },
      { code: "MEET", description: "Meeting / consult" },
      { code: "INSP", description: "Inspection / permit" },
      ...OVERHEAD,
    ],
  },
];

/** Lightweight list (id + label + count) for the client picker — no need to ship every code twice. */
export const TRADE_PACK_OPTIONS = TRADE_CODE_PACKS.map((p) => ({ id: p.id, label: p.label, count: p.codes.length }));
