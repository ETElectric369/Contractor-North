import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE INVOICE'S OWN PAGE, AND THE TWO OTHER LISTS, after 0419 (Erik, 2026-11-22: "For Revised, lets
 * mark it Sent - Revised with the send again alarm dismissible").
 *
 * Three states of the notice on the invoice page: STANDING (amber, Dismiss beside Send Again),
 * DISMISSED (quiet, said, with Bring the Notice Back), and QUIET (the line it always had). Read off the
 * source with its comments removed: the page decides on the server (lib/invoice-revision) and the body
 * draws what it is handed.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\s*\}/g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
const page = strip(read("src/app/(app)/billing/[id]/page.tsx"));
const detail = strip(read("src/app/(app)/billing/[id]/invoice-detail.tsx"));

describe("the invoice page asks the rule with the dismissal in hand", () => {
  it("the read is `*` (resend_dismissed_at rides it) and the facts carry the dismissal", () => {
    expect(page).toMatch(/\.from\("invoices"\)\s*\.select\("\*,/);
    expect(page).toContain("resendDismissedAt: (inv as { resend_dismissed_at?: string | null }).resend_dismissed_at");
    expect(page).toContain("customerHoldsOlderCopy(sentAt, revisedAt, noticeFacts)");
    expect(page).toContain("resendNoticeDismissed(sentAt, revisedAt, noticeFacts)");
    expect(page).toContain("resendNoticeDismissed={noticeDismissed}");
  });

  it("the header badge is the one status word, and a paid bill keeps its amount and date", () => {
    expect(page).toMatch(/inv\.status === "paid"\s*\?\s*`Paid \$\{formatCurrency/);
    expect(page).toContain(": invoiceStatusLabel(inv.status, changedSince);");
  });
});

describe("the notice's three states", () => {
  const start = detail.indexOf("{!linesLocked && wasDelivered && (");
  const block = detail.slice(start, detail.indexOf("<ul", start));

  it("STANDING: amber, with Dismiss beside Send Again", () => {
    const standing = block.slice(block.indexOf("customerHoldsOlderCopy ? ("), block.indexOf(") : resendNoticeDismissed ? ("));
    expect(standing).toContain("Send it again so they see where it stands.");
    expect(standing).toContain("<DismissResendButton invoiceId={invoice.id} />");
    expect(standing).toContain('label="Send Again"');
    expect(standing.indexOf("<DismissResendButton")).toBeLessThan(standing.indexOf("<SendButton"));
  });

  it("DISMISSED: said in full, with Bring the Notice Back", () => {
    const dismissed = block.slice(block.indexOf(") : resendNoticeDismissed ? ("), block.lastIndexOf(") : ("));
    expect(dismissed).toMatch(
      /\{who\} paid on an older version of this bill, and the money on it has changed since\. You dismissed the notice, so it stays quiet until this bill is sent again\./,
    );
    expect(dismissed).toContain("<DismissResendButton invoiceId={invoice.id} restore />");
    expect(dismissed).not.toContain("SendButton");
  });

  it("QUIET: every other case keeps the line it had", () => {
    const quiet = block.slice(block.lastIndexOf(") : ("));
    expect(quiet).toMatch(/has this bill already, and their link always shows what you see\./);
    expect(quiet).not.toContain("DismissResendButton");
  });

  it("the body never decides: the dismissal arrives as a prop", () => {
    expect(detail).toContain("resendNoticeDismissed = false,");
    expect(detail).not.toContain("resend_dismissed_at");
    expect(detail).not.toContain("dismissedSinceSent");
  });

  it("the button's way back is worded in Title Case and calls the restore door", () => {
    const btn = read("src/app/(app)/billing/dismiss-resend-button.tsx");
    expect(btn).toContain('"Bring the Notice Back"');
    expect(btn).toContain("restoreResendNotice(invoiceId)");
  });
});

describe("the badge on all four lists is the one status word", () => {
  it("the Invoices page's All Invoices list", () => {
    const board = strip(read("src/app/(app)/billing/page.tsx"));
    expect(board).toContain("{invoiceStatusLabel(inv.status, changedIds.has(String(inv.id)))}");
  });

  it("the job's invoices: the select lists both stamps, and the badge asks the record", () => {
    const job = strip(read("src/app/(app)/jobs/[id]/page.tsx"));
    expect(job).toMatch(/from\("invoices"\)\.select\("[^"]*\bsent_at, revised_at"\)\.eq\("job_id", id\)/);
    expect(job).toContain("<Badge tone={statusTone(iv.status)}>{invoiceStatusLabel(iv.status, changedSinceSent(iv.sent_at, iv.revised_at))}</Badge>");
    expect(job).not.toContain("<Badge tone={statusTone(iv.status)}>{iv.status}</Badge>");
  });

  it("the customer's invoices: the select lists both stamps, and the badge asks the record", () => {
    const crm = strip(read("src/app/(app)/crm/[id]/page.tsx"));
    expect(crm).toMatch(/\.from\("invoices"\)\s*\.select\("id, invoice_number, status, total, amount_paid, sent_at, revised_at"\)\s*\.eq\("customer_id", id\)/);
    expect(crm).toContain("badge: { tone: statusTone(iv.status), text: invoiceStatusLabel(iv.status, changedSinceSent(iv.sent_at, iv.revised_at)) },");
    expect(crm).not.toContain("text: iv.status }");
  });

  it("the invoice's own header (above)", () => {
    expect(page).toContain("invoiceStatusLabel(inv.status, changedSince)");
  });
});
