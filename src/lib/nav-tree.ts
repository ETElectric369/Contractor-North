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

/** A job's tabs as a mind-map; each leaf deep-links to that tab (?tab=). */
export function jobSectionTree(jobId: string, jobLabel: string): NavTree {
  const tab = (t: string) => `/jobs/${jobId}?tab=${t}`;
  return {
    center: { label: jobLabel, icon: "briefcase" },
    nodes: [
      { id: "t-job", label: "Overview", icon: "briefcase", href: tab("job") },
      { id: "t-quotes", label: "Quotes", icon: "fileText", href: tab("quotes") },
      { id: "t-invoices", label: "Invoices", icon: "receipt", href: tab("invoices") },
      { id: "t-wos", label: "Work orders", icon: "clipboardCheck", href: tab("wos") },
      { id: "t-co", label: "Change orders", icon: "fileText", href: tab("change-orders") },
      { id: "t-materials", label: "Materials", icon: "boxes", href: tab("materials") },
      { id: "t-appts", label: "Appointments", icon: "calendar", href: tab("appointments") },
      { id: "t-time", label: "Time", icon: "clock", href: tab("time") },
      { id: "t-photos", label: "Photos", icon: "list", href: tab("photos") },
      { id: "t-docs", label: "Docs", icon: "fileSpreadsheet", href: tab("docs") },
      { id: "t-tasks", label: "Tasks", icon: "listCheck", href: tab("tasks") },
      { id: "t-costs", label: "Costs", icon: "calculator", href: tab("costs") },
    ],
  };
}

/** A quote's relationships as a mind-map (linear page → related records). */
export function quoteSectionTree(
  quoteId: string,
  label: string,
  rel: { customerId?: string | null; jobId?: string | null },
): NavTree {
  const nodes: TreeNode[] = [{ id: "q-self", label: "This quote", icon: "fileText", href: `/quotes/${quoteId}` }];
  if (rel.customerId) nodes.push({ id: "q-cust", label: "Customer", icon: "users", href: `/crm/${rel.customerId}` });
  if (rel.jobId) nodes.push({ id: "q-job", label: "Job", icon: "briefcase", href: `/jobs/${rel.jobId}` });
  nodes.push({ id: "q-print", label: "Print / PDF", icon: "fileSpreadsheet", href: `/print/quote/${quoteId}` });
  nodes.push({ id: "q-all", label: "All quotes", icon: "list", href: "/quotes" });
  return { center: { label, icon: "fileText" }, nodes };
}

/** An invoice's relationships as a mind-map. */
export function invoiceSectionTree(
  invoiceId: string,
  label: string,
  rel: { customerId?: string | null; quoteId?: string | null; jobId?: string | null },
): NavTree {
  const nodes: TreeNode[] = [{ id: "i-self", label: "This invoice", icon: "receipt", href: `/billing/${invoiceId}` }];
  if (rel.customerId) nodes.push({ id: "i-cust", label: "Customer", icon: "users", href: `/crm/${rel.customerId}` });
  if (rel.jobId) nodes.push({ id: "i-job", label: "Job", icon: "briefcase", href: `/jobs/${rel.jobId}` });
  if (rel.quoteId) nodes.push({ id: "i-quote", label: "Source quote", icon: "fileText", href: `/quotes/${rel.quoteId}` });
  nodes.push({ id: "i-print", label: "Print / PDF", icon: "fileSpreadsheet", href: `/print/invoice/${invoiceId}` });
  nodes.push({ id: "i-all", label: "All invoices", icon: "list", href: "/billing" });
  return { center: { label, icon: "receipt" }, nodes };
}

/** A work order's relationships as a mind-map. */
export function workOrderSectionTree(
  woId: string,
  label: string,
  rel: { jobId?: string | null; customerId?: string | null },
): NavTree {
  const nodes: TreeNode[] = [{ id: "w-self", label: "This work order", icon: "clipboardCheck", href: `/work-orders/${woId}` }];
  if (rel.jobId) nodes.push({ id: "w-job", label: "Job", icon: "briefcase", href: `/jobs/${rel.jobId}` });
  if (rel.customerId) nodes.push({ id: "w-cust", label: "Customer", icon: "users", href: `/crm/${rel.customerId}` });
  nodes.push({ id: "w-print", label: "Print / PDF", icon: "fileSpreadsheet", href: `/print/work-order/${woId}` });
  nodes.push({ id: "w-all", label: "All work orders", icon: "list", href: "/work-orders" });
  return { center: { label, icon: "clipboardCheck" }, nodes };
}

/** A material list's relationships as a mind-map. */
export function materialListSectionTree(listId: string, label: string, rel: { jobId?: string | null }): NavTree {
  const nodes: TreeNode[] = [{ id: "ml-self", label: "This list", icon: "boxes", href: `/materials/${listId}` }];
  if (rel.jobId) nodes.push({ id: "ml-job", label: "Job", icon: "briefcase", href: `/jobs/${rel.jobId}` });
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

/** A customer's tabs as a mind-map; each leaf deep-links to that tab (?tab=). */
export function customerSectionTree(custId: string, custLabel: string): NavTree {
  const tab = (t: string) => `/crm/${custId}?tab=${t}`;
  return {
    center: { label: custLabel, icon: "users" },
    nodes: [
      { id: "cd", label: "Details", icon: "users", href: tab("details") },
      { id: "cj", label: "Jobs", icon: "briefcase", href: tab("jobs") },
      { id: "cq", label: "Quotes", icon: "fileText", href: tab("quotes") },
      { id: "ci", label: "Invoices", icon: "receipt", href: tab("invoices") },
    ],
  };
}
