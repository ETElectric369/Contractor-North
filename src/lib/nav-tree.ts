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

// NOTE: the job hub no longer has a section tree — its actions live in the
// action dock (job-action-dock.tsx) and its Manage ⋯ menu (job-manage-menu.tsx).
// The dormant global NAV_TREE (the incomplete mind-map twin of the dock) was
// deleted with it; the invoice/WO/material/PO/customer trees above stay live.
