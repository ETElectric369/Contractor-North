import {
  Sun,
  ListChecks,
  Wand2,
  Ban,
  Briefcase,
  Layers,
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
  Settings,
  ScrollText,
  Activity,
  Bug,
  Scale,
  UserCog,
  Pause,
  CheckCircle2,
  Umbrella,
  ClipboardCheck,
  ScanLine,
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
  estimate: FileText,
  scheduled: CalendarDays,
  in_progress: Play,
  on_hold: Pause,
  complete: CheckCircle2,
  invoiced: Receipt,
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
      { id: "t-day", label: "My day", icon: Sun, href: "/planner" },
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
      { id: "j-all", label: "All jobs", icon: Briefcase, href: "/jobs" },
      // The job lifecycle, GENERATED from the canonical JOB_STATUSES spine (its order IS the
      // lifecycle) so this list can't drift from the enum again — it had: missing invoiced +
      // cancelled, and a hand-written "Completed" vs canonical "complete". Guarded by dock.test.ts.
      ...JOB_STATUSES.map((s) => ({
        id: `j-${s}`,
        label: capFirst(jobStatusLabel(s)),
        icon: JOB_STATUS_ICONS[s],
        href: `/jobs?status=${s}`,
      })),
      // Cross-job views (office/dispatch) — the same records live on each job's tabs too.
      // Permits live under active jobs now (moved out of Office per Alexa).
      { id: "j-across-h", label: "Across all jobs", icon: Layers, header: true, staffOnly: true },
      { id: "j-permits", label: "Permits", icon: Stamp, href: "/permits", staffOnly: true },
      { id: "j-wo", label: "Work orders", icon: Wrench, href: "/work-orders", staffOnly: true },
      { id: "j-mat", label: "Materials", icon: Boxes, href: "/materials", staffOnly: true },
      { id: "j-co", label: "Change orders", icon: FileText, href: "/change-orders", staffOnly: true },
      // Plans & LiDAR (plan markup / scans → take-off → work order) — was an orphan route with
      // zero inbound links; given a home under Jobs where take-offs feed the rest of the lifecycle.
      { id: "j-plans", label: "Plans & LiDAR", icon: ScanLine, href: "/plans", staffOnly: true },
    ],
  },
  {
    key: "clock",
    label: "Clock",
    icon: Clock,
    href: "/timeclock", // everyone can clock in; timecards + schedule are office-only
    children: [
      { id: "ck-clock", label: "Timeclock", icon: Play, href: "/timeclock" },
      { id: "ck-cards", label: "Timecards", icon: CalendarClock, href: "/timecards", staffOnly: true },
      { id: "ck-sched", label: "Schedule", icon: CalendarDays, href: "/schedule", staffOnly: true },
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
      { id: "m-pay", label: "Payments", icon: CreditCard, href: "/payments" },
      { id: "m-bills", label: "Bills & POs", icon: Wallet, href: "/bills", owns: ["/purchasing"] },
      { id: "m-price", label: "Price list", icon: Tags, href: "/price-list" },
      // Money admin — promoted out of Office (Alexa's open "under billing?" call, now answered).
      { id: "m-ma-h", label: "Money admin", icon: Calculator, header: true },
      { id: "ma-payroll", label: "Payroll", icon: Banknote, href: "/payroll" },
      { id: "ma-tax", label: "Tax report", icon: Calculator, href: "/tax-report" },
      { id: "ma-analytics", label: "Analytics", icon: TrendingUp, href: "/analytics" },
      { id: "ma-recur", label: "Recurring", icon: Repeat, href: "/recurring" },
      { id: "ma-petty", label: "Petty cash", icon: Coins, href: "/petty-cash" },
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
      // HR
      { id: "o-hr-h", label: "HR", icon: UserCog, header: true },
      { id: "o-docs", label: "Employee docs", icon: IdCard, href: "/employee-docs", staffOnly: true },
      { id: "o-forms", label: "Forms", icon: ClipboardList, href: "/forms" },
      { id: "o-resources", label: "Resources", icon: BookUser, href: "/resources" },
      { id: "o-handbook", label: "Handbook", icon: BookOpen, href: "/handbook" },
      // Stock — the money-admin cluster (Payroll/Tax/Analytics/Recurring/Petty cash) was promoted
      // up to the Money section; only Inventory (warehouse stock, not a dollar ledger) stays here.
      { id: "o-stock-h", label: "Stock", icon: Boxes, header: true, staffOnly: true },
      { id: "ma-stock", label: "Inventory", icon: Boxes, href: "/inventory", staffOnly: true },
      // Diagnostics
      { id: "o-diag-h", label: "Diagnostics", icon: ScrollText, header: true, staffOnly: true },
      { id: "o-activity", label: "Activity", icon: Activity, href: "/activity", staffOnly: true },
      { id: "o-bugs", label: "Bug watch", icon: Bug, href: "/bugs", staffOnly: true },
      { id: "o-audit", label: "Activity audit", icon: ScrollText, href: "/audit", staffOnly: true },
      // General — Settings sits at the very bottom of the Office list (admin config, last reach).
      { id: "o-gen-h", label: "General", icon: Building2, header: true },
      { id: "o-settings", label: "Settings", icon: Settings, href: "/settings" },
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
    children: [{ id: "c-all", label: "All contacts", icon: Users, href: "/crm" }],
  },
  {
    // Pulled out of Office to its own dock section — the calculators/utilities are a daily
    // field reach, so they get a one-tap home (everyone, not staff-only).
    key: "tools",
    label: "Tools",
    icon: Wrench,
    href: "/tools",
    children: [{ id: "tl-all", label: "Calculators & tools", icon: Wrench, href: "/tools" }],
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
 * /work-orders/[id], /forms/[id]…), or matches a child's `owns` alias prefixes
 * (/purchasing/[id] belongs to Money's Bills & POs).
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
