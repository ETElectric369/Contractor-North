/**
 * Starter job-code presets by trade, used at org creation so a new company begins
 * with codes that fit its work instead of a generic/electrical default. The picked
 * trade's `codes` are passed to the create_organization RPC (migration 0078) as
 * `p_codes`; the org can edit/add codes anytime in Settings.
 */
export type JobCodeSeed = { code: string; description: string; billable: boolean };

const TRAVEL: JobCodeSeed = { code: "TRAVEL", description: "Travel time", billable: true };
const SHOP: JobCodeSeed = { code: "SHOP", description: "Shop / yard time", billable: false };
const PTO: JobCodeSeed = { code: "PTO", description: "Paid time off", billable: false };
const SVC: JobCodeSeed = { code: "SVC", description: "Service call", billable: true };

export const TRADE_PRESETS: Record<string, { label: string; codes: JobCodeSeed[] }> = {
  general: {
    label: "General contractor",
    codes: [
      SVC,
      { code: "INSTALL", description: "Install / build", billable: true },
      { code: "REPAIR", description: "Repair", billable: true },
      { code: "LABOR", description: "General labor", billable: true },
      { code: "MATL", description: "Material run", billable: true },
      TRAVEL, { code: "CLEAN", description: "Cleanup", billable: true }, SHOP, PTO,
    ],
  },
  deck: {
    label: "Deck / carpentry",
    codes: [
      { code: "DEMO", description: "Demo / teardown", billable: true },
      { code: "FOOT", description: "Footings / posts", billable: true },
      { code: "FRAME", description: "Framing / substructure", billable: true },
      { code: "DECK", description: "Decking install", billable: true },
      { code: "RAIL", description: "Railing", billable: true },
      { code: "STAIR", description: "Stairs", billable: true },
      { code: "FINISH", description: "Finish / seal / stain", billable: true },
      { code: "REPAIR", description: "Repair", billable: true },
      SVC, TRAVEL, SHOP, PTO,
    ],
  },
  electrical: {
    label: "Electrical",
    codes: [
      SVC,
      { code: "ROUGH", description: "Rough-in wiring", billable: true },
      { code: "TRIM", description: "Trim-out / devices", billable: true },
      { code: "PANEL", description: "Panel / service upgrade", billable: true },
      { code: "TROUB", description: "Troubleshooting", billable: true },
      { code: "LOW", description: "Low voltage / data", billable: true },
      { code: "GEN", description: "Generator install", billable: true },
      TRAVEL, SHOP, PTO,
    ],
  },
  plumbing: {
    label: "Plumbing",
    codes: [
      SVC,
      { code: "ROUGH", description: "Rough-in", billable: true },
      { code: "FINISH", description: "Finish / fixtures", billable: true },
      { code: "DRAIN", description: "Drain / sewer", billable: true },
      { code: "WATER", description: "Water heater", billable: true },
      { code: "GAS", description: "Gas line", billable: true },
      { code: "REPAIR", description: "Repair", billable: true },
      TRAVEL, SHOP, PTO,
    ],
  },
  hvac: {
    label: "HVAC",
    codes: [
      SVC,
      { code: "INSTALL", description: "Install / changeout", billable: true },
      { code: "DUCT", description: "Ductwork", billable: true },
      { code: "MAINT", description: "Maintenance / tune-up", billable: true },
      { code: "REPAIR", description: "Repair", billable: true },
      TRAVEL, SHOP, PTO,
    ],
  },
  landscaping: {
    label: "Landscaping",
    codes: [
      { code: "INSTALL", description: "Install / planting", billable: true },
      { code: "MAINT", description: "Maintenance", billable: true },
      { code: "IRRIG", description: "Irrigation", billable: true },
      { code: "HARD", description: "Hardscape", billable: true },
      { code: "CLEAN", description: "Cleanup / haul", billable: true },
      TRAVEL, SHOP, PTO,
    ],
  },
  roofing: {
    label: "Roofing",
    codes: [
      { code: "TEAR", description: "Tear-off", billable: true },
      { code: "INSTALL", description: "Install / re-roof", billable: true },
      { code: "FLASH", description: "Flashing / detail", billable: true },
      { code: "REPAIR", description: "Repair", billable: true },
      SVC, TRAVEL, SHOP, PTO,
    ],
  },
  concrete: {
    label: "Concrete / masonry",
    codes: [
      { code: "FORM", description: "Form / prep", billable: true },
      { code: "POUR", description: "Pour", billable: true },
      { code: "FINISH", description: "Finish", billable: true },
      { code: "DEMO", description: "Demo", billable: true },
      { code: "REPAIR", description: "Repair", billable: true },
      TRAVEL, SHOP, PTO,
    ],
  },
  painting: {
    label: "Painting",
    codes: [
      { code: "PREP", description: "Prep / mask", billable: true },
      { code: "PAINT", description: "Paint / spray", billable: true },
      { code: "TRIM", description: "Trim / detail", billable: true },
      { code: "REPAIR", description: "Repair / patch", billable: true },
      TRAVEL, SHOP, PTO,
    ],
  },
  tile: {
    label: "Tile / flooring",
    codes: [
      { code: "DEMO", description: "Demo / tear-out", billable: true },
      { code: "PREP", description: "Substrate prep / leveling", billable: true },
      { code: "WPROOF", description: "Waterproofing / membrane", billable: true },
      { code: "BACKER", description: "Backer board / underlayment", billable: true },
      { code: "SET", description: "Tile setting / install", billable: true },
      { code: "GROUT", description: "Grout / seal", billable: true },
      { code: "REPAIR", description: "Repair / regrout", billable: true },
      SVC, TRAVEL, SHOP, PTO,
    ],
  },
};

/** Ordered for the onboarding dropdown — General first, then alphabetical-ish by trade. */
export const TRADE_ORDER = ["general", "deck", "electrical", "plumbing", "hvac", "landscaping", "roofing", "concrete", "tile", "painting"] as const;
