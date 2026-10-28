"use server";
import { dbError } from "@/lib/db-error";
import { errorMessage, reportError } from "@/lib/observe";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { createServiceClient } from "@/lib/supabase/server";
import { readAllOrgs } from "@/lib/cron-orgs";
import { getOrgSettings } from "@/lib/org-settings";
import { accessState, type AccessReason } from "@/lib/subscription";

/** One company's standing as Bug Watch › Companies shows it (cn-v1137). The standing itself —
 *  reason, days, who comped — is accessState's answer computed HERE, on the server, with the
 *  company's own timezone; the component only words it. `uncomped` is the same rule with the comp
 *  column set aside, so End Comp can show the standing it falls back to without re-deriving one. */
export type CompanyRow = {
  id: string;
  name: string;
  plan: string | null;
  status: string | null;
  active: boolean;
  reason: AccessReason;
  daysLeft: number | null;
  compedBy: "column" | "env" | null;
  uncomped: { active: boolean; reason: AccessReason; daysLeft: number | null; compedBy: "column" | "env" | null };
  trialEndsAt: string | null;
  periodEnd: string | null;
  compedUntil: string | null;
  /** Stripe holds a customer for the company (stripe_customer_id). NOT a card: startCheckout mints
   *  the customer BEFORE any payment, so an abandoned checkout sets it too (skeptic #43, S11). */
  stripeCustomer: boolean;
  createdAt: string | null;
  tz: string;
};

type RawOrg = {
  id: string;
  name: string | null;
  plan: string | null;
  subscription_status: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  comped_until: string | null;
  stripe_customer_id: string | null;
  created_at: string | null;
  settings: unknown;
};

const COMPANY_COLUMNS = "id, name, plan, subscription_status, trial_ends_at, current_period_end, comped_until, stripe_customer_id, created_at, settings";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every company's standing, by name, for North's own team. Platform-admin gated in the app layer;
 *  the read is on the SERVICE client because the viewer's own client sees one company under RLS,
 *  paged whole through readAllOrgs (cn-v1130: a failed page throws, never an empty run). A failed
 *  read is said beside empty rows; the gate's nothing stays a plain nothing (error null), like the
 *  reports and the errors. */
export async function listCompanies(): Promise<{ rows: CompanyRow[]; error: string | null }> {
  const ctx = await requirePlatformAdmin();
  if ("error" in ctx) return { rows: [], error: null };
  try {
    const all = await readAllOrgs<RawOrg>(createServiceClient(), COMPANY_COLUMNS);
    const nowMs = Date.now();
    const rows = all
      .map((o): CompanyRow => {
        const tz = getOrgSettings(o.settings).timezone;
        const state = accessState(o, { nowMs, tz });
        const without = accessState({ ...o, comped_until: null }, { nowMs, tz });
        return {
          id: o.id,
          name: (o.name ?? "").trim() || "Unnamed Company",
          plan: o.plan ?? null,
          status: o.subscription_status ?? null,
          active: state.active,
          reason: state.reason,
          daysLeft: state.daysLeft,
          compedBy: state.compedBy,
          uncomped: { active: without.active, reason: without.reason, daysLeft: without.daysLeft, compedBy: without.compedBy },
          trialEndsAt: o.trial_ends_at ?? null,
          periodEnd: o.current_period_end ?? null,
          compedUntil: o.comped_until ?? null,
          stripeCustomer: !!o.stripe_customer_id,
          createdAt: o.created_at ?? null,
          tz,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { rows, error: null };
  } catch (e) {
    reportError("bug-watch:companies", e);
    return { rows: [], error: errorMessage(e) };
  }
}

/** Comp Until / End Comp. One RPC door (0400): platform_set_comped_until is SECURITY DEFINER with
 *  the admin checked inside, so it runs on the VIEWER's own client and its refusal passes through in
 *  its own words; false (no such company) is said, never reported as done (the silent-write law).
 *  `untilIso` null clears the comp. */
export async function setCompedUntil(orgId: string, untilIso: string | null): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requirePlatformAdmin();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Only North's own team can do that." };
  if (!UUID.test(orgId ?? "")) return { ok: false, error: "Pick a company." };
  if (untilIso !== null && (typeof untilIso !== "string" || Number.isNaN(new Date(untilIso).getTime()))) return { ok: false, error: "Pick a date." };
  // A comp that has already run out is no comp: refused before the RPC, in words (skeptic #43, S11).
  if (untilIso !== null && new Date(untilIso).getTime() <= Date.now()) return { ok: false, error: "Pick a day after today." };
  const { data, error } = await ctx.supabase.rpc("platform_set_comped_until", { p_org: orgId, p_until: untilIso });
  if (error) return { ok: false, error: dbError(error) };
  if (data === true) return { ok: true, error: null };
  return { ok: false, error: "That company isn't there any more." };
}
