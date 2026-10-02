import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invoiceStatusItems, statusToSend, SENT_BY_HAND, type InvoiceStatusDeed } from "@/lib/nav-tree";

/**
 * NO STATUS IS OFFERED TWICE, AND NONE IS OFFERED AS WHAT THE INVOICE ALREADY IS (cn-v967; INV-071,
 * 2026-09-20; W1-27).
 *
 * The invoice's Status <select> rendered a DEED you could declare ("Sent Again - I re-sent it
 * myself") above a disabled option showing what the invoice actually IS ("Sent"). Both carried
 * value="sent", and a browser resolves a select's value by the FIRST option in tree order that
 * matches - so on Karen Willet's INV-071 ($1,875.98, sent 2026-09-19, revised 2026-09-20) the CLOSED
 * dropdown read "Sent Again" as though the corrected bill were already in her hands, while the amber
 * banner three inches below was asking Erik to go send it. The duplicate also broke the action:
 * picking the option the browser already considers selected fires no change event.
 *
 * W1-27 took the picker out of the body. The header's Badge is the one place the status shows, and
 * the picker's gated options are ⋯ rows (lib/nav-tree invoiceStatusItems, drawn by invoice-detail's
 * InvoiceStatusMenuItems). The class still holds, now as rows: no two rows share a value, no row is
 * the status the invoice already has, the two send declarations keep their own value and are
 * translated back to "sent" before the server sees it, and INV-071's re-send is a deed to do - never
 * shown as what the bill already is.
 */

const LIVE_STATUSES = ["sent", "partial", "paid", "overdue"];
const ALL_STATUSES = ["draft", ...LIVE_STATUSES, "void"];

type Deed = Extract<InvoiceStatusDeed, { value: string }>;
const deeds = (items: InvoiceStatusDeed[]) => items.filter((i): i is Deed => "value" in i);

/** Every shape a bill can be in that changes what the ⋯ offers. */
const CASES = ALL_STATUSES.flatMap((status) =>
  [
    { amountPaid: 0, sentAt: null, customerHoldsOlderCopy: false },
    { amountPaid: 200, sentAt: null, customerHoldsOlderCopy: false }, // INV-069: a deposit on a bill never delivered
    { amountPaid: 200, sentAt: "2026-09-19T20:54:55.199Z", customerHoldsOlderCopy: false },
    { amountPaid: 0, sentAt: "2026-09-19T20:54:55.199Z", customerHoldsOlderCopy: true }, // INV-071
  ].map((f) => ({ status, invoiceNumber: "INV-071", ...f })),
);

describe("the ⋯ status deeds (invoiceStatusItems)", () => {
  it("NO STATUS IS OFFERED TWICE — the class, not just the one that bit us", () => {
    for (const c of CASES) {
      const values = deeds(invoiceStatusItems(c)).map((d) => d.value);
      expect(new Set(values).size, `${c.status}: ${values.join(", ")}`).toBe(values.length);
      // What the server will be sent is unique too: a declaration and a real "sent" never sit together.
      const sent = values.map(statusToSend);
      expect(new Set(sent).size, `${c.status}: ${sent.join(", ")}`).toBe(sent.length);
    }
  });

  it("no row offers the status the invoice already has", () => {
    for (const c of CASES) {
      for (const d of deeds(invoiceStatusItems(c))) expect(statusToSend(d.value) === c.status && d.value !== SENT_BY_HAND, `${c.status} offers ${d.label}`).toBe(false);
    }
    // No row ever carries a live status as its value: those are the system's to set.
    for (const c of CASES) for (const d of deeds(invoiceStatusItems(c))) expect(LIVE_STATUSES).not.toContain(d.value);
  });

  it("the send declarations have a value of their own, translated back to 'sent' before it is sent", () => {
    expect(statusToSend(SENT_BY_HAND)).toBe("sent");
    expect(statusToSend("void")).toBe("void");
    expect(statusToSend("draft")).toBe("draft");
    const draft = deeds(invoiceStatusItems({ status: "draft" }));
    expect(draft.find((d) => d.label === "Mark Sent - I Sent It Myself")?.value).toBe(SENT_BY_HAND);
    // The row calls setInvoiceStatus with the translation, one line from the call.
    const src = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/invoice-detail.tsx"), "utf8");
    expect(src).toMatch(/const next = statusToSend\(value\);\s*start\(async \(\) => \{\s*const res = await setInvoiceStatus\(invoiceId, next\);/);
  });

  it("Back To Draft only where the server allows it (INV-069: a deposit on a bill nobody received never locks it)", () => {
    const labels = (c: Parameters<typeof invoiceStatusItems>[0]) => invoiceStatusItems(c).map((i) => ("label" in i ? i.label : i.note));
    expect(labels({ status: "sent", amountPaid: 200, sentAt: null })).toContain("Back To Draft");
    const held = labels({ status: "partial", amountPaid: 200, sentAt: "2026-09-19T20:54:55.199Z" });
    expect(held).not.toContain("Back To Draft");
    // …and where it isn't, the sentence says why, in its place - never a blank.
    expect(held.some((l) => /can't go back to Draft/.test(l))).toBe(true);
    // A draft is never offered Draft; a void one is offered the way back from a mistaken Void.
    expect(labels({ status: "draft" })).not.toContain("Back To Draft");
    expect(labels({ status: "void" })).toContain("Back To Draft");
  });

  it("Void Invoice sits last, behind a confirm, and never on a void bill", () => {
    const items = invoiceStatusItems({ status: "sent", invoiceNumber: "INV-071" });
    const last = items[items.length - 1];
    expect(last).toMatchObject({ label: "Void Invoice", value: "void" });
    expect("confirm" in last && last.confirm).toMatch(/^Void INV-071\?/);
    expect(invoiceStatusItems({ status: "void" }).some((i) => "value" in i && i.value === "void")).toBe(false);
  });
});

describe("INV-071 as the ⋯ offers it", () => {
  /** The live row: status 'sent', $0.00 paid (so Draft is still on offer), customerHoldsOlderCopy
   *  true (sent 2026-09-19, revised 2026-09-20). */
  const items = invoiceStatusItems({ status: "sent", invoiceNumber: "INV-071", amountPaid: 0, sentAt: "2026-09-19T20:54:55.199Z", customerHoldsOlderCopy: true });

  it("offers Mark Sent Again as a deed to do, never as what the invoice already is", () => {
    const resend = deeds(items).find((d) => d.label === "Mark Sent Again - I Re-Sent It");
    expect(resend?.value).toBe(SENT_BY_HAND);
    // The status itself is never a row: the header's Badge says "sent".
    expect(deeds(items).map((d) => d.value)).not.toContain("sent");
    const page = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/page.tsx"), "utf8");
    expect(page).toContain("<Badge tone={statusTone(inv.status)}>{statusWords}</Badge>");
  });

  it("an up-to-date sent bill offers no re-send at all (the notice isn't up, so there is nothing to declare)", () => {
    const fresh = invoiceStatusItems({ status: "sent", amountPaid: 0, sentAt: "2026-09-19T20:54:55.199Z", customerHoldsOlderCopy: false });
    expect(deeds(fresh).some((d) => d.value === SENT_BY_HAND)).toBe(false);
  });

  it("the labels name the deed, in Title Case, with no em dash", () => {
    const all = CASES.flatMap((c) => deeds(invoiceStatusItems(c)).map((d) => d.label));
    expect(all).toContain("Mark Sent - I Sent It Myself");
    expect(all).toContain("Mark Sent Again - I Re-Sent It");
    for (const l of all) {
      expect(l).not.toContain("—");
      for (const w of l.replace(/ - /g, " ").split(" ")) expect(w[0], `${l}: ${w}`).toBe(w[0].toUpperCase());
    }
  });

  it("the body no longer carries a Status picker (the Badge is the one place the status shows)", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/invoice-detail.tsx"), "utf8");
    expect(src).not.toContain('<span className="text-sm text-slate-500">Status</span>');
    expect(src).not.toMatch(/<option value="sent-by-hand">/);
  });
});
