// The navigation graph that powers the mind-map navigator. Hubs with `children`
// drill into a mini-map; leaves (with `href`) open the screen. `countKey` maps a
// node to a live count badge (see the counts prop on MindMapNav).

export type TreeNode = {
  id: string;
  label: string;
  icon: string;
  href?: string;
  countKey?: string;
  children?: TreeNode[];
};

export type NavTree = {
  center: { label: string; icon: string; href?: string };
  nodes: TreeNode[];
};

export const NAV_TREE: NavTree = {
  center: { label: "Home", icon: "home", href: "/dashboard" },
  nodes: [
    {
      id: "myday",
      label: "My Day",
      icon: "sun",
      children: [
        { id: "md-today", label: "Today's jobs", icon: "checkbox", href: "/planner" },
        { id: "md-hours", label: "My hours", icon: "clock", href: "/timeclock" },
        { id: "md-tasks", label: "My tasks", icon: "listCheck", href: "/tasks" },
      ],
    },
    {
      id: "jobs",
      label: "Jobs",
      icon: "briefcase",
      countKey: "jobs",
      children: [
        { id: "j-all", label: "All jobs", icon: "list", href: "/jobs" },
        { id: "j-prog", label: "In progress", icon: "play", href: "/jobs?status=in_progress" },
        { id: "j-sched", label: "Scheduled", icon: "calendar", href: "/jobs?status=scheduled" },
        { id: "j-est", label: "Estimates", icon: "fileText", href: "/jobs?status=estimate" },
      ],
    },
    {
      id: "schedule",
      label: "Schedule",
      icon: "calendar",
      children: [
        { id: "s-board", label: "Board", icon: "layoutBoard", href: "/schedule" },
        { id: "s-cal", label: "Calendar", icon: "calendar", href: "/schedule?view=calendar" },
        { id: "s-appt", label: "Appointments", icon: "clipboardCheck", href: "/schedule?view=appointments" },
        { id: "s-map", label: "Map", icon: "map", href: "/schedule?view=map" },
      ],
    },
    {
      id: "customers",
      label: "Customers",
      icon: "users",
      countKey: "customers",
      children: [
        { id: "c-all", label: "All customers", icon: "users", href: "/crm" },
        { id: "c-inq", label: "Inquiries", icon: "mail", href: "/leads" },
        { id: "c-quotes", label: "Quotes", icon: "fileText", href: "/quotes", countKey: "quotes" },
      ],
    },
    {
      id: "money",
      label: "Money",
      icon: "receipt",
      countKey: "money",
      children: [
        { id: "m-inv", label: "Invoices", icon: "receipt", href: "/billing" },
        { id: "m-bills", label: "Bills & POs", icon: "wallet", href: "/bills" },
        { id: "m-price", label: "Price list", icon: "tags", href: "/price-list" },
        { id: "m-stock", label: "Inventory", icon: "boxes", href: "/inventory" },
        { id: "m-tax", label: "Tax report", icon: "calculator", href: "/tax-report" },
      ],
    },
    {
      id: "office",
      label: "Office",
      icon: "settings",
      children: [
        { id: "o-permits", label: "Permits", icon: "stamp", href: "/permits" },
        { id: "o-safety", label: "Safety", icon: "hardhat", href: "/safety" },
        { id: "o-handbook", label: "Handbook", icon: "bookOpen", href: "/handbook" },
        { id: "o-forms", label: "Forms", icon: "fileSpreadsheet", href: "/forms" },
        { id: "o-tools", label: "Tools", icon: "wrench", href: "/tools" },
        { id: "o-settings", label: "Settings", icon: "settings", href: "/settings" },
      ],
    },
    { id: "assistant", label: "Assistant", icon: "sparkles", href: "/assistant" },
    { id: "organize", label: "Organize", icon: "wand", href: "/organize" },
  ],
};
