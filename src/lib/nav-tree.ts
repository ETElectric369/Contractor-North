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
  /**
   * A READ-ONLY LINE WHERE A VERB USED TO BE — never a clickable.
   *
   * A node carrying `note` has no run/href: it exists because the verb it replaces can only be
   * refused in this row's state, and hiding a control without saying what the user CAN do is
   * itself a dead end (the INV-069 rule). Renderers must draw it as plain text, not a button:
   * a row that looks pressable and does nothing is the same dead end wearing a different coat.
   */
  note?: string;
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
 *  composed in as modal-owning children by the page; Delete rides last.
 *
 *  DELETE WAS OFFERED AT EVERY STATUS, AND THE DIALOG WAS WRONG ABOUT ITS OWN RULE
 *  (2026-09-18 sweep, the INV-069 wave).
 *
 *  deleteInvoice (billing/actions.ts) refuses three ways, quoted exactly:
 *    if (inv.status === "void")  -> "This invoice is void, which is the record that it was
 *                                    cancelled. It bills nothing and holds nothing, so it
 *                                    stays on the books."
 *    if (inv.status !== "draft") -> "This invoice has already been sent, so it can't be
 *                                    deleted. Mark it void instead…"
 *    if (count && count > 0)     -> "This invoice has recorded payments — delete those first
 *                                    or mark the invoice void."
 *  The menu pushed Delete for all of them, so on five of the six statuses the only thing the
 *  row could ever do was open a confirm dialog and then report a refusal. Worse, the confirm
 *  copy the page supplied named ONLY the payments condition ("Only allowed while no payments
 *  are recorded"), so someone staring at a sent, unpaid invoice read the dialog, agreed with
 *  it, and was refused anyway. That is exactly what Erik hit on INV-069 from the other side:
 *  the screen and the rule disagreeing, with the screen sounding certain.
 *
 *  So the row is built from the rule now. `invoice` is optional because the argument was added
 *  to a shared signature with four other trees and five existing call sites; when a caller has
 *  not said what state the row is in we cannot invent one (a gate that disagrees with the
 *  server rule is the same bug moved), so the verb still renders and the server still answers.
 *  The confirm copy is corrected either way — it is the one sentence that has to be true
 *  before the click, not after it. */
export function invoiceSectionTree(
  label: string,
  rel: { jobId?: string | null },
  del: DeleteVerb,
  invoice?: { status?: string | null; hasPayments?: boolean },
  /** THE PAGE COMPOSES THE JOB LINK ITSELF (W1-26): the invoice ⋯ has an order - Preview / Print,
   *  Send Again, Get Paid, Job, Credit / Refund, QuickBooks, the status deeds, then Delete - and the
   *  menu draws its children before its nodes, so a Job node here would land after all of them.
   *  `false` leaves it out; absent keeps it, for any caller that composes nothing. */
  opts: { jobNode?: boolean } = {},
): NavTree {
  const nodes: TreeNode[] = [];
  if (rel.jobId && opts.jobNode !== false) nodes.push({ id: "i-job", label: "Job", icon: "briefcase", href: `/jobs/${rel.jobId}` });

  // THE WORDING FOLLOWS THE RULE, NOT THE CALL SITE. deleteNode normally lets the page own the
  // confirm copy, and that is how this one came to describe a rule the action does not have.
  // The three clauses collapse to one sentence a person can act on — draft, nothing paid — so
  // it is stated here, beside the gate built from those same clauses, where the dialog and the
  // rule cannot drift apart again.
  const confirm = `Delete ${label}? This only works while it is still a draft with no payments recorded. Its lines go with it, and the hours and materials they billed go back to unbilled.`;

  // A caller that passes no `invoice`, or an `invoice` whose status it couldn't read, has told
  // us nothing — and "unknown" is not "refused". Only a status we actually have can gate.
  const status = typeof invoice?.status === "string" ? invoice.status : null;
  const deletable = status === null || (status === "draft" && !invoice?.hasPayments);
  if (deletable) {
    nodes.push({ ...deleteNode("i-del", "Delete Invoice", del, "/billing"), confirmText: confirm });
  } else {
    // NEVER A BLANK WHERE A BUTTON WAS. Each line is the ending the server itself names, in the
    // words Erik uses: void is a real ending for a bill the customer is already holding, and the
    // status control that does it is right there on the page.
    //
    // THE SENTENCE IS IN `label` AS WELL AS `note` ON PURPOSE. Today's menu renderer
    // (section-actions-menu.tsx) draws every node as a row with an icon and its label; it does
    // not know about `note` yet. Carrying the words in `label` means the reader sees the answer
    // in the exact slot the verb vacated even before that renderer learns the new field, and the
    // node has no run/href/confirmText, so pressing the row does nothing at all rather than
    // opening a dialog that can only refuse. `icon` is deliberately a name the icon map does not
    // have: unknown names fall back to a plain Circle, a bullet, so the row never wears a verb's
    // trash can. When the renderer grows a text row for `note`, drop the label duplication.
    const text =
      status === "void"
        ? "Voided, so it can't be deleted. Void is the record that this bill was cancelled, and it stays on the books."
        : status === "draft"
          ? "Payments are recorded on this one, so it can't be deleted. Remove those first, or use Void Invoice above."
          : "Sent, so it can't be deleted. Void Invoice above keeps the record and puts the hours and materials it billed back to unbilled.";
    nodes.push({ id: "i-del-note", label: text, icon: "note", note: text });
  }
  return { center: { label, icon: "receipt" }, nodes };
}

/**
 * THE INVOICE'S STATUS DEEDS, AS ⋯ ROWS (W1-27). The Status <select> left the invoice body: the
 * header's Badge is the one place a status shows, and what used to be the picker's gated options
 * are deeds a person does, each a row calling setInvoiceStatus exactly as the select did:
 *
 *   Mark Sent - I Sent It Myself       a draft: the person handed it over outside the app.
 *   Mark Sent Again - I Re-Sent It     a delivered bill that changed since (customerHoldsOlderCopy):
 *                                      the corrected copy went out by hand.
 *   Back To Draft                      only where the server allows it (not with money on a bill
 *                                      the customer holds - INV-069's rule); on a void one, it is
 *                                      the way back from a mistaken Void.
 *   the sentence why Draft is gone     where Back To Draft can't be offered, never a blank.
 *   Void Invoice                       above Delete, behind a confirm.
 *
 * THE CLASS THE OLD PICKER GUARDED STILL HOLDS (INV-071, status-picker-options.test.ts): no status
 * is offered twice, none is offered as what the invoice already IS, and the two send declarations
 * carry their own value ("sent-by-hand"), translated back to "sent" by statusToSend before the
 * server sees it (its whitelist is real statuses; its `redelivered` branch keys off "sent").
 */
export type InvoiceStatusDeed =
  | { id: string; label: string; value: "sent-by-hand" | "draft" | "void"; confirm?: string }
  | { id: string; note: string };

export const SENT_BY_HAND = "sent-by-hand" as const;

export function invoiceStatusItems(inv: {
  status: string;
  invoiceNumber?: string | null;
  /** invoices.sent_at: the bill really reached the customer (0267). */
  sentAt?: string | null;
  amountPaid?: number | null;
  /** lib/invoice-revision's answer, decided on the server (0269). */
  customerHoldsOlderCopy?: boolean;
}): InvoiceStatusDeed[] {
  const isDraft = inv.status === "draft";
  const isVoid = inv.status === "void";
  const canReturnToDraft = !(Number(inv.amountPaid ?? 0) > 0 && !!inv.sentAt);
  const items: InvoiceStatusDeed[] = [];
  if (isDraft) items.push({ id: "st-sent", label: "Mark Sent - I Sent It Myself", value: SENT_BY_HAND });
  else if (!isVoid && inv.customerHoldsOlderCopy) items.push({ id: "st-resent", label: "Mark Sent Again - I Re-Sent It", value: SENT_BY_HAND });
  if (!isDraft && canReturnToDraft) items.push({ id: "st-draft", label: "Back To Draft", value: "draft" });
  if (!isDraft && !isVoid && !canReturnToDraft) {
    items.push({
      id: "st-draft-note",
      note: "This one is with the customer and has money on it, so it can't go back to Draft. You don't need Draft to fix it: change the lines, then send it again.",
    });
  }
  if (!isVoid) {
    const doc = inv.invoiceNumber || "this invoice";
    items.push({
      id: "st-void",
      label: "Void Invoice",
      value: "void",
      confirm: `Void ${doc}? It stays on the books as cancelled and bills nothing; the hours and materials it billed go back to unbilled.`,
    });
  }
  return items;
}

/** The deed's value, as the one status the server takes: the send declarations become "sent". */
export function statusToSend(value: string): string {
  return value === SENT_BY_HAND ? "sent" : value;
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
  if (rel.quoteId) nodes.push({ id: "w-quote", label: "Source Estimate", icon: "fileText", href: `/quotes/${rel.quoteId}` });
  nodes.push(deleteNode("w-del", "Delete Work Order", del, "/work-orders"));
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
  if (rel.quoteId) nodes.push({ id: "ml-quote", label: "Source Estimate", icon: "fileText", href: `/quotes/${rel.quoteId}` });
  nodes.push(deleteNode("ml-del", "Delete List", del, "/materials"));
  return { center: { label, icon: "boxes" }, nodes };
}

/** The purchase order ⋯ — the meta row links the job and the Back link owns the
 *  list, so the door holds exactly one deliberate verb: Delete. It stays so the
 *  seek door sits in the same slot on every detail page. */
export function purchaseOrderSectionTree(label: string, del: DeleteVerb): NavTree {
  return { center: { label, icon: "wallet" }, nodes: [deleteNode("po-del", "Delete PO", del, "/bills?tab=po")] };
}

/** The customer ⋯ — "New Invoice" rides the /billing ?new=1 contract (opens the
 *  real create modal) and carries ?customer= so THIS customer arrives preset.
 *  The old New job / New estimate tab-jumps were dropped:
 *  the header owns the real flows, and the tabs they landed on have no create
 *  button (a dead door). Delete rides last, staff-only like Merge. */
export function customerSectionTree(label: string, del: DeleteVerb, customerId?: string): NavTree {
  return {
    center: { label, icon: "users" },
    nodes: [
      {
        id: "c-newinv",
        label: "New Invoice",
        icon: "receipt",
        href: customerId ? `/billing?new=1&customer=${customerId}` : "/billing?new=1",
        staffOnly: true,
      },
      { ...deleteNode("c-del", "Delete Customer", del, "/crm"), staffOnly: true },
    ],
  };
}

// NOTE: the job hub has no section tree — its actions live in the action dock
// (job-action-dock.tsx) and its Manage ⋯ menu (job-manage-menu.tsx), the
// reference implementation these seek doors follow.
