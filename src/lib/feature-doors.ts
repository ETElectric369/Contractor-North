/**
 * THE SHELL'S DOORS (the switch board, 0352). What the app shell reads from the switches, in one
 * place: the map the dock, the menus and the command bar draw from, where a new request's bell
 * and push land, and which pages carry the Off line when they're opened from a link.
 *
 * A SWITCH HIDES DOORS ONLY. Nothing here deletes a row, changes a number or blocks a page.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { featureOn, type FeatureKey, type FeatureMap } from "@/lib/features";

/**
 * The map the shell's doors read (rule j): the company's switches, with Crew & Payroll QUIET
 * until the company has a second person. One owner alone has nobody to pay, so Payroll, Employee
 * Docs and the Handbook stay out of his way even though the switch is on; they arrive with the
 * first active teammate. Only the doors go quiet: the switch itself still reads on, so a payroll
 * page opened from a link shows no Off line (a "Turn On" for a switch that's already on would be
 * a dead door).
 *
 * `teammates` is the count of active members who aren't the owner; null = unknown (a read that
 * failed), which shows the doors, as today.
 */
export function shellDoors(features: FeatureMap, teammates: number | null): FeatureMap {
  if (teammates === null || teammates > 0 || !features.crew_payroll) return features;
  return { ...features, crew_payroll: false };
}

/**
 * shellDoors' `teammates`: the active members who aren't the owner. Anyone else looking IS one, so
 * only the owner's view reads. A read that fails is null (the doors show, as today). The one count
 * the layout and every page that draws a payroll door use, so they can't disagree.
 */
export async function countTeammates(
  supabase: SupabaseClient,
  viewer: { role?: string | null; org_id?: string | null } | null,
): Promise<number | null> {
  if (viewer?.role !== "owner") return 1;
  if (!viewer.org_id) return null;
  const { count, error } = await supabase
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("org_id", viewer.org_id)
    .eq("active", true)
    .neq("role", "owner");
  return error ? null : (count ?? 0);
}

/**
 * Where a new request's bell entry and push land (rule d). Leads on: the lead list. Leads off:
 * My Day, where the request still arrives as a "New Request From …" card with Call Back (every
 * public request door keeps working with Leads off; only the list is out of the way).
 */
export function requestHref(features: FeatureMap | null | undefined): "/leads" | "/planner" {
  return featureOn(features, "leads") ? "/leads" : "/planner";
}

/**
 * THE PAGES A SWITCH OWNS, for the Off line (rule a). A page behind a hidden dock row still opens
 * from a link, a bell entry or a bookmark; the layout's RouteOffLine puts the Off line on top of
 * it. Path prefixes only: a page's own tabs (?tab=) are the page's business. Not here on purpose:
 *   /tax-report  the mileage deduction lives there, and it is not Sales Tax (rule g);
 *   /forms       it also holds every company's inspection sheet and intake form;
 *   /recurring   Recurring Billing takes only its repeat invoices; repeat jobs and expenses live there;
 *   /jobs/…      the job page switches its own tabs (offStrip).
 */
export const FEATURE_ROUTES: readonly { path: string; feature: FeatureKey }[] = [
  { path: "/leads", feature: "leads" },
  { path: "/inspections", feature: "leads" },
  { path: "/quotes", feature: "estimates" },
  { path: "/work-orders", feature: "estimates" },
  { path: "/change-orders", feature: "estimates" },
  { path: "/purchasing", feature: "purchase_orders" },
  { path: "/inventory", feature: "shop_stock" },
  { path: "/payroll", feature: "crew_payroll" },
  { path: "/employee-docs", feature: "crew_payroll" },
  { path: "/handbook", feature: "crew_payroll" },
  { path: "/compliance", feature: "licenses" },
  { path: "/insurance", feature: "licenses" },
  { path: "/audits", feature: "licenses" },
  { path: "/safety", feature: "safety_log" },
  { path: "/site-studio", feature: "website" },
  { path: "/assistant", feature: "nort" },
  { path: "/tools", feature: "calculators" },
];

/** The switch that owns this page, or null (most pages belong to no switch). */
export function featureForPath(pathname: string): FeatureKey | null {
  const hit = FEATURE_ROUTES.find((r) => pathname === r.path || pathname.startsWith(r.path + "/"));
  return hit?.feature ?? null;
}
