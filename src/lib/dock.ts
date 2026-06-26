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

// SEVEN flat sections — every title is ONE CLICK to its main page; its pages live in the
// left sidebar (desktop) or the top strip (mobile). No bloom, no "More" wrapper: Office and
// Money admin are their own titles so nothing is buried. Order follows the day.
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
      { id: "j-prog", label: "In progress", icon: Play, href: "/jobs?status=in_progress" },
      { id: "j-sched", label: "Scheduled", icon: CalendarDays, href: "/jobs?status=scheduled" },
      { id: "j-all", label: "All jobs", icon: Briefcase, href: "/jobs" },
      // Cross-job views (office/dispatch) — the same records live on each job's tabs too.
      { id: "j-wo", label: "Work orders", icon: Wrench, href: "/work-orders", staffOnly: true },
      { id: "j-mat", label: "Materials", icon: Boxes, href: "/materials", staffOnly: true },
      { id: "j-co", label: "Change orders", icon: FileText, href: "/change-orders", staffOnly: true },
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
    href: "/crm",
    staffOnly: true,
    children: [
      { id: "sl-leads", label: "Leads", icon: UserPlus, href: "/leads" },
      { id: "sl-cust", label: "Customers", icon: Users, href: "/crm" },
      { id: "sl-quotes", label: "Quotes", icon: FileText, href: "/quotes" },
    ],
  },
  {
    key: "money",
    label: "Money",
    icon: Receipt,
    href: "/billing",
    staffOnly: true,
    children: [
      { id: "m-inv", label: "Invoices", icon: Receipt, href: "/billing" },
      { id: "m-pay", label: "Payments", icon: CreditCard, href: "/payments" },
      { id: "m-bills", label: "Bills & POs", icon: Wallet, href: "/bills" },
      { id: "m-price", label: "Price list", icon: Tags, href: "/price-list" },
    ],
  },
  {
    key: "office",
    label: "Office",
    icon: Building2,
    href: "/permits",
    children: [
      { id: "o-permits", label: "Permits", icon: Stamp, href: "/permits" },
      { id: "o-comply", label: "Compliance", icon: ShieldCheck, href: "/compliance" },
      { id: "o-safety", label: "Safety", icon: HardHat, href: "/safety" },
      { id: "o-handbook", label: "Handbook", icon: BookOpen, href: "/handbook" },
      { id: "o-resources", label: "Resources", icon: BookUser, href: "/resources" },
      { id: "o-forms", label: "Forms", icon: ClipboardList, href: "/forms" },
      { id: "o-tools", label: "Tools", icon: Wrench, href: "/tools" },
      { id: "o-docs", label: "Employee docs", icon: IdCard, href: "/employee-docs", staffOnly: true },
      { id: "o-settings", label: "Settings", icon: Settings, href: "/settings" },
      { id: "o-audit", label: "Activity audit", icon: ScrollText, href: "/audit", staffOnly: true },
      // (Plans & LiDAR is a ComingSoon stub — kept off the dock until the real upload ships.)
      // Money admin lives inside Office now — a labeled sub-group (staff only).
      { id: "o-ma-header", label: "Money admin", icon: Calculator, header: true, staffOnly: true },
      { id: "ma-stock", label: "Inventory", icon: Boxes, href: "/inventory", staffOnly: true },
      { id: "ma-petty", label: "Petty cash", icon: Coins, href: "/petty-cash", staffOnly: true },
      { id: "ma-recur", label: "Recurring", icon: Repeat, href: "/recurring", staffOnly: true },
      { id: "ma-tax", label: "Tax report", icon: Calculator, href: "/tax-report", staffOnly: true },
      { id: "ma-payroll", label: "Payroll", icon: Banknote, href: "/payroll", staffOnly: true },
      { id: "ma-analytics", label: "Analytics", icon: TrendingUp, href: "/analytics", staffOnly: true },
    ],
  },
];
