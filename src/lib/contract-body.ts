import { formatCurrency } from "@/lib/utils";

/** Inputs for generating a service-contract body from a job. Strings are pre-formatted
 *  by the caller (dates in the org timezone); money is formatted here. */
export type ContractParty = { name: string; line2?: string; address?: string; contact?: string };
export type ContractScheduleLine = { label: string; percent?: number | null; dollars: number };
export type ContractInput = {
  contractor: ContractParty;
  customer: ContractParty;
  propertyAddress?: string;
  scopeTitle: string;
  scopeDetail?: string;
  startDate?: string;
  endDate?: string;
  billingType: "fixed" | "tm";
  contractTotal: number;
  schedule: ContractScheduleLine[];
  terms?: string;
};

function block(label: string, lines: (string | undefined)[]): string {
  const body = lines.filter((l) => l && l.trim()).join("\n");
  return body ? `${label}\n${body}` : "";
}

/** Build the full agreement text. Deterministic — the same inputs always produce the
 *  same body, so a generated contract can be frozen and re-rendered identically. */
export function buildContractBody(input: ContractInput): string {
  const c = input.contractor;
  const cu = input.customer;

  const parties = block("PARTIES", [
    `Contractor: ${c.name}`,
    c.line2,
    c.address,
    c.contact,
    "",
    `Customer: ${cu.name}`,
    cu.line2,
    cu.address,
    cu.contact,
  ]);

  const property = block("PROPERTY / WORK LOCATION", [input.propertyAddress || cu.address]);

  const scope = block("SCOPE OF WORK", [input.scopeTitle, input.scopeDetail]);

  const schedule = block("SCHEDULE", [
    `Start: ${input.startDate || "To be scheduled"}`,
    `Substantial completion: ${input.endDate || "To be scheduled"}`,
  ]);

  let pay: string;
  if (input.billingType === "tm") {
    pay = block("PRICE & PAYMENT", [
      "Billing: Time & Materials — labor and materials are billed as the work proceeds.",
      input.contractTotal > 0 ? `Estimate (not a cap): ${formatCurrency(input.contractTotal)}` : undefined,
    ]);
  } else {
    const lines = [`Contract price: ${formatCurrency(input.contractTotal)}`, "Payment schedule:"];
    input.schedule.forEach((s, i) => {
      const pct = Number(s.percent) > 0 ? ` (${Number(s.percent)}%)` : "";
      lines.push(`  ${i + 1}. ${s.label}${pct} — ${formatCurrency(s.dollars)}`);
    });
    if (input.schedule.length === 0) lines.push("  (no schedule set — to be agreed)");
    pay = block("PRICE & PAYMENT", lines);
  }

  const terms = block("TERMS", [input.terms]);

  const closing =
    "By signing below, the customer acknowledges they have read and agree to the scope, price, schedule, and terms of this contract, and consent to sign electronically.";

  return [parties, property, scope, schedule, pay, terms, closing]
    .filter((s) => s && s.trim())
    .join("\n\n");
}
