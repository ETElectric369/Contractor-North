import { formatCurrency } from "@/lib/utils";

/** Inputs for a California 20-day Preliminary Notice, auto-filled from the job. */
export type PrelimParty = { name?: string | null; address?: string | null };
export type PrelimInput = {
  claimant: { name: string; address?: string | null; license?: string | null };
  owner: PrelimParty;
  hiredBy?: PrelimParty; // §8102(a)(6): the person who contracted with the claimant
  gc?: PrelimParty; // direct/general contractor, when the claimant is a sub
  lender?: PrelimParty;
  propertyAddress?: string | null;
  description?: string | null;
  estimatedAmount?: number | null;
};

/** The statutory NOTICE TO PROPERTY OWNER warning required by Cal. Civ. Code § 8202. */
const OWNER_WARNING =
  "NOTICE TO PROPERTY OWNER: EVEN THOUGH YOU HAVE PAID YOUR CONTRACTOR IN FULL, if the " +
  "person or firm that has given you this notice is not paid in full for labor, service, " +
  "equipment, or material provided or to be provided to your construction project, a lien " +
  "may be placed on your property. Foreclosure of the lien may lead to loss of all or part " +
  "of your property. You may wish to protect yourself against this by (1) requiring your " +
  "contractor to provide a signed release by the person or firm that has given you this " +
  "notice before making payment to your contractor, or (2) any other method that is " +
  "appropriate under the circumstances. This notice is required by law to be served by the " +
  "undersigned as a statement of your legal rights. This notice is not intended to reflect " +
  "upon the financial condition of the contractor or the person employed by you on the " +
  "construction project. If you record a notice of cessation or completion of your " +
  "construction project, you must within 10 days after recording, send a copy of the notice " +
  "to your contractor and the person or firm that has given you this notice. The notice must " +
  "be sent by registered or certified mail. Failure to send the notice will extend the " +
  "deadlines to record a claim of lien. You are not required to send the notice if you are a " +
  "residential homeowner of a dwelling containing four or fewer units.";

function party(label: string, p?: PrelimParty | null): string {
  if (!p || (!p.name && !p.address)) return `${label}: (unknown — fill in before serving)`;
  // A party that must be SERVED needs an address; flag a name-only line so it isn't
  // mistaken for complete (e.g. a sub must serve the direct contractor at an address).
  const name = p.name || "(name — fill in)";
  const addr = p.address || "(address — fill in before serving)";
  return `${label}: ${name}, ${addr}`;
}

/** Build the Preliminary Notice text. Deterministic — same inputs, same notice. */
export function buildPrelimNotice(input: PrelimInput): string {
  const c = input.claimant;
  const header = [
    "CALIFORNIA PRELIMINARY NOTICE",
    "(Cal. Civ. Code §§ 8200–8216)",
  ].join("\n");

  const relationship = input.gc?.name
    ? `subcontractor to ${input.gc.name}`
    : "direct contractor to the owner";
  const claimant = [
    "CLAIMANT (the undersigned):",
    `  ${c.name}${c.license ? `, License #${c.license}` : ""}`,
    c.address ? `  ${c.address}` : undefined,
    `  Relationship to the parties: ${relationship}.`,
    "  Furnishing: labor, services, equipment, and/or materials for the construction project below.",
  ]
    .filter(Boolean)
    .join("\n");

  const parties = [
    party("PROPERTY OWNER / REPUTED OWNER", input.owner),
    party("PERSON WHO CONTRACTED FOR THE WORK (work provided to/for)", input.hiredBy),
    party("DIRECT (GENERAL) CONTRACTOR / REPUTED", input.gc),
    party("CONSTRUCTION LENDER / REPUTED", input.lender),
  ].join("\n");

  const project = [
    `PROJECT / JOBSITE: ${input.propertyAddress || "(address — fill in before serving)"}`,
    `GENERAL DESCRIPTION OF WORK: ${input.description || "Electrical labor and materials."}`,
    `ESTIMATED TOTAL PRICE: ${input.estimatedAmount && input.estimatedAmount > 0 ? formatCurrency(input.estimatedAmount) : "(estimate — fill in)"}`,
  ].join("\n");

  const disclaimer =
    "— This notice was auto-generated for convenience. Before serving, verify the content, the " +
    "recipients (owner, direct contractor, and construction lender), the service method " +
    "(personal or registered/certified mail with proof of service), and the 20-day deadline for " +
    "your role and project. This is not legal advice; consult an attorney if unsure.";

  return [header, claimant, parties, project, "NOTICE TO PROPERTY OWNER", OWNER_WARNING, disclaimer]
    .join("\n\n");
}
