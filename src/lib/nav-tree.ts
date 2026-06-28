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
  /** Action node: run a server action (e.g. a conversion), then navigate to
   *  hrefPrefix + the returned id. Lets the map *do* things, not just go places. */
  run?: () => Promise<{ ok: boolean; id?: string; error?: string }>;
  hrefPrefix?: string;
  /** Serializable one-click action — runs this registry action via executeAction,
   *  then navigates to `href` (if set) or refreshes. Unlike `run`, a descriptor
   *  CAN be built in a server component (functions can't cross to the client bloom). */
  action?: { name: string; input?: Record<string, unknown> };
  /** Hide from non-staff viewers (financial verbs). */
  staffOnly?: boolean;
};

export type NavTree = {
  center: { label: string; icon: string; href?: string };
  nodes: TreeNode[];
};

export const NAV_TREE: NavTree = {
  center: { label: "Home", icon: "home", href: "/planner" },
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
        { id: "s-cal", label: "Calendar", icon: "calendar", href: "/schedule" },
        { id: "s-appt", label: "Appointments", icon: "clipboardCheck", href: "/schedule?view=appointments" },
        { id: "s-map", label: "Map", icon: "map", href: "/schedule?view=map" },
      ],
    },
    {
      id: "customers",
      label: "Contacts",
      icon: "users",
      countKey: "customers",
      children: [
        { id: "c-all", label: "All contacts", icon: "users", href: "/crm" },
        { id: "c-inq", label: "Leads", icon: "mail", href: "/leads" },
        { id: "c-quotes", label: "Estimates", icon: "fileText", href: "/quotes", countKey: "quotes" },
      ],
    },
    {
      id: "money",
      label: "Invoices",
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
    { id: "organize", label: "Organize", icon: "wand", href: "/organize" },
  ],
};

/** An invoice's relationships as a mind-map. */
export function invoiceSectionTree(
  invoiceId: string,
  label: string,
  rel: { customerId?: string | null; quoteId?: string | null; jobId?: string | null },
): NavTree {
  const nodes: TreeNode[] = [{ id: "i-self", label: "This invoice", icon: "receipt", href: `/billing/${invoiceId}` }];
  if (rel.customerId) nodes.push({ id: "i-cust", label: "Customer", icon: "users", href: `/crm/${rel.customerId}` });
  if (rel.jobId) nodes.push({ id: "i-job", label: "Job", icon: "briefcase", href: `/jobs/${rel.jobId}` });
  if (rel.quoteId) nodes.push({ id: "i-quote", label: "Source estimate", icon: "fileText", href: `/quotes/${rel.quoteId}` });
  nodes.push({ id: "i-print", label: "Print / PDF", icon: "fileSpreadsheet", href: `/print/invoice/${invoiceId}` });
  nodes.push({ id: "i-all", label: "All invoices", icon: "list", href: "/billing" });
  return { center: { label, icon: "receipt" }, nodes };
}

/** A work order's relationships as a mind-map. */
export function workOrderSectionTree(
  woId: string,
  label: string,
  rel: { jobId?: string | null; customerId?: string | null; quoteId?: string | null },
): NavTree {
  const nodes: TreeNode[] = [{ id: "w-self", label: "This work order", icon: "clipboardCheck", href: `/work-orders/${woId}` }];
  if (rel.jobId) nodes.push({ id: "w-job", label: "Job", icon: "briefcase", href: `/jobs/${rel.jobId}` });
  if (rel.customerId) nodes.push({ id: "w-cust", label: "Customer", icon: "users", href: `/crm/${rel.customerId}` });
  if (rel.quoteId) nodes.push({ id: "w-quote", label: "Source estimate", icon: "fileText", href: `/quotes/${rel.quoteId}` });
  nodes.push({ id: "w-print", label: "Print / PDF", icon: "fileSpreadsheet", href: `/print/work-order/${woId}` });
  nodes.push({ id: "w-all", label: "All work orders", icon: "list", href: "/work-orders" });
  return { center: { label, icon: "clipboardCheck" }, nodes };
}

/** A material list's relationships as a mind-map. */
export function materialListSectionTree(listId: string, label: string, rel: { jobId?: string | null; quoteId?: string | null }): NavTree {
  const nodes: TreeNode[] = [{ id: "ml-self", label: "This list", icon: "boxes", href: `/materials/${listId}` }];
  if (rel.jobId) nodes.push({ id: "ml-job", label: "Job", icon: "briefcase", href: `/jobs/${rel.jobId}` });
  if (rel.quoteId) nodes.push({ id: "ml-quote", label: "Source estimate", icon: "fileText", href: `/quotes/${rel.quoteId}` });
  nodes.push({ id: "ml-all", label: "All material lists", icon: "list", href: "/materials" });
  return { center: { label, icon: "boxes" }, nodes };
}

/** A purchase order's relationships as a mind-map. */
export function purchaseOrderSectionTree(
  poId: string,
  label: string,
  rel: { jobId?: string | null },
): NavTree {
  const nodes: TreeNode[] = [{ id: "po-self", label: "This PO", icon: "wallet", href: `/purchasing/${poId}` }];
  if (rel.jobId) nodes.push({ id: "po-job", label: "Job", icon: "briefcase", href: `/jobs/${rel.jobId}` });
  nodes.push({ id: "po-all", label: "All bills & POs", icon: "list", href: "/bills" });
  return { center: { label, icon: "wallet" }, nodes };
}

/** A customer's actions as a mind-map: each verb lands on the tab whose "New …"
 *  button creates the record (the customer is already in scope there). The plain
 *  tab list is right there in the page's tab bar, so the menu leads with verbs. */
export function customerSectionTree(custId: string, custLabel: string): NavTree {
  const tab = (t: string) => `/crm/${custId}?tab=${t}`;
  return {
    center: { label: custLabel, icon: "users" },
    nodes: [
      { id: "c-newjob", label: "New job", icon: "briefcase", href: tab("jobs") },
      { id: "c-newquote", label: "New estimate", icon: "fileText", href: tab("quotes"), staffOnly: true },
      { id: "c-newinv", label: "New invoice", icon: "receipt", href: tab("invoices"), staffOnly: true },
    ],
  };
}

/** A job's hub actions + relationships as a mind-map. Verbs first (DO things — one
 *  real one-click "Clock in here", plus deep-links to the tab whose form does the
 *  rest), then the related records. The financial verbs are staff-gated. */
export function jobSectionTree(
  jobId: string,
  label: string,
  rel: { customerId?: string | null; jobCode?: string | null },
): NavTree {
  const tab = (t: string) => `/jobs/${jobId}?tab=${t}`;
  const nodes: TreeNode[] = [
    {
      id: "jb-clockin",
      label: "Clock in here",
      icon: "play",
      action: { name: "time.clockIn", input: { job_id: jobId, job_code: rel.jobCode ?? null } },
      href: "/timeclock",
    },
    { id: "jb-cost", label: "Add a cost", icon: "wallet", href: tab("costs"), staffOnly: true },
    { id: "jb-time", label: "Log time", icon: "clock", href: tab("time") },
    { id: "jb-quote", label: "New estimate", icon: "fileText", href: tab("quotes"), staffOnly: true },
    { id: "jb-inv", label: "New invoice", icon: "receipt", href: tab("invoices"), staffOnly: true },
    { id: "jb-appt", label: "Schedule a visit", icon: "clipboardCheck", href: tab("appointments") },
    { id: "jb-photo", label: "Add photos", icon: "wand", href: tab("photos") },
  ];
  if (rel.customerId) nodes.push({ id: "jb-cust", label: "Customer", icon: "users", href: `/crm/${rel.customerId}` });
  nodes.push({ id: "jb-all", label: "All jobs", icon: "list", href: "/jobs" });
  return { center: { label, icon: "briefcase" }, nodes };
}
