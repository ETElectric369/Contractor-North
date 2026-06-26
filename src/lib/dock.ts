import {
  Home,
  Sun,
  ListChecks,
  Wand2,
  Briefcase,
  Play,
  CalendarDays,
  CalendarClock,
  MapPin,
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
 *  goes; `children` bloom out from the icon as the sub-nav. */
export interface DockSection {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
  children: DockNode[];
  /** Whole section hidden from techs (office/admin/owner only). */
  staffOnly?: boolean;
}

// SEVEN titles, each with a sub-nav that blooms out. Order follows the day:
// Home → Jobs → Schedule → Sales → Money → Time → Office. Everything that used to
// be its own dock icon (Tasks, Tools, Settings) now lives under one of these.
export const DOCK: DockSection[] = [
  {
    key: "home",
    label: "Home",
    icon: Home,
    href: "/planner",
    children: [
      { id: "h-day", label: "My day", icon: Sun, href: "/planner" },
      { id: "h-tasks", label: "Tasks", icon: ListChecks, href: "/tasks" },
      { id: "h-org", label: "Organize my", icon: Wand2, href: "/organize" },
      // (Assistant is the topbar "Talk" button, not a duplicate dock entry.)
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
    key: "schedule",
    label: "Schedule",
    icon: CalendarDays,
    href: "/schedule",
    staffOnly: true,
    children: [
      { id: "sc-cal", label: "Calendar", icon: CalendarDays, href: "/schedule" },
      { id: "sc-appt", label: "Appointments", icon: CalendarClock, href: "/schedule?view=appointments" },
      { id: "sc-map", label: "Map", icon: MapPin, href: "/schedule?view=map" },
    ],
  },
  {
    key: "sales",
    label: "Sales",
    icon: TrendingUp,
    href: "/crm",
    staffOnly: true,
    children: [
      { id: "sl-inq", label: "Inquiries", icon: UserPlus, href: "/leads" },
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
      { id: "m-stock", label: "Inventory", icon: Boxes, href: "/inventory" },
      { id: "m-petty", label: "Petty cash", icon: Coins, href: "/petty-cash" },
      { id: "m-recur", label: "Recurring", icon: Repeat, href: "/recurring" },
      { id: "m-tax", label: "Tax report", icon: Calculator, href: "/tax-report" },
      { id: "m-payroll", label: "Payroll", icon: Banknote, href: "/payroll", staffOnly: true },
      { id: "m-analytics", label: "Analytics", icon: TrendingUp, href: "/analytics", staffOnly: true },
    ],
  },
  {
    key: "time",
    label: "Time",
    icon: Clock,
    href: "/timeclock", // everyone can clock in; timecards are office-only
    children: [
      { id: "tm-clock", label: "Timeclock", icon: Play, href: "/timeclock" },
      { id: "tm-cards", label: "Timecards", icon: CalendarClock, href: "/timecards", staffOnly: true },
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
      { id: "o-plans", label: "Plans & LiDAR", icon: ScanLine, href: "/plans" },
    ],
  },
];
