import {
  Sun,
  ListChecks,
  Wand2,
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
      // The job lifecycle, in order (Alexa: Estimate → Scheduled → In progress → On hold → Completed).
      { id: "j-all", label: "All jobs", icon: Briefcase, href: "/jobs" },
      { id: "j-est", label: "Estimate", icon: FileText, href: "/jobs?status=estimate" },
      { id: "j-sched", label: "Scheduled", icon: CalendarDays, href: "/jobs?status=scheduled" },
      { id: "j-prog", label: "In progress", icon: Play, href: "/jobs?status=in_progress" },
      { id: "j-hold", label: "On hold", icon: Pause, href: "/jobs?status=on_hold" },
      { id: "j-done", label: "Completed", icon: CheckCircle2, href: "/jobs?status=complete" },
      // Permits live under active jobs now (moved out of Office per Alexa).
      { id: "j-permits", label: "Permits", icon: Stamp, href: "/permits", staffOnly: true },
      // Cross-job views (office/dispatch) — the same records live on each job's tabs too.
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
      { id: "m-bills", label: "Bills & POs", icon: Wallet, href: "/bills" },
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
