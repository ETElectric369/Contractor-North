/**
 * THE PORTAL HOME, AS DATA (/portal/<token>). Pure: customer_portal's result in, what the page
 * shows out, so the parts that were wrong are unit tests.
 *
 *  - THE ORG'S OWN GLASS (audit v994 DD2). The home read org.glass_tint, which customer_portal
 *    never projected, so the account page was always the default teal while the job page wore the
 *    org's color. 0323 projects it; this takes it only when it is a "#rrggbb" color (seaGlassStyle
 *    checks again), the same rule the job page's shape uses.
 *  - THE RUNNING BILL (Connected North, Andrew's Herringbone). A long-running draft is not a bill,
 *    so the home's Bills list never named it, and the home said nothing about $2,830.89 still to
 *    pay. 0323 returns, per job, the sum of that customer's draft bills; each becomes one row,
 *    "13897 Herringbone · Running total, not a bill yet · $2,830.89 left", opening the job page.
 */
import type { PortalOrg } from "@/components/portal/portal-shell";

const HEX = /^#[0-9a-f]{6}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const cents = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export type PortalHomeOrgRaw = {
  name?: string | null;
  logo_url?: string | null;
  phone?: string | null;
  email?: string | null;
  license?: string | null;
  glass_tint?: string | null;
} | null;

export type PortalHomeRunningRaw = {
  job_id?: string | null;
  job_name?: string | null;
  job_number?: string | null;
  total?: number | string | null;
  amount_paid?: number | string | null;
};

export type PortalHomeRunning = {
  jobId: string;
  name: string;
  number: string | null;
  /** Everything on the job's running bill so far, and paid against it. */
  total: number;
  paid: number;
  /** total − paid, in whole cents, not floored: below zero, the customer has paid ahead. */
  balance: number;
};

/** The header and skin of the home: the org's name, contact, and its own glass color. */
export function portalHomeOrg(org: PortalHomeOrgRaw): PortalOrg {
  return {
    name: str(org?.name) ?? "Your contractor",
    logoUrl: str(org?.logo_url),
    phone: str(org?.phone),
    email: str(org?.email),
    license: str(org?.license),
    tint: org?.glass_tint && HEX.test(org.glass_tint) ? org.glass_tint.toLowerCase() : null,
  };
}

/** One row per job with a running bill. A row without a real job id is dropped (it could not open). */
export function portalHomeRunning(rows: readonly PortalHomeRunningRaw[] | null | undefined): PortalHomeRunning[] {
  const out: PortalHomeRunning[] = [];
  for (const r of rows ?? []) {
    const id = str(r?.job_id);
    if (!id || !UUID.test(id)) continue;
    const t = cents(r.total);
    const p = cents(r.amount_paid);
    out.push({ jobId: id, name: str(r.job_name) ?? "Your job", number: str(r.job_number), total: t / 100, paid: p / 100, balance: (t - p) / 100 });
  }
  return out;
}
