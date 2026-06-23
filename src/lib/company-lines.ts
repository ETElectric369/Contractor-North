import type { CompanyInfo } from "@/components/doc-letterhead";

export type CompanyBlock = {
  address: string[]; // address line(s) + city/state/zip
  contact: string[]; // phone, email
  license: string | null;
};

/**
 * THE canonical company letterhead, grouped for the "Option C" layout: the address
 * block, then phone/email behind a brand accent rule, then the license (emphasized).
 * Used by BOTH the printed-document letterhead and the invoice email so the two never
 * drift. Pure (no React) so the server-only email HTML can import it too.
 */
export function companyBlock(co: CompanyInfo): CompanyBlock {
  const lic = co.license ? (/lic/i.test(co.license) ? co.license : `License #${co.license}`) : null;
  return {
    address: [co.address1, co.address2, co.cityStateZip].filter(Boolean) as string[],
    contact: [co.phone, co.email].filter(Boolean) as string[],
    license: lic,
  };
}
