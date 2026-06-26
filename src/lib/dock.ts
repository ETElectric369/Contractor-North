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
  ScanLine,
  Menu,
  type LucideIcon,
} from "lucide-react";

/** A node in a dock section's bloom. A leaf has an href; a hub has children. */
export interface DockNode {
  id: string;
  label: string;
  icon: LucideIcon;
  href?: string;
  children?: DockNode[];
  /** Hidden from techs (office/admin/owner only). */
  staffOnly?: boolean;
}

/** A top-level dock icon. `href` is where a plain click on the section center
 *  goes; `children` are its sub-pages (shown as the top-of-page sub-nav and the
 *  bloom). */
export interface DockSection {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
  children: DockNode[];
  /** Whole section hidden from techs (office/admin/owner only). */
  staffOnly?: boolean;
}

// SIX titles built around a field day — most are one-tap DESTINATIONS (tapping the title
// lands you there; the top-of-page sub-nav shows its siblings). Schedule rides WITH Clock
// (time + calendar together); Sales is its own dock tile; "More" is the rarely-from-the-
// truck drawer (money admin + office admin), grouped. Create lives on the center "+".
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
    key: "more",
    label: "More",
    icon: Menu,
    href: "/permits", // desktop click fallback; on mobile the title opens the More drawer
    children: [
      // Hubs (no href of their own → the bloom/drawer drills into them; their children
      // carry the hrefs and drive the top-of-page sub-nav for those pages).
      {
        id: "more-moneyadmin",
        label: "Money admin",
        icon: Calculator,
        staffOnly: true,
        children: [
          { id: "ma-stock", label: "Inventory", icon: Boxes, href: "/inventory" },
          { id: "ma-petty", label: "Petty cash", icon: Coins, href: "/petty-cash" },
          { id: "ma-recur", label: "Recurring", icon: Repeat, href: "/recurring" },
          { id: "ma-tax", label: "Tax report", icon: Calculator, href: "/tax-report" },
          { id: "ma-payroll", label: "Payroll", icon: Banknote, href: "/payroll" },
          { id: "ma-analytics", label: "Analytics", icon: TrendingUp, href: "/analytics" },
        ],
      },
      {
        id: "more-office",
        label: "Office",
        icon: Building2,
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
          { id: "o-plans", label: "Plans & LiDAR", icon: ScanLine, href: "/plans" },
        ],
      },
    ],
  },
];
