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
  Bug,
  Scale,
  UserCog,
  Pause,
  CheckCircle2,
  Umbrella,
  ClipboardCheck,
  type LucideIcon,
} from "lucide-react";
import { JOB_STATUSES, jobStatusLabel, type JobStatus } from "./job-status";

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
      // Schedule = planning the WHEN-WILL, so it lives with Today (plan/do), not behind the
      // timeclock's impulse door — it sat as Clock's 3rd pill and nothing in the dock said
      // "calendar". Office-only (/schedule redirects techs to /planner). /calendar,
      // /appointments and /map are server redirects into /schedule, so no owns[] needed.
      { id: "t-sched", label: "Schedule", icon: CalendarDays, href: "/schedule", staffOnly: true },
      { id: "t-tasks", label: "Tasks", icon: ListChecks, href: "/tasks" },
      { id: "t-org", label: "Organize", icon: Wand2, href: "/organize" },
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
      { id: "j-permits", label: "Permits", icon: Stamp, href: "/permits", staffOnly: true },
      // Plans & LiDAR left the nav (Erik 2026-07-14): "plans live with the estimator" — the
      // Upload Plans take-off on /quotes/new IS the plans feature; LiDAR ships with the native app.
    ],
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
    children: [
      { id: "sl-leads", label: "Leads", icon: UserPlus, href: "/leads" },
      { id: "sl-quotes", label: "Estimates", icon: FileText, href: "/quotes" },
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
      { id: "m-bills", label: "Bills & POs", icon: Wallet, href: "/bills", owns: ["/purchasing"] },
      { id: "m-price", label: "Price List", icon: Tags, href: "/price-list" },
      // Money admin — promoted out of Office (Alexa's open "under billing?" call, now answered).
      { id: "m-ma-h", label: "Money admin", icon: Calculator, header: true },
      { id: "ma-payroll", label: "Payroll", icon: Banknote, href: "/payroll" },
      { id: "ma-tax", label: "Tax Report", icon: Calculator, href: "/tax-report" },
      { id: "ma-analytics", label: "Analytics", icon: TrendingUp, href: "/analytics" },
      { id: "ma-recur", label: "Recurring", icon: Repeat, href: "/recurring" },
      { id: "ma-petty", label: "Petty Cash", icon: Coins, href: "/petty-cash" },
    ],
  },
  {
    key: "office",
    label: "Office",
    icon: Building2,
    href: "/compliance", // permits moved to Jobs; Office lands on Liabilities now
    children: [
      // Liabilities (Alexa's grouping). Insurance (e.g. workers' comp) + compliance Audits are
      // the next pages to build — flagged, not stubbed as dead links.
      { id: "o-liab-h", label: "Liabilities", icon: Scale, header: true },
      { id: "o-comply", label: "Compliance", icon: ShieldCheck, href: "/compliance" },
      { id: "o-insurance", label: "Insurance", icon: Umbrella, href: "/insurance" },
      { id: "o-safety", label: "Safety", icon: HardHat, href: "/safety" },
      { id: "o-audits", label: "Audits", icon: ClipboardCheck, href: "/audits" },
      // HR — Team leads: the crew roster with real lifecycle verbs (change role,
      // reset login, deactivate/reactivate, remove) lifted out of Settings into its
      // own page (settings doctrine: Settings keeps zero team UI). Office-only.
      { id: "o-hr-h", label: "HR", icon: UserCog, header: true },
      { id: "o-team", label: "Team", icon: Users, href: "/team", staffOnly: true },
      { id: "o-docs", label: "Employee Docs", icon: IdCard, href: "/employee-docs", staffOnly: true },
      { id: "o-forms", label: "Forms", icon: ClipboardList, href: "/forms" },
      { id: "o-resources", label: "Resources", icon: BookUser, href: "/resources" },
      { id: "o-handbook", label: "Handbook", icon: BookOpen, href: "/handbook" },
      // Stock — the money-admin cluster (Payroll/Tax/Analytics/Recurring/Petty cash) was promoted
      // up to the Money section; only Inventory (warehouse stock, not a dollar ledger) stays here.
      { id: "o-stock-h", label: "Stock", icon: Boxes, header: true, staffOnly: true },
      { id: "ma-stock", label: "Inventory", icon: Boxes, href: "/inventory", staffOnly: true },
      // Diagnostics. Settings is NO LONGER a link here (zero-duplication law): it lives
      // behind the avatar (the predictable phone-app door, cn-v326). Office no longer OWNS
      // /settings either — Settings is its own territory now, owned by no dock section, so
      // its OWN side-tab (settings-subnav) drives its clusters instead of Office's list
      // cluttering the settings page (cn-v331).
      { id: "o-diag-h", label: "Diagnostics", icon: ScrollText, header: true, staffOnly: true },
      { id: "o-activity", label: "Activity", icon: Activity, href: "/activity", staffOnly: true },
      { id: "o-bugs", label: "Bug Watch", icon: Bug, href: "/bugs", staffOnly: true },
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
    // Pulled out of Office to its own dock section — the calculators/utilities are a daily
    // field reach, so they get a one-tap home (everyone, not staff-only).
    key: "tools",
    label: "Tools",
    icon: Wrench,
    href: "/tools",
    children: [{ id: "tl-all", label: "Calculators & Tools", icon: Wrench, href: "/tools" }],
  },
];

/** Path part of an href — the bit before any ?query (shared by every dock renderer). */
export const basePath = (href: string) => href.split("?")[0];

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
      under(s.href) ||
      s.children.some((c) => (c.href ? under(basePath(c.href)) : false) || c.owns?.some(under)),
  );
}
