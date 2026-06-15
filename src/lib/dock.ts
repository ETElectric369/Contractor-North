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
  Calendar,
  Play,
  FileText,
  Wallet,
  Tags,
  Boxes,
  Calculator,
  CalendarClock,
  Stamp,
  HardHat,
  ShieldCheck,
  ClipboardList,
  BookOpen,
  BookUser,
  IdCard,
  Coins,
  CreditCard,
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
}

// The dock mirrors Erik's sketch: six glass icons down the left, each blooming
// its line-items out over the page. Tasks drills into the three task buckets.
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
      {
        id: "h-tasks",
        label: "Tasks",
        icon: ListChecks,
        href: "/tasks",
        children: [
          { id: "t-ops", label: "Operations", icon: Wrench, href: "/tasks/operations" },
          { id: "t-sales", label: "Sales", icon: TrendingUp, href: "/tasks/sales" },
          { id: "t-office", label: "Office", icon: Building2, href: "/tasks/office" },
        ],
      },
    ],
  },
  {
    key: "time",
    label: "Time",
    icon: Clock,
    href: "/schedule",
    children: [
      { id: "tm-sched", label: "Schedule", icon: CalendarDays, href: "/schedule" },
      { id: "tm-cal", label: "Calendar", icon: Calendar, href: "/schedule?view=calendar" },
      { id: "tm-clock", label: "Timeclock", icon: Play, href: "/timeclock" },
      { id: "tm-cards", label: "Timecards", icon: CalendarClock, href: "/timecards", staffOnly: true },
    ],
  },
  {
    key: "jobs",
    label: "Jobs",
    icon: Briefcase,
    href: "/jobs",
    children: [
      { id: "j-all", label: "All jobs", icon: Briefcase, href: "/jobs" },
      { id: "j-prog", label: "In progress", icon: Play, href: "/jobs?status=in_progress" },
      { id: "j-est", label: "Estimates", icon: FileText, href: "/jobs?status=estimate" },
      { id: "j-cust", label: "Customers", icon: Users, href: "/crm" },
      { id: "j-inq", label: "Inquiries", icon: UserPlus, href: "/leads" },
    ],
  },
  {
    key: "money",
    label: "Money",
    icon: Receipt,
    href: "/billing",
    children: [
      { id: "m-inv", label: "Invoices", icon: Receipt, href: "/billing" },
      { id: "m-quotes", label: "Quotes", icon: FileText, href: "/quotes" },
      { id: "m-bills", label: "Bills & POs", icon: Wallet, href: "/bills" },
      { id: "m-price", label: "Price list", icon: Tags, href: "/price-list" },
      { id: "m-stock", label: "Inventory", icon: Boxes, href: "/inventory" },
      { id: "m-petty", label: "Petty cash", icon: Coins, href: "/petty-cash" },
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
      { id: "o-forms", label: "Forms", icon: ClipboardList, href: "/forms" },
      { id: "o-handbook", label: "Handbook", icon: BookOpen, href: "/handbook" },
      { id: "o-resources", label: "Resources", icon: BookUser, href: "/resources" },
      { id: "o-docs", label: "Employee docs", icon: IdCard, href: "/employee-docs", staffOnly: true },
      { id: "o-tools", label: "Tools", icon: Wrench, href: "/tools" },
    ],
  },
  {
    key: "settings",
    label: "Settings",
    icon: Settings,
    href: "/settings",
    children: [
      { id: "s-company", label: "Company", icon: Building2, href: "/settings?tab=company" },
      { id: "s-docs", label: "Documents", icon: FileText, href: "/settings?tab=documents" },
      { id: "s-team", label: "Team", icon: Users, href: "/settings?tab=team" },
      { id: "s-billing", label: "Billing", icon: CreditCard, href: "/settings?tab=plan" },
    ],
  },
];
