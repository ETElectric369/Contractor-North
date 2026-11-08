import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * REVIEW BEFORE ANYTHING GOES OUT, THE INVOICE HALF (cn-v1155). previewInvoiceSend hands the sheet
 * today's words; emailInvoice / textInvoice send what the owner typed (or today's words when he typed
 * nothing) and log what went out; the recurring cron, which passes nothing, sends byte-for-byte what
 * it always did and logs the send as automatic.
 */
const state = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  sent: [] as any[],
  texts: [] as any[],
  logs: [] as any[],
  eqs: [] as [string, string, string][],
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: makeDb(), userId: "user-sam", orgId: "org-1", role: "owner" })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => makeDb()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "app.example.test" }) }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ warmDocPdf: vi.fn(), bustDocPdf: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/invoice-recalc", () => ({ recalcInvoice: vi.fn(async () => true) }));
vi.mock("@/lib/invoice-sent-stamp", () => ({
  markInvoiceSent: vi.fn(async () => ({ ok: true })),
  markInvoiceResent: vi.fn(async () => ({ ok: true })),
  restampDueOnFirstSend: vi.fn(),
}));
vi.mock("@/lib/org-access", () => ({ orgAccess: vi.fn(async () => ({ state: { active: true } })) }));
vi.mock("@/lib/current-lang", () => ({ currentLangFor: vi.fn(async () => "es") }));
vi.mock("@/lib/sms", () => ({
  smsReadiness: vi.fn(() => ({ ready: true })),
  sendSms: vi.fn(async (to: string, body: string) => (state.texts.push({ to, body }), true)),
}));
vi.mock("@/lib/sent-messages", () => ({
  logSend: vi.fn(async (_db: unknown, row: unknown) => void state.logs.push(row)),
  senderEmail: vi.fn(async () => "sam@thistlewood.example"),
}));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async (m: unknown) => (state.sent.push(m), { ok: true })),
}));

import { previewInvoiceSend, emailInvoice, textInvoice } from "./actions";
import { deliverInvoiceEmail } from "@/lib/invoice-email";
import { renderInvoiceNoticeEmail } from "@/lib/email";

function makeDb() {
  return {
    from(table: string) {
      const b: any = {
        select: () => b,
        order: () => b,
        eq: (c: string, v: string) => (state.eqs.push([table, c, v]), b),
        maybeSingle: async () => ({ data: state.tables[table]?.[0] ?? null, error: null }),
        then: (ok: any, err?: any) => Promise.resolve({ data: state.tables[table] ?? [], error: null }).then(ok, err),
      };
      return b;
    },
  };
}

const INVOICE = {
  id: "inv-80",
  org_id: "org-1",
  customer_id: "cus-1",
  invoice_number: "INV-080",
  title: null,
  status: "sent",
  total: 1275,
  amount_paid: 0,
  public_token: "tok123",
  customers: { name: "Dana Larkspur", email: "dana@larkspur.example", phone: "(530) 555-0133", address: null },
  jobs: null,
};
const ORG = {
  id: "org-1",
  name: "Thistlewood Electric",
  phone: null,
  email: "office@thistlewood.example",
  settings: { copy_owner_on_emails: false },
};

beforeEach(() => {
  state.tables = {
    invoices: [{ ...INVOICE }],
    organizations: [{ ...ORG }],
    invoice_items: [{ id: "li-1", invoice_id: "inv-80", sort_order: 0 }],
    customer_portal_access: [],
  };
  state.sent.length = 0;
  state.texts.length = 0;
  state.logs.length = 0;
  state.eqs.length = 0;
});

describe("previewInvoiceSend", () => {
  it("hands the sheet today's words, the fixed tail, where Copy Me goes and the switch", async () => {
    state.tables.organizations[0].settings = { copy_owner_on_emails: true, send_without_review: true };
    const r = await previewInvoiceSend("inv-80", "invoice");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.preview;
    expect(p.subject).toBe("Invoice INV-080 from Thistlewood Electric");
    expect(p.body).toBe("Your invoice INV-080 is ready. Balance due: $1,275.00.");
    expect(p.smsBody).toBe("Thistlewood Electric: Invoice INV-080, balance $1275.00.");
    expect(p.tail.email).toMatch(/^View and pay \$1,275\.00: https?:\/\/.+tok123/);
    expect(p.tail.sms).toMatch(/^ View\/pay: https?:\/\/.+tok123/);
    expect(p.to).toBe("dana@larkspur.example");
    expect(p.customerName).toBe("Dana Larkspur");
    expect(p.copyMe).toBe(true);
    expect(p.copyTo).toBe("sam@thistlewood.example");
    expect(p.textReady).toBe(true);
    expect(p.viewerLang).toBe("es");
    expect(p.reviewOff).toBe(true);
    expect(state.eqs).toContainEqual(["invoices", "org_id", "org-1"]);
  });

  it("a customer with no phone still reaches Text: ready is the company's texting setup only", async () => {
    state.tables.invoices[0] = { ...INVOICE, customers: { ...INVOICE.customers, phone: null } };
    const r = await previewInvoiceSend("inv-80", "invoice");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.phone).toBeNull();
    expect(r.preview.textReady).toBe(true);
  });

  it("a paid invoice reads as a receipt, and the switch is off by default", async () => {
    state.tables.invoices[0] = { ...INVOICE, amount_paid: 1275, status: "paid" };
    const r = await previewInvoiceSend("inv-80", "receipt");
    expect(r.ok && r.preview.body).toBe("Your invoice INV-080 is ready — paid in full. Thank you!");
    expect(r.ok && r.preview.reviewOff).toBe(false);
    expect(r.ok && r.preview.tail.email).toMatch(/^View invoice: /);
  });

  it("says why when the invoice is missing or void", async () => {
    state.tables.invoices = [];
    expect(await previewInvoiceSend("inv-80", "invoice")).toEqual({ ok: false, error: "Invoice not found." });
    state.tables.invoices = [{ ...INVOICE, status: "void" }];
    const r = await previewInvoiceSend("inv-80", "invoice");
    expect(r.ok).toBe(false);
  });
});

describe("emailInvoice", () => {
  it("sends the typed address, subject and words, copies the sender, and logs the row", async () => {
    const res = await emailInvoice(
      "inv-80",
      { to: "dana.l@larkspur.example", subject: "Your bill, Dana", body: "Thanks for your patience <3\n\nPay when you can.", copyMe: true },
      "invoice",
    );
    expect(res.ok).toBe(true);
    const m = state.sent[0];
    expect(m.to).toBe("dana.l@larkspur.example");
    expect(m.subject).toBe("Your bill, Dana");
    expect(m.bcc).toBe("sam@thistlewood.example");
    expect(m.html).toContain("Thanks for your patience &lt;3");
    expect(m.html).not.toContain("is ready");
    expect(state.logs[0]).toMatchObject({
      orgId: "org-1", docKind: "invoice", docId: "inv-80", customerId: "cus-1", channel: "email",
      to: "dana.l@larkspur.example", subject: "Your bill, Dana", copyTo: "sam@thistlewood.example",
      sentBy: "user-sam", auto: false,
    });
    expect(state.logs[0].body).toContain("Pay when you can.");
  });

  it("a Copy Me that is off sends no copy even when the company's switch is on", async () => {
    state.tables.organizations[0].settings = { copy_owner_on_emails: true };
    await emailInvoice("inv-80", { copyMe: false });
    expect(state.sent[0].bcc).toBeUndefined();
    expect(state.logs[0].copyTo).toBeNull();
  });

  it("with no message the HTML is today's, byte for byte", async () => {
    await emailInvoice("inv-80");
    const m = state.sent[0];
    expect(m.to).toBe("dana@larkspur.example");
    expect(m.subject).toBe("Invoice INV-080 from Thistlewood Electric");
    expect(m.html).toContain("Your invoice <strong>INV-080</strong> is ready. Balance due:");
    // The renderer with no body is the old renderer: the same input twice gives the same bytes.
    const again = renderInvoiceNoticeEmail({
      company: { name: "Thistlewood Electric", brand: "#000000", phone: null, email: ORG.email },
      customerName: "Dana Larkspur", number: "INV-080", balance: 1275, invoiceLink: "x",
    });
    expect(again).not.toContain("undefined");
    expect(state.logs[0].body).toBe("Your invoice INV-080 is ready. Balance due: $1,275.00.");
  });

  it("refuses a blank address that is present and sends nothing", async () => {
    const res = await emailInvoice("inv-80", { to: "   " });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/email address/);
    expect(state.sent).toHaveLength(0);
    expect(state.logs).toHaveLength(0);
  });

  it("the cron's way (no options) is logged automatic with nobody as the sender, copy to the company", async () => {
    state.tables.organizations[0].settings = { copy_owner_on_emails: true };
    const res = await deliverInvoiceEmail(makeDb(), "inv-80");
    expect(res.ok).toBe(true);
    expect(state.sent[0].bcc).toBe("office@thistlewood.example");
    expect(state.logs[0]).toMatchObject({ auto: true, sentBy: null, docKind: "invoice", copyTo: "office@thistlewood.example" });
  });
});

describe("textInvoice", () => {
  it("sends the owner's words and then the fixed link, and logs the text", async () => {
    const res = await textInvoice("inv-80", { body: "Hi Dana, your bill is here." }, "invoice");
    expect(res.ok).toBe(true);
    expect(state.texts[0].to).toBe("(530) 555-0133");
    expect(state.texts[0].body).toMatch(/^Hi Dana, your bill is here\. View\/pay: https?:\/\/.+tok123$/);
    expect(state.logs[0]).toMatchObject({ channel: "sms", docKind: "invoice", subject: null, copyTo: null, sentBy: "user-sam", auto: false, body: "Hi Dana, your bill is here." });
  });

  it("a typed number goes out as E.164", async () => {
    await textInvoice("inv-80", { to: "(530) 555-0199" });
    expect(state.texts[0].to).toBe("+15305550199");
  });

  it("with no message the text is today's, word for word", async () => {
    await textInvoice("inv-80");
    expect(state.texts[0].body).toMatch(/^Thistlewood Electric: Invoice INV-080, balance \$1275\.00\. View\/pay: /);
  });

  it("refuses a body too long to text and sends nothing", async () => {
    const res = await textInvoice("inv-80", { body: "x".repeat(1700) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/too long/);
    expect(state.texts).toHaveLength(0);
    expect(state.logs).toHaveLength(0);
  });
});
