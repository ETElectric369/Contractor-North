import { Zap } from "lucide-react";
import { COMPANY } from "@/lib/company";
import type { Organization } from "@/lib/types";

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
  const cityStateZip = [org?.city, org?.state, org?.zip]
    .filter(Boolean)
    .join(", ")
    .replace(/, (\S+)$/, " $1"); // "City, ST 12345"
  return {
    name: org?.name || COMPANY.name,
    tagline: COMPANY.tagline,
    address1: org?.address_line1 || COMPANY.addressLine1,
    address2: org?.address_line2 || COMPANY.addressLine2,
    cityStateZip,
    phone: org?.phone || COMPANY.phone,
    email: org?.email || COMPANY.email,
    license: org?.license || COMPANY.license,
    brand: org?.brand_color || "#0b57c4",
    logo: org?.logo_url || "",
  };
}

/** Left-hand letterhead block for printed documents. */
export function Letterhead({ co }: { co: CompanyInfo }) {
  const meta = [
    [co.address1, co.address2].filter(Boolean).join(", "),
    co.cityStateZip,
    co.phone,
    co.email,
    co.license,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex items-center gap-3">
      <div
        className="flex h-11 w-11 items-center justify-center rounded-lg text-white"
        style={{ backgroundColor: co.brand }}
      >
        <Zap className="h-6 w-6" />
      </div>
      <div>
        <div className="text-xl font-bold text-slate-900">{co.name}</div>
        <div className="text-xs text-slate-500">{co.tagline}</div>
        {meta && <div className="mt-1 text-xs text-slate-500">{meta}</div>}
      </div>
    </div>
  );
}
