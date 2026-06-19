import {
  LayoutDashboard,
  Sun,
  ListTodo,
  Sparkles,
  UserPlus,
  Users,
  FileText,
  Briefcase,
  CalendarDays,
  Clock,
  CalendarClock,
  Receipt,
  Wallet,
  Tags,
  Boxes,
  Coins,
  Repeat,
  Calculator,
  TrendingUp,
  Banknote,
  Stamp,
  Wand2,
  Wrench,
  ShieldCheck,
  HardHat,
  IdCard,
  BookUser,
  BookOpen,
  FileSpreadsheet,
  ScanLine,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Marks modules that are scaffolded but not yet built out. */
  comingSoon?: boolean;
  /** Hidden from techs (office/admin/owner only). */
  staffOnly?: boolean;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

// Condensed, hub-oriented navigation. The job is the spine: work orders,
// materials and change orders live on the job (via its tabs), not as their own
// nav items. Scheduler, calendar, appointments and map are merged into one
// "Schedule" hub. Money and Office are collapsed by default in the sidebar.
export const NAV: NavSection[] = [
  {
    title: "Workspace",
    items: [
      { label: "Dashboard", href: "/planner", icon: LayoutDashboard },
      { label: "My Day", href: "/planner", icon: Sun },
      { label: "Jobs", href: "/jobs", icon: Briefcase },
      { label: "Schedule", href: "/schedule", icon: CalendarDays, staffOnly: true },
      { label: "Assistant", href: "/assistant", icon: Sparkles },
      { label: "Organize My…", href: "/organize", icon: Wand2 },
      { label: "Tasks", href: "/tasks", icon: ListTodo },
    ],
  },
  {
    title: "Sales",
    items: [
      { label: "Inquiries", href: "/leads", icon: UserPlus },
      { label: "Customers", href: "/crm", icon: Users },
      { label: "Quotes", href: "/quotes", icon: FileText },
    ],
  },
  {
    title: "Money",
    items: [
      { label: "Invoices", href: "/billing", icon: Receipt },
      { label: "Bills & POs", href: "/bills", icon: Wallet },
      { label: "Price List", href: "/price-list", icon: Tags },
      { label: "Inventory", href: "/inventory", icon: Boxes },
      { label: "Petty Cash", href: "/petty-cash", icon: Coins },
      { label: "Recurring", href: "/recurring", icon: Repeat, staffOnly: true },
      { label: "Tax Report", href: "/tax-report", icon: Calculator },
      { label: "Payroll", href: "/payroll", icon: Banknote, staffOnly: true },
      { label: "Analytics", href: "/analytics", icon: TrendingUp, staffOnly: true },
    ],
  },
  {
    title: "Office",
    items: [
      { label: "Permits", href: "/permits", icon: Stamp },
      { label: "Compliance", href: "/compliance", icon: ShieldCheck },
      { label: "Safety / OSHA", href: "/safety", icon: HardHat },
      { label: "Employee Docs", href: "/employee-docs", icon: IdCard, staffOnly: true },
      { label: "Handbook", href: "/handbook", icon: BookOpen },
      { label: "Resources", href: "/resources", icon: BookUser },
      { label: "Forms", href: "/forms", icon: FileSpreadsheet },
      { label: "Timeclock", href: "/timeclock", icon: Clock },
      { label: "Timecards", href: "/timecards", icon: CalendarClock, staffOnly: true },
      { label: "Tools", href: "/tools", icon: Wrench },
      { label: "Settings", href: "/settings", icon: Settings },
      { label: "Plans & LiDAR", href: "/plans", icon: ScanLine, comingSoon: true },
    ],
  },
];
