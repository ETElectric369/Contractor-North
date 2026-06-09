import {
  LayoutDashboard,
  Users,
  UserPlus,
  FileText,
  CalendarDays,
  CalendarClock,
  MapPin,
  Briefcase,
  ClipboardList,
  Clock,
  Boxes,
  Tags,
  Receipt,
  ListChecks,
  TrendingUp,
  Wrench,
  Building2,
  Wallet,
  FileSpreadsheet,
  GitPullRequestArrow,
  ScanLine,
  Stamp,
  BookUser,
  Calculator,
  ShieldCheck,
  Coins,
  IdCard,
  HardHat,
  Sparkles,
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
      { label: "Assistant", href: "/assistant", icon: Sparkles },
    ],
  },
  {
    title: "Tasks",
    items: [
      { label: "Sales", href: "/tasks/sales", icon: TrendingUp },
      { label: "Operations", href: "/tasks/operations", icon: Wrench },
      { label: "Office", href: "/tasks/office", icon: Building2 },
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
      { label: "Scheduler", href: "/schedule", icon: CalendarDays },
      { label: "Map", href: "/map", icon: MapPin },
      { label: "Jobs", href: "/jobs", icon: Briefcase },
      { label: "Work Orders", href: "/work-orders", icon: ClipboardList },
      { label: "Timeclock", href: "/timeclock", icon: Clock },
      { label: "Timecards", href: "/timecards", icon: CalendarClock, staffOnly: true },
      { label: "Material Lists", href: "/materials", icon: ListChecks },
    ],
  },
  {
    title: "Office",
    items: [
      { label: "Bills & Purchasing", href: "/bills", icon: Wallet },
      { label: "Price List", href: "/price-list", icon: Tags },
      { label: "Inventory", href: "/inventory", icon: Boxes },
      { label: "Billing", href: "/billing", icon: Receipt },
      { label: "Tax Report", href: "/tax-report", icon: Calculator },
      { label: "Petty Cash", href: "/petty-cash", icon: Coins },
      { label: "Change Orders", href: "/change-orders", icon: GitPullRequestArrow },
      { label: "Permits", href: "/permits", icon: Stamp },
      { label: "Compliance", href: "/compliance", icon: ShieldCheck },
      { label: "Employee Docs", href: "/employee-docs", icon: IdCard, staffOnly: true },
      { label: "Safety / OSHA", href: "/safety", icon: HardHat },
      { label: "Resources", href: "/resources", icon: BookUser },
      { label: "Forms", href: "/forms", icon: FileSpreadsheet },
      { label: "Plans & LiDAR", href: "/plans", icon: ScanLine, comingSoon: true },
    ],
  },
  {
    title: "System",
    items: [{ label: "Settings", href: "/settings", icon: Settings }],
  },
];
