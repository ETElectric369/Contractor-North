/**
 * WHO A SUPPLIER PAPER IS FROM, said the company's own way (Wave 0). Every supplier, not one: the
 * name comes off the company's own supplier account, never a word the code knows ("CED").
 */

/**
 * A supplier's name, short enough to lead a card on a phone. "Consolidated Electrical
 * Distributors" is "CED" everywhere he goes; "Swigard's Hardware" is already short. A bracketed
 * short form the account itself carries ("Outdoor Supply Hardware (OSH - Cupertino)") wins.
 */
export function shortSupplierName(name: string | null | undefined): string {
  const raw = String(name ?? "").trim();
  if (!raw) return "The Supplier";
  const aside = /\(([^)]+)\)/.exec(raw)?.[1]?.trim();
  if (aside) return aside;
  const words = raw.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && !/^(inc|llc|co|corp|of|and|the)\.?,?$/i.test(w));
  if (raw.length > 24 && words.length >= 3) return words.map((w) => w[0].toUpperCase()).join("");
  return raw;
}

export interface SupplierAccountLite {
  id: string;
  name: string | null;
  account_number: string | null;
  branch_code: string | null;
}

/**
 * WHICH OF THE COMPANY'S SUPPLIER ACCOUNTS A SUPPLIER'S OWN INVOICE BELONGS TO. Matched on the
 * account number it prints (TR-34426), falling back to the branch code in its number
 * (8802-1103832). Both are identifiers the supplier printed, not guesses about a spelling: a fuzzy
 * match here would file somebody else's money onto the account. Null when neither matches.
 */
export function supplierAccountFor(
  accounts: readonly SupplierAccountLite[] | null | undefined,
  invoice: { accountNumber?: string | null; invoiceNumber?: string | null },
): { id: string; name: string } | null {
  const number = String(invoice?.accountNumber ?? "").trim().toLowerCase();
  const branch = String(invoice?.invoiceNumber ?? "").split("-")[0]?.trim().toLowerCase() ?? "";
  let byBranch: SupplierAccountLite | null = null;
  for (const a of accounts ?? []) {
    if (number && String(a.account_number ?? "").trim().toLowerCase() === number) return { id: String(a.id), name: String(a.name ?? "") };
    if (!byBranch && branch && String(a.branch_code ?? "").trim().toLowerCase() === branch) byBranch = a;
  }
  return byBranch ? { id: String(byBranch.id), name: String(byBranch.name ?? "") } : null;
}
