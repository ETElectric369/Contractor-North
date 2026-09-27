import {
  Sun,
  ListChecks,
  Wand2,
  Ban,
  Briefcase,
  Play,
  CalendarDays,
  CalendarClock,
  TrendingUp,
  UserPlus,
  Users,
  FileText,
  Receipt,
  CreditCard,
  Wallet,
  Tags,
  Boxes,
  Coins,
  Repeat,
  Calculator,
  Banknote,
  Clock,
  Building2,
  Stamp,
  ShieldCheck,
  HardHat,
  BookOpen,
  BookUser,
  ClipboardList,
  Wrench,
  IdCard,
  ScrollText,
  Activity,
  Scale,
  UserCog,
  Pause,
  CheckCircle2,
  Umbrella,
  ClipboardCheck,
  type LucideIcon,
} from "lucide-react";
import { JOB_STATUSES, jobStatusLabel, type JobStatus } from "./job-status";
import { featureOn, type FeatureKey, type FeatureMap } from "./features";

/** A leaf in a dock section — a single page. A node with `header: true` (and no href) is a
 *  non-clickable sub-group label inside the section's nav (e.g. "Money admin" within Office). */
export interface DockNode {
  id: string;
  label: string;
  icon: LucideIcon;
  href?: string;
  header?: boolean;
  /** Hidden from techs (office/admin/owner only). */
  staffOnly?: boolean;
  /** Extra route prefixes this page owns for active-section matching — routes that live
   *  under a different path than the child's href (e.g. Bills & POs owns /purchasing:
   *  PO detail pages live there but belong to Money). Never rendered as links. */
  owns?: string[];
  /** The switch this row belongs to (lib/features): off, the row is not drawn (visibleDock). */
  feature?: FeatureKey;
  /** The row's words while a switch is off: "Bills & POs" reads "Bills" with Purchase Orders off. */
  whenOff?: { feature: FeatureKey; label: string };
}

/** A top-level dock section. `href` is where a one-click on the title goes; `children`
 *  are its pages (shown as the left-sidebar sub-list on desktop / the top strip on mobile). */
export interface DockSection {
  key: string;
  label: string;
  /** Shorter label for the tight mobile tile (falls back to `label`). */
  short?: string;
  icon: LucideIcon;
  href: string;
  children: DockNode[];
  /** Whole section hidden from techs (office/admin/owner only). */
  staffOnly?: boolean;
  /** The mirror: hidden from STAFF, shown only to techs. Exactly one thing uses it — the "You"
   *  tile. Erik: "i like that tech have a you settings and since its all already moved to the
   *  dock how about make it on the dock for them only." Staff already have a Settings door in
   *  the avatar menu (cn-v326) and a tech has no business in the rest of Settings, so putting
   *  the whole page behind a rail tile for them is the shortest honest path to their own
   *  handful of switches. */
  techOnly?: boolean;
  /** The switch the whole tile belongs to (Tools = Calculators). A tile whose rows are all
   *  switched off goes too, without a tag (visibleDock). */
  feature?: FeatureKey;
}

/** First-letter cap for generated labels ("in progress" → "In progress"). The words stay
 *  single-sourced in jobStatusLabel so the dock's copy can't drift from the spine again. */
const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Icon per job status — the one presentation-only bit the job-status spine doesn't carry. */
const JOB_STATUS_ICONS: Record<JobStatus, LucideIcon> = {
  to_be_scheduled: CalendarClock, // the waiting room: won work with no dates yet
  scheduled: CalendarDays,
  in_progress: Play,
  on_hold: Pause,
  complete: CheckCircle2,
  cancelled: Ban,
};

// The dock, re-nerved to Alexa's office-designed map (June 26). Flat sections — every title is
// ONE CLICK to its main page; its pages live in the left sidebar (desktop) or the top strip
// (mobile). The big move: Customers (CRM) is promoted out of Sales into its own bottom section,
// "Contacts" — the people hub (clients + leads today; subcontractors next), interlinked with
// everything via the existing customer_id FKs. Order follows the day, with Contacts at the bottom.
export const DOCK: DockSection[] = [
  {
    key: "today",
    label: "Today",
    icon: Sun,
    href: "/planner",
    children: [
      { id: "t-day", label: "My Day", icon: Sun, href: "/planner" },
      { id: "t-tasks", label: "Tasks", icon: ListChecks, href: "/tasks" },
      // Staff only: Take Photo, Upload, File It and AI Review all save through requireStaff.
      { id: "t-org", label: "Organize", icon: Wand2, href: "/organize", staffOnly: true },
    ],
  },
  // Schedule PROMOTED to its own tile, between Today and Clock — Erik, by name: "Move: Schedule -
  // to main dock after Today before Clock". It had been a child pill under Today, and the man
  // planning a week lives on this screen too much for it to sit one level down. Office-only
  // (/schedule redirects techs to /planner); /calendar, /appointments and /map are server
  // redirects into /schedule, so no owns[] needed.
  {
    key: "schedule",
    label: "Schedule",
    icon: CalendarDays,
    href: "/schedule",
    staffOnly: true,
    children: [{ id: "s-week", label: "Schedule", icon: CalendarDays, href: "/schedule" }],
  },
  {
    key: "clock",
    label: "Clock",
    icon: Clock,
    href: "/timeclock", // everyone can clock in; timecards are office-only
    // The WHEN-DID pair only: Timeclock + Timecards. Schedule (the WHEN-WILL map) moved
    // up to Today so a planning surface no longer hides behind the timeclock's door.
    children: [
      { id: "ck-clock", label: "Timeclock", icon: Play, href: "/timeclock" },
      { id: "ck-cards", label: "Timecards", icon: CalendarClock, href: "/timecards", staffOnly: true },
    ],
  },
  {
    key: "sales",
    label: "Sales",
    icon: TrendingUp,
    href: "/leads", // Customers moved to Contacts; Sales is the prospect pipeline now
    staffOnly: true,
    // The pipeline in order: Leads → Inspections (the site walk-through between a lead and
    // its estimate — an inspection IS an appointment type, Erik 2026-07-14) → Estimates.
    children: [
      { id: "sl-leads", label: "Leads", icon: UserPlus, href: "/leads", feature: "leads" },
      { id: "sl-inspections", label: "Inspections", icon: ClipboardCheck, href: "/inspections", feature: "leads" },
      { id: "sl-quotes", label: "Estimates", icon: FileText, href: "/quotes", feature: "estimates" },
    ],
  },
  {
    key: "jobs",
    label: "Jobs",
    icon: Briefcase,
    href: "/jobs",
    children: [
      // The job lifecycle, GENERATED from the canonical JOB_STATUSES spine (its order IS the
      // lifecycle) so this list can't drift from the enum again — it had: missing invoiced +
      // cancelled, and a hand-written "Completed" vs canonical "complete". Guarded by dock.test.ts.
      // "All Jobs" is gone by Erik's call (2026-07 notes): the status pills ARE the list — the
      // unfiltered firehose was brain clutter (the section tile itself still lands on /jobs).
      ...JOB_STATUSES.map((s) => ({
        id: `j-${s}`,
        label: capFirst(jobStatusLabel(s)),
        icon: JOB_STATUS_ICONS[s],
        href: `/jobs?status=${s}`,
      })),
      // Permits live under active jobs (moved out of Office per Alexa). The old "Across all
      // jobs" cluster (Work Orders / Materials / Change Orders) left the nav with it — those
      // records are HUB-ONLY now, reached through the job's own tabs (Erik: "GO AWAY").
      // Plans & LiDAR left the nav (Erik 2026-07-14): "plans live with the estimator" — the
      // Upload Plans take-off on /quotes/new IS the plans feature; LiDAR ships with the native app.
    ],
  },
  {
    // Renamed in spirit to "Money" — this is where the owner looks for everything dollar-shaped.
    // The money-admin cluster (Payroll / Tax report / Analytics / Recurring / Petty cash) was
    // promoted UP here out of Office's 3rd-level bucket so it's one reach from the billing hub.
    key: "invoices",
    label: "Money",
    short: "Money",
    icon: Receipt,
    href: "/billing",
    staffOnly: true,
    children: [
      // Day-to-day billing.
      { id: "m-billing-h", label: "Billing", icon: Receipt, header: true },
      { id: "m-inv", label: "Invoices", icon: Receipt, href: "/billing" },
      // The AR ledger (lifecycle rework): "invoiced/partial payment" left the job lifecycle —
      // who-owes-what lives here, fed by invoices, one line per customer.
      { id: "m-ar", label: "Accounts Receivable", icon: Banknote, href: "/billing/ar" },
      { id: "m-pay", label: "Payments", icon: CreditCard, href: "/payments" },
      // Purchase Orders off: the row reads "Bills" and still owns /purchasing, so a PO opened by
      // a link lights Money (with the Off line on top).
      { id: "m-bills", label: "Bills & POs", icon: Wallet, href: "/bills", owns: ["/purchasing"], whenOff: { feature: "purchase_orders", label: "Bills" } },
      { id: "m-price", label: "Price List", icon: Tags, href: "/price-list" },
      // Money admin — promoted out of Office (Alexa's open "under billing?" call, now answered).
      { id: "m-ma-h", label: "Money admin", icon: Calculator, header: true },
      { id: "ma-payroll", label: "Payroll", icon: Banknote, href: "/payroll", feature: "crew_payroll" },
      // No switch: the Tax Report carries the mileage deduction, which is not Sales Tax.
      { id: "ma-tax", label: "Tax Report", icon: Calculator, href: "/tax-report" },
      { id: "ma-analytics", label: "Analytics", icon: TrendingUp, href: "/analytics" },
      // No switch: Recurring Billing takes only repeat INVOICES; repeat jobs and expenses keep
      // running, and this page is their only door (it draws its own Off line for the invoices).
      { id: "ma-recur", label: "Recurring", icon: Repeat, href: "/recurring" },
      { id: "ma-petty", label: "Petty Cash", icon: Coins, href: "/petty-cash" },
    ],
  },
  {
    key: "office",
    label: "Office",
    icon: Building2,
    href: "/team", // Erik 2026-07-20: Office lands on Team (was /compliance)
    // Not staff-only: a tech fills Forms (0195) and reads Compliance, Safety, Resources and the
    // Handbook from here. Team is staff-only (/team sends a tech back to My Day), so a tech's Office
    // lands on its first row he can open instead (visibleDock), never on a tile that bounces.
    children: [
      // Liabilities (Alexa's grouping). Insurance (e.g. workers' comp) + compliance Audits are
      // the next pages to build — flagged, not stubbed as dead links.
      { id: "o-liab-h", label: "Liabilities", icon: Scale, header: true },
      { id: "o-comply", label: "Compliance", icon: ShieldCheck, href: "/compliance", feature: "licenses" },
      { id: "o-insurance", label: "Insurance", icon: Umbrella, href: "/insurance", feature: "licenses" },
      { id: "o-safety", label: "Safety", icon: HardHat, href: "/safety", feature: "safety_log" },
      { id: "o-audits", label: "Audits", icon: ClipboardCheck, href: "/audits", feature: "licenses" },
      // HR — Team leads: the crew roster with real lifecycle verbs (change role,
      // reset login, deactivate/reactivate, remove) lifted out of Settings into its
      // own page (settings doctrine: Settings keeps zero team UI). Office-only.
      { id: "o-hr-h", label: "HR", icon: UserCog, header: true },
      { id: "o-team", label: "Team", icon: Users, href: "/team", staffOnly: true },
      { id: "o-docs", label: "Employee Docs", icon: IdCard, href: "/employee-docs", staffOnly: true, feature: "crew_payroll" },
      // Forms carries no switch: every company's /forms also holds its walk-through sheet and its
      // intake form, not only the safety checklists.
      { id: "o-forms", label: "Forms", icon: ClipboardList, href: "/forms" },
      { id: "o-resources", label: "Resources", icon: BookUser, href: "/resources" },
      { id: "o-handbook", label: "Handbook", icon: BookOpen, href: "/handbook", feature: "crew_payroll" },
      // Stock — the money-admin cluster (Payroll/Tax/Analytics/Recurring/Petty cash) was promoted
      // up to the Money section; only Inventory (warehouse stock, not a dollar ledger) stays here.
      { id: "o-stock-h", label: "Stock", icon: Boxes, header: true, staffOnly: true },
      { id: "ma-stock", label: "Shop Stock", icon: Boxes, href: "/inventory", staffOnly: true, feature: "shop_stock" },
      // Diagnostics. Settings is NO LONGER a link here (zero-duplication law): it lives
      // behind the avatar (the predictable phone-app door, cn-v326). Office no longer OWNS
      // /settings either — Settings is its own territory now, owned by no dock section, so
      // its OWN side-tab (settings-subnav) drives its clusters instead of Office's list
      // cluttering the settings page (cn-v331).
      // Bug Watch left the company's dock (Wave 0): bug reports are North's business, reached from
      // the avatar menu by platform admins only. What stays is the company's own history.
      { id: "o-diag-h", label: "History", icon: ScrollText, header: true, staffOnly: true },
      { id: "o-activity", label: "Activity", icon: Activity, href: "/activity", staffOnly: true },
      { id: "o-audit", label: "Activity Audit", icon: ScrollText, href: "/audit", staffOnly: true },
    ],
  },
  {
    // THE big move: Contacts is its own bottom-of-the-dock section now, not buried in Sales.
    // Already interlinked with jobs/quotes/invoices/appointments through customer_id. Today it
    // holds clients (the CRM) + leads; subcontractors join once that record type exists.
    key: "contacts",
    label: "Contacts",
    icon: Users,
    href: "/crm",
    staffOnly: true,
    // Just the one destination — Leads lives under Sales (the pipeline), not duplicated here.
    children: [{ id: "c-all", label: "All Contacts", icon: Users, href: "/crm" }],
  },
  {
    // A TECH'S OWN SETTINGS, ON THE DOCK. Everything else in /settings is the company's and is
    // admin business — but his name, his photo, how Nort talks to him, his language, Face ID and
    // his push notifications are his. Staff never see this tile: they reach the same page (and
    // the other nine groups) through the avatar menu.
    key: "you",
    label: "You",
    icon: UserCog,
    href: "/settings?tab=you",
    techOnly: true,
    children: [],
  },
  {
    // Pulled out of Office to its own dock section — the calculators/utilities are a daily
    // field reach, so they get a one-tap home (everyone, not staff-only).
    key: "tools",
    label: "Tools",
    icon: Wrench,
    href: "/tools",
    feature: "calculators",
    children: [{ id: "tl-all", label: "Calculators & Tools", icon: Wrench, href: "/tools" }],
  },
];

/** Path part of an href — the bit before any ?query (shared by every dock renderer). */
export const basePath = (href: string) => href.split("?")[0];

/**
 * THE ONE DOCK FILTER (the switch board, 0352): the dock this person sees. The rail, the phone
 * bar, the section strip/sheet and the command bar all draw from it, so the role rule and the
 * switch rule can't drift between them (the role filter used to be copied into each renderer).
 *
 *   role      staffOnly hides from techs, techOnly hides from staff (tiles and rows). A tile whose
 *             landing row is staff-only lands a tech on its first row he sees (Office: /compliance).
 *   switches  a row or tile whose switch is off is not drawn. A heading left with no rows under
 *             it goes; a tile whose rows were all switched off goes (Sales, with Leads and
 *             Estimates both off); a tile whose own landing page was switched off lands on its
 *             first row still drawn (Sales with Leads off: /quotes). "Bills & POs" reads "Bills".
 *
 * A SWITCH HIDES DOORS ONLY: a page behind a hidden row still opens from a link, with the Off
 * line on top (components/route-off-line). `features` is what the layout hands the shell (lib/
 * feature-doors shellDoors); no map is everything on, which is the role filter alone.
 */
export function visibleDock({ isStaff, features }: { isStaff: boolean; features?: FeatureMap | null }): DockSection[] {
  const on = (k?: FeatureKey) => !k || featureOn(features, k);
  const mine = (c: DockNode) => isStaff || !c.staffOnly;
  return DOCK.filter((s) => (isStaff || !s.staffOnly) && (!isStaff || !s.techOnly) && on(s.feature)).flatMap((s) => {
    const rows = s.children
      .filter((c) => mine(c) && on(c.feature))
      .map((c) => (c.whenOff && !on(c.whenOff.feature) ? { ...c, label: c.whenOff.label } : c));
    // A heading only labels the rows under it: none left before the next heading, no heading.
    const children = rows.filter((c, i) => {
      if (!c.header) return true;
      const rest = rows.slice(i + 1);
      const next = rest.findIndex((r) => r.header);
      return rest.slice(0, next < 0 ? undefined : next).some((r) => r.href);
    });
    // A tile goes when a SWITCH hid all its rows, never the role: the tech-only "You" tile (no rows
    // at all) stays.
    const switchedOff = s.children.filter((c) => mine(c) && !on(c.feature));
    if (switchedOff.length && !children.some((c) => c.href)) return [];
    // A tile whose own landing row isn't drawn for this person (switched off, or staff-only for a
    // tech: Office's Team) lands on its first row still drawn, so no tile bounces.
    const landingHidden = s.children.some(
      (c) => c.href && basePath(c.href) === basePath(s.href) && (!mine(c) || !on(c.feature)),
    );
    const href = landingHidden ? (children.find((c) => c.href)?.href ?? s.href) : s.href;
    return [{ ...s, href, children }];
  });
}

/**
 * THE active-section matcher — the single copy used by the desktop dock rail, the phone
 * bottom tiles AND the mobile SectionSubnav strip. (It was triplicated across those three
 * and drifting: none prefix-matched child routes, so /quotes/abc lit "Today" on desktop,
 * zero tiles on mobile, and the strip vanished by accident.)
 *
 * A section owns a pathname when the pathname is the section href, sits under it, is one
 * of the section's child pages, sits under one of them (the detail routes: /quotes/[id],
 * /forms/[id]…), or matches a child's `owns` alias prefixes (/purchasing/[id] belongs to
 * Money's Bills & POs). /work-orders/[id] is NOT owned anymore — work orders left the
 * dock (hub-only), so those routes light nothing by design.
 *
 * Returns undefined when nothing owns the route — light NOTHING rather than lie. (The old
 * dock.tsx `?? sections[0]` fallback lit "Today" on every orphan route: an actively wrong
 * map.) Pass the role-filtered section list so a tech never lights a staff-only tile.
 * Guarded by dock.test.ts — one case per [id] route family.
 */
export function activeSection(
  pathname: string,
  sections: DockSection[] = DOCK,
): DockSection | undefined {
  const under = (base: string) => pathname === base || pathname.startsWith(base + "/");
  return sections.find(
    (s) =>
      // basePath, because a section href may carry a query — the tech-only "You" tile points at
      // /settings?tab=you, and a raw compare against a pathname (which never has a query) would
      // mean the tile could never light. Every other section href is query-less, so this is a
      // no-op for them.
      under(basePath(s.href)) ||
      s.children.some((c) => (c.href ? under(basePath(c.href)) : false) || c.owns?.some(under)),
  );
}
