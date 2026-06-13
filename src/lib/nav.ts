import {
  LayoutDashboard,
  Sun,
  Activity,
  ListTodo,
  Sparkles,
  UserPlus,
  Users,
  FileText,
  Briefcase,
  CalendarDays,
  CalendarClock,
  CalendarCheck,
  MapPin,
  ClipboardList,
  Clock,
  ListChecks,
  Receipt,
  Wallet,
  Tags,
  Boxes,
  Coins,
  GitPullRequestArrow,
  Calculator,
  Stamp,
  TrendingUp,
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

export const NAV: NavSection[] = [
  {
    title: "Overview",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { label: "My Day", href: "/planner", icon: Sun },
      { label: "Tasks", href: "/tasks", icon: ListTodo },
      { label: "Activity", href: "/activity", icon: Activity, staffOnly: true },
      { label: "Assistant", href: "/assistant", icon: Sparkles },
      { label: "Organize My…", href: "/organize", icon: Wand2 },
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
    title: "Operations",
    items: [
      { label: "Jobs", href: "/jobs", icon: Briefcase },
      { label: "Scheduler", href: "/schedule", icon: CalendarDays },
      { label: "Calendar", href: "/calendar", icon: CalendarClock },
      { label: "Appointments", href: "/appointments", icon: CalendarCheck },
      { label: "Map", href: "/map", icon: MapPin },
      { label: "Work Orders", href: "/work-orders", icon: ClipboardList },
      { label: "Timeclock", href: "/timeclock", icon: Clock },
      { label: "Material Lists", href: "/materials", icon: ListChecks },
    ],
  },
  {
    title: "Money",
    items: [
      { label: "Invoices", href: "/billing", icon: Receipt },
      { label: "Bills & Purchasing", href: "/bills", icon: Wallet },
      { label: "Price List", href: "/price-list", icon: Tags },
      { label: "Inventory", href: "/inventory", icon: Boxes },
      { label: "Petty Cash", href: "/petty-cash", icon: Coins },
      { label: "Change Orders", href: "/change-orders", icon: GitPullRequestArrow },
      { label: "Tax Report", href: "/tax-report", icon: Calculator },
      { label: "Analytics", href: "/analytics", icon: TrendingUp, staffOnly: true },
      { label: "Timecards", href: "/timecards", icon: CalendarClock, staffOnly: true },
    ],
  },
  {
    title: "Compliance",
    items: [
      { label: "Permits", href: "/permits", icon: Stamp },
      { label: "Compliance", href: "/compliance", icon: ShieldCheck },
      { label: "Safety / OSHA", href: "/safety", icon: HardHat },
      { label: "Employee Docs", href: "/employee-docs", icon: IdCard, staffOnly: true },
      { label: "Handbook", href: "/handbook", icon: BookOpen },
      { label: "Resources", href: "/resources", icon: BookUser },
      { label: "Forms", href: "/forms", icon: FileSpreadsheet },
    ],
  },
  {
    title: "System",
    items: [
      { label: "Tools", href: "/tools", icon: Wrench },
      { label: "Settings", href: "/settings", icon: Settings },
      { label: "Plans & LiDAR", href: "/plans", icon: ScanLine, comingSoon: true },
    ],
  },
];
