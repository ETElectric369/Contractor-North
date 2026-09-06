import { COMPANY } from "@/lib/company";
import type { Organization } from "@/lib/types";
import { accentHex } from "@/lib/org-settings";
import { formatCityStateZip } from "@/lib/utils";

export interface CompanyInfo {
  name: string;
  tagline: string;
  address1: string;
  address2: string;
  cityStateZip: string;
  phone: string;
  email: string;
  license: string;
  brand: string;
  logo: string;
}

/** Build display company info from the org record, falling back to defaults. */
export function companyFromOrg(org: Organization | null): CompanyInfo {
  const cityStateZip = formatCityStateZip(org?.city, org?.state, org?.zip); // "City, ST 12345"
  return {
    name: org?.name || COMPANY.name,
    tagline: COMPANY.tagline,
    address1: org?.address_line1 || COMPANY.addressLine1,
    address2: org?.address_line2 || COMPANY.addressLine2,
    cityStateZip,
    phone: org?.phone || COMPANY.phone,
    email: org?.email || COMPANY.email,
    license: org?.license || COMPANY.license,
    // The office pages hand us the whole organizations row (settings included); the public
    // doors hand us an RPC projection, which whitelists scalars and never ships settings —
    // audit v921: /q, /i and /c were painting the platform default teal while the very PDF
    // offered on the same page carried the org's tint. Read the flat key the projection can
    // carry, then the full row's settings. The projections still have to WHITELIST glass_tint
    // (one scalar, the way 0239 added doc_style) before the public doors go coloured.
    brand: accentHex(
      (org as { glass_tint?: string; settings?: { glass_tint?: string } } | null)?.glass_tint ??
        (org as { settings?: { glass_tint?: string } } | null)?.settings?.glass_tint,
    ),
    logo: org?.logo_url || "",
  };
}
