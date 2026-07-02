// The navigation graph that powers the detail-page "⋯" menus (SectionActionsMenu).
// THE SEEK-DOOR RULE (nav doctrine): a page's ⋯ holds its RARE DELIBERATE verbs
// plus the cross-links NOT already visible on that page — never self-links, never
// an "All X" twin of the Back breadcrumb, never a Print twin of a visible button
// (each of those is a second map of the same territory). Destructive verbs ride
// LAST, danger-styled and confirm-guarded, per the jobs Manage-menu standard.

export type TreeNode = {
  id: string;
  label: string;
  icon: string;
  href?: string;
  countKey?: string;
  children?: TreeNode[];
  /** Action node: run a server action (e.g. a conversion), then navigate to
   *  hrefPrefix + the returned id — or to `href` when the action returns no id
   *  (deletes land back on the list). Lets the menu *do* things, not just go places. */
  run?: () => Promise<{ ok: boolean; id?: string; error?: string }>;
  hrefPrefix?: string;
  /** Serializable one-click action — runs this registry action via executeAction,
   *  then navigates to `href` (if set) or refreshes. Unlike `run`, a descriptor
   *  CAN be built in a server component (functions can't cross to the client bloom). */
  action?: { name: string; input?: Record<string, unknown> };
  /** Hide from non-staff viewers (financial verbs). */
  staffOnly?: boolean;
  /** Destructive verb — rendered red, last, behind a divider. */
  danger?: boolean;
  /** confirm() copy shown before the node's run/action fires. */
  confirmText?: string;
};

export type NavTree = {
  center: { label: string; icon: string; href?: string };
  nodes: TreeNode[];
};

/** A bound delete server action + its confirm copy (the page owns the wording). */
export type DeleteVerb = {
  run: () => Promise<{ ok: boolean; error?: string }>;
  confirm: string;
};

const deleteNode = (id: string, label: string, del: DeleteVerb, listHref: string): TreeNode => ({
  id,
  label,
  icon: "trash",
  danger: true,
  confirmText: del.confirm,
  run: del.run,
  href: listHref,
});

/** The invoice ⋯ — Job is the one relationship NOT already linked on the page
 *  (customer + source estimate sit in the header meta row, Print is a solid
 *  header button, the Back link owns "All invoices"). Credit/refund and QBO are
 *  composed in as modal-owning children by the page; Delete rides last. */
export function invoiceSectionTree(
  label: string,
  rel: { jobId?: string | null },
  del: DeleteVerb,
): NavTree {
  const nodes: TreeNode[] = [];
  if (rel.jobId) nodes.push({ id: "i-job", label: "Job", icon: "briefcase", href: `/jobs/${rel.jobId}` });
  nodes.push(deleteNode("i-del", "Delete invoice", del, "/billing"));
  return { center: { label, icon: "receipt" }, nodes };
}

/** The work order ⋯ — the page already shows Job and Customer cards and a solid
 *  Print button; only the source estimate (and Delete) belong behind the door.
 *  Edit is composed in as a modal-owning child by the page. */
export function workOrderSectionTree(
  label: string,
  rel: { quoteId?: string | null },
  del: DeleteVerb,
): NavTree {
  const nodes: TreeNode[] = [];
  if (rel.quoteId) nodes.push({ id: "w-quote", label: "Source estimate", icon: "fileText", href: `/quotes/${rel.quoteId}` });
  nodes.push(deleteNode("w-del", "Delete work order", del, "/work-orders"));
  return { center: { label, icon: "clipboardCheck" }, nodes };
}

/** The material list ⋯ — the header meta row already links the job; only the
 *  source estimate (and Delete) belong behind the door. */
export function materialListSectionTree(
  label: string,
  rel: { quoteId?: string | null },
  del: DeleteVerb,
): NavTree {
  const nodes: TreeNode[] = [];
  if (rel.quoteId) nodes.push({ id: "ml-quote", label: "Source estimate", icon: "fileText", href: `/quotes/${rel.quoteId}` });
  nodes.push(deleteNode("ml-del", "Delete list", del, "/materials"));
  return { center: { label, icon: "boxes" }, nodes };
}

/** The purchase order ⋯ — the meta row links the job and the Back link owns the
 *  list, so the door holds exactly one deliberate verb: Delete. It stays so the
 *  seek door sits in the same slot on every detail page. */
export function purchaseOrderSectionTree(label: string, del: DeleteVerb): NavTree {
  return { center: { label, icon: "wallet" }, nodes: [deleteNode("po-del", "Delete PO", del, "/bills")] };
}

/** The customer ⋯ — "New invoice" rides the /billing ?new=1 contract (opens the
 *  real create modal). The old New job / New estimate tab-jumps were dropped:
 *  the header owns the real flows, and the tabs they landed on have no create
 *  button (a dead door). Delete rides last, staff-only like Merge. */
export function customerSectionTree(label: string, del: DeleteVerb): NavTree {
  return {
    center: { label, icon: "users" },
    nodes: [
      { id: "c-newinv", label: "New invoice", icon: "receipt", href: "/billing?new=1", staffOnly: true },
      { ...deleteNode("c-del", "Delete customer", del, "/crm"), staffOnly: true },
    ],
  };
}

// NOTE: the job hub has no section tree — its actions live in the action dock
// (job-action-dock.tsx) and its Manage ⋯ menu (job-manage-menu.tsx), the
// reference implementation these seek doors follow.
