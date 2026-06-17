import {
  Home,
  Clock,
  Briefcase,
  Receipt,
  Building2,
  Settings,
  Sun,
  Sparkles,
  Wand2,
  ListChecks,
  Wrench,
  TrendingUp,
  Users,
  UserPlus,
  CalendarDays,
  Play,
  FileText,
  Wallet,
  Tags,
  Boxes,
  Calculator,
  CalendarClock,
  Repeat,
  Stamp,
  HardHat,
  ShieldCheck,
  ClipboardList,
  BookOpen,
  BookUser,
  IdCard,
  Coins,
  CreditCard,
  Bell,
  Plug,
  type LucideIcon,
} from "lucide-react";

/** A node in a dock section's bloom. A leaf has an href; a hub has children
 *  (it drills in place, like Tasks → Operations/Sales/Office). */
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
 *  goes; `children` bloom out from the icon. */
export interface DockSection {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
  children: DockNode[];
  /** Whole section hidden from techs (office/admin/owner only). */
  staffOnly?: boolean;
}

// The dock follows the conversion path top-to-bottom: Sales (inquiries → quote/
// estimate) → Jobs → Money (invoice → payment). Each icon blooms its line-items.
export const DOCK: DockSection[] = [
  {
    key: "home",
    label: "Home",
    icon: Home,
    href: "/planner",
    children: [
      { id: "h-day", label: "My day", icon: Sun, href: "/planner" },
      { id: "h-assist", label: "Assistant", icon: Sparkles, href: "/assistant" },
      { id: "h-org", label: "Organize my", icon: Wand2, href: "/organize" },
    ],
  },
  {
    key: "tasks",
    label: "Tasks",
    icon: ListChecks,
    href: "/tasks",
    children: [
      { id: "t-ops", label: "Operations", icon: Wrench, href: "/tasks/operations" },
      { id: "t-sales", label: "Sales", icon: TrendingUp, href: "/tasks/sales" },
      { id: "t-office", label: "Office", icon: Building2, href: "/tasks/office" },
    ],
  },
  {
    key: "time",
    label: "Time",
    icon: Clock,
    href: "/schedule",
    children: [
      { id: "tm-sched", label: "Scheduler", icon: CalendarDays, href: "/schedule" },
      { id: "tm-clock", label: "Timeclock", icon: Play, href: "/timeclock" },
      { id: "tm-cards", label: "Timecards", icon: CalendarClock, href: "/timecards", staffOnly: true },
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
      { id: "sl-est", label: "Estimates", icon: FileText, href: "/quotes?type=estimate" },
      { id: "sl-quotes", label: "Quotes", icon: FileText, href: "/quotes?type=quote" },
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
      { id: "m-analytics", label: "Analytics", icon: TrendingUp, href: "/analytics", staffOnly: true },
    ],
  },
  {
    key: "office",
    label: "Office",
    icon: Building2,
    href: "/permits",
    children: [
      { id: "o-permits", label: "Permits", icon: Stamp, href: "/permits" },
      { id: "o-safety", label: "Safety", icon: HardHat, href: "/safety" },
      { id: "o-comply", label: "Compliance", icon: ShieldCheck, href: "/compliance" },
      { id: "o-docs", label: "Employee docs", icon: IdCard, href: "/employee-docs", staffOnly: true },
    ],
  },
  {
    key: "tools",
    label: "Tools",
    icon: Wrench,
    href: "/tools",
    children: [
      { id: "tl-calc", label: "Calculators", icon: Wrench, href: "/tools" },
      { id: "tl-forms", label: "Forms", icon: ClipboardList, href: "/forms" },
      { id: "tl-resources", label: "Resources", icon: BookUser, href: "/resources" },
      { id: "tl-handbook", label: "Handbook", icon: BookOpen, href: "/handbook" },
    ],
  },
  {
    key: "settings",
    label: "Settings",
    icon: Settings,
    href: "/settings",
    children: [
      { id: "s-company", label: "Company", icon: Building2, href: "/settings?tab=company" },
      { id: "s-financial", label: "Financial", icon: Calculator, href: "/settings?tab=financial" },
      { id: "s-docs", label: "Documents", icon: FileText, href: "/settings?tab=documents" },
      { id: "s-sched", label: "Scheduling", icon: CalendarDays, href: "/settings?tab=scheduling" },
      { id: "s-pay", label: "Payments", icon: CreditCard, href: "/settings?tab=payments" },
      { id: "s-auto", label: "Automation", icon: Sparkles, href: "/settings?tab=automation" },
      { id: "s-integ", label: "Integrations", icon: Plug, href: "/settings?tab=integrations" },
      { id: "s-team", label: "Team", icon: Users, href: "/settings?tab=team" },
      { id: "s-notif", label: "Notifications", icon: Bell, href: "/settings?tab=notifications" },
      { id: "s-plan", label: "Plan", icon: Wallet, href: "/settings?tab=plan" },
      { id: "s-profile", label: "Profile", icon: IdCard, href: "/settings?tab=profile" },
    ],
  },
];
