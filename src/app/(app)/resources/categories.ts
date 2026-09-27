/** The Resources categories, in the order the form lists them. Its own module (not the "use client"
 *  manager) so the server can read it too: Fill From Their Site lets the model pick one of these. */
export const RESOURCE_CATEGORIES: readonly string[] = [
  "Building Department",
  "Inspector",
  "Permit Portal",
  "Utility",
  "Supplier / Distributor",
  "Engineer",
  "Fire / AHJ",
  "Other",
];
