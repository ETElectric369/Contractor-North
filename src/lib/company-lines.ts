import type { CompanyInfo } from "@/components/doc-letterhead";

/**
 * THE canonical company contact block — one stacked item per line (address line(s),
 * city/state/zip, phone, email, license). Used by BOTH the printed-document
 * letterhead and the invoice email so the two never drift. Pure (no React), so the
 * server-only email HTML can import it too.
 */
export function companyLines(co: CompanyInfo): string[] {
  const lic = co.license ? (/lic/i.test(co.license) ? co.license : `License #${co.license}`) : "";
  return [co.address1, co.address2, co.cityStateZip, co.phone, co.email, lic].filter(Boolean);
}
