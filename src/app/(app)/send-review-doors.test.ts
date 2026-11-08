import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE DOORS BEHIND THE REVIEW SHEET (cn-v1155): the estimate, the contract and the portal link each
 * answer previewXSend with the words they WOULD send, and take a SendMessage back. What the owner
 * changed lands (To, subject, message, Copy Me), what he did not keep today's words, a staff guard
 * stands at the door, and the words that went out are filed word for word. Without a database: a
 * per-table fake and a capture of the one email, the one text and the sent-messages rows.
 */
type Row = Record<string, any>;
const db = vi.hoisted(() => ({
  staff: true,
  language: "en" as string,
  rows: {} as Record<string, any>,
  emails: [] as { to: string; subject: string; html: string; bcc?: string }[],
  sms: [] as { to: string; body: string }[],
  logs: [] as Row[],
  quoteStatus: [] as string[],
}));

function builder(table: string) {
  let single = false;
  let op = "select";
  let patch: Row | null = null;
  const run = () => {
    if (table === "profiles") return { data: { language: db.language, email: "erik@larkspur.example" }, error: null };
    if (op === "update") {
      if (table === "quotes" && patch?.status) db.quoteStatus.push(String(patch.status));
      return { data: [{ id: "x" }], error: null };
    }
    const v = db.rows[table];
    return { data: single ? (Array.isArray(v) ? (v[0] ?? null) : (v ?? null)) : Array.isArray(v) ? v : v ? [v] : [], error: null, count: 0 };
  };
  const b: any = {
    select: () => b,
    update: (p: Row) => ((op = "update"), (patch = p), b),
    insert: () => ((op = "insert"), b),
    eq: () => b,
    in: () => b,
    is: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ((single = true), run()),
    single: async () => ((single = true), run()),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}
const fresh = () => ({ from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } });

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => fresh()), createServiceClient: vi.fn(() => fresh()) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: async () => (db.staff ? { supabase: fresh(), userId: "office-1", orgId: "org-1" } : { error: "This action is staff-only." }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Map<string, string>() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}), bustCustomerPdfs: vi.fn(async () => {}) }));
vi.mock("@/lib/sms", () => ({
  smsReadiness: () => ({ ready: true }),
  sendSms: vi.fn(async (to: string, body: string) => (db.sms.push({ to, body }), true)),
}));
vi.mock("@/lib/org-access", () => ({ orgAccess: async () => ({ state: { active: true } }) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendEmail: vi.fn(async (m: { to: string; subject: string; html: string; bcc?: string }) => (db.emails.push(m), { ok: true })),
}));
vi.mock("@/lib/sent-messages", () => ({
  logSend: vi.fn(async (_s: unknown, row: Row) => void db.logs.push(row)),
  senderEmail: vi.fn(async () => "erik@larkspur.example"),
}));

import { previewQuoteSend, emailQuote, textQuote } from "./quotes/actions";
import { previewContractSend, sendContract } from "./contracts/actions";
import { previewPortalSend, emailPortalLink } from "./crm/actions";

const org = { id: "org-1", name: "Snowbell Electric", settings: {}, phone: null, email: "office@snowbell.example" };
const quote = {
  id: "q1",
  customer_id: "c1",
  quote_number: "E-7",
  total: 1234.5,
  public_token: "tok",
  doc_type: "estimate",
  status: "draft",
  title: "Larkspur panel",
  address: null,
  customers: { name: "Sam Tillery", phone: "+15555550100", email: "sam@thistlewood.example", address: null },
  inquiry: null,
  jobs: null,
};

beforeEach(() => {
  db.staff = true;
  db.language = "en";
  db.rows = {};
  db.emails = [];
  db.sms = [];
  db.logs = [];
  db.quoteStatus = [];
});

describe("previewQuoteSend: the words an estimate would send", () => {
  it("a seeded estimate: today's subject, the default paragraph, the text minus its link, the fixed tails", async () => {
    db.rows = { quotes: quote, organizations: org };
    const r = await previewQuoteSend("q1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.preview;
    expect(p.kind).toBe("quote");
    expect(p.customerName).toBe("Sam Tillery");
    expect(p.to).toBe("sam@thistlewood.example");
    expect(p.phone).toBe("+15555550100");
    expect(p.subject).toBe("Estimate E-7 from Snowbell Electric");
    expect(p.body).toBe("Your estimate E-7 — Larkspur panel is ready. Total: $1,234.50.");
    expect(p.smsBody).toBe("Snowbell Electric: Estimate E-7 ($1234.50).");
    expect(p.tail.sms).toMatch(/^View: https?:\/\//);
    expect(p.tail.email).toMatch(/^View & accept estimate: https?:\/\//);
    expect(p.copyMe).toBe(false);
    expect(p.copyTo).toBe("erik@larkspur.example");
    expect(p.textReady).toBe(true);
    expect(p.viewerLang).toBe("en");
    expect(p.reviewOff).toBe(false);
  });

  it("a lead's estimate: the lead is who it goes to, and there is no customer id to file under", async () => {
    db.rows = {
      quotes: { ...quote, customer_id: null, customers: null, inquiry: { name: "Thistlewood Lead", phone: "+15555550111", email: "lead@thistlewood.example", address: null } },
      organizations: org,
    };
    const r = await previewQuoteSend("q1");
    expect(r.ok && r.preview.to).toBe("lead@thistlewood.example");
    expect(r.ok && r.preview.phone).toBe("+15555550111");
    expect(r.ok && r.preview.customerName).toBe("Thistlewood Lead");
    db.rows.organizations = { ...org, settings: { copy_owner_on_emails: true, send_without_review: true } };
    const on = await previewQuoteSend("q1");
    expect(on.ok && on.preview.copyMe).toBe(true);
    expect(on.ok && on.preview.reviewOff).toBe(true);
  });

  it("the preview keeps the estimate a draft and files nothing", async () => {
    db.rows = { quotes: quote, organizations: org };
    await previewQuoteSend("q1");
    expect(db.quoteStatus).toEqual([]);
    expect(db.logs).toEqual([]);
  });
});

describe("the staff guard stands at every door", () => {
  it("no staff, no preview and no send", async () => {
    db.staff = false;
    db.rows = { quotes: quote, organizations: org };
    expect(await previewQuoteSend("q1")).toEqual({ ok: false, error: "This action is staff-only." });
    expect(await emailQuote("q1")).toEqual({ ok: false, error: "This action is staff-only." });
    expect((await textQuote("q1")).ok).toBe(false);
    expect((await previewContractSend("k1")).ok).toBe(false);
    expect((await previewPortalSend("c1")).ok).toBe(false);
    expect(db.emails).toEqual([]);
    expect(db.sms).toEqual([]);
  });
});

describe("emailQuote and textQuote carry what the owner changed", () => {
  it("with no message: today's subject and paragraph, the draft goes Sent, and the words are filed", async () => {
    db.rows = { quotes: quote, organizations: org };
    expect(await emailQuote("q1")).toEqual({ ok: true });
    expect(db.emails[0].to).toBe("sam@thistlewood.example");
    expect(db.emails[0].subject).toBe("Estimate E-7 from Snowbell Electric");
    expect(db.emails[0].html).toContain("is ready. Total:");
    expect(db.emails[0].bcc).toBeUndefined();
    expect(db.quoteStatus).toEqual(["sent"]);
    expect(db.logs[0]).toMatchObject({ orgId: "org-1", docKind: "quote", docId: "q1", customerId: "c1", channel: "email", to: "sam@thistlewood.example", copyTo: null, sentBy: "office-1", auto: false });
  });

  it("a message's To, subject, body and Copy Me land, and the row is filed with them", async () => {
    db.rows = { quotes: quote, organizations: org };
    const r = await emailQuote("q1", { to: "pat@larkspur.example", subject: "Your panel estimate", body: "Sam, here is the panel work.\n\nCall with questions.", copyMe: true });
    expect(r).toEqual({ ok: true });
    expect(db.emails[0]).toMatchObject({ to: "pat@larkspur.example", subject: "Your panel estimate", bcc: "erik@larkspur.example" });
    expect(db.emails[0].html).toContain("Sam, here is the panel work.");
    expect(db.emails[0].html).not.toContain("is ready. Total:");
    expect(db.logs[0]).toMatchObject({ to: "pat@larkspur.example", subject: "Your panel estimate", body: "Sam, here is the panel work.\n\nCall with questions.", copyTo: "erik@larkspur.example" });
  });

  it("a lead's estimate files no customer id; a bad address or an emptied box is refused and sends nothing", async () => {
    db.rows = { quotes: { ...quote, customer_id: null, customers: null, inquiry: { name: "Thistlewood Lead", phone: "+15555550111", email: "lead@thistlewood.example", address: null } }, organizations: org };
    expect(await emailQuote("q1")).toEqual({ ok: true });
    expect(db.logs[0].customerId).toBeNull();
    const bad = await emailQuote("q1", { to: "not an address" });
    expect(bad.ok).toBe(false);
    expect((await emailQuote("q1", { body: "   " })).ok).toBe(false);
    expect(db.emails).toHaveLength(1);
  });

  it("the text: the owner's words, a space, then the link part; filed as a text", async () => {
    db.rows = { quotes: quote, organizations: org };
    expect(await textQuote("q1", { body: "Sam, your panel estimate is ready.", to: "(555) 555-0123" })).toEqual({ ok: true });
    expect(db.sms[0].to).toBe("+15555550123");
    expect(db.sms[0].body).toMatch(/^Sam, your panel estimate is ready\. View: https?:\/\//);
    expect(db.logs[0]).toMatchObject({ docKind: "quote", channel: "sms", to: "+15555550123", subject: null, copyTo: null });
    // The log keeps what the person typed, without the link tail (the same rule the email path follows).
    expect(db.logs[0].body).toBe("Sam, your panel estimate is ready.");
    expect(db.sms[0].body.startsWith(db.logs[0].body)).toBe(true);
    db.sms = [];
    expect(await textQuote("q1")).toEqual({ ok: true });
    expect(db.sms[0].body).toMatch(/^Snowbell Electric: Estimate E-7 \(\$1234\.50\)\. View: /);
  });
});

describe("sendContract", () => {
  const contract = { id: "k1", status: "draft", public_token: "ctok", contract_number: "K-3", job_id: "j1", customer_id: "c1", customers: { name: "Sam Tillery", email: "sam@thistlewood.example" } };
  it("previews email only, with the message and the fixed tail", async () => {
    db.rows = { contracts: contract, organizations: org };
    const r = await previewContractSend("k1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview).toMatchObject({ kind: "contract", phone: null, smsBody: "", textReady: false, subject: "Contract K-3 from Snowbell Electric" });
    expect(r.preview.tail.sms).toBe("");
    expect(r.preview.body).toBe("Please review contract K-3 and sign it online. If anything looks off, just reply to this email.");
    expect(r.preview.tail.email).toMatch(/^Review & sign: https?:\/\//);
  });
  it("a message lands, the row is filed, and the contract freezes", async () => {
    db.rows = { contracts: contract, organizations: org };
    expect(await sendContract("k1", { subject: "Please sign K-3", body: "Sam, the contract is attached below.", copyMe: true })).toEqual({ ok: true });
    expect(db.emails[0]).toMatchObject({ to: "sam@thistlewood.example", subject: "Please sign K-3", bcc: "erik@larkspur.example" });
    expect(db.emails[0].html).toContain("Sam, the contract is attached below.");
    expect(db.emails[0].html).toContain("Your contract is ready to review and sign");
    expect(db.logs[0]).toMatchObject({ docKind: "contract", docId: "k1", customerId: "c1", channel: "email", subject: "Please sign K-3" });
  });
  it("with no message it says today's words", async () => {
    db.rows = { contracts: contract, organizations: org };
    expect(await sendContract("k1")).toEqual({ ok: true });
    expect(db.emails[0].subject).toBe("Contract K-3 from Snowbell Electric");
    expect(db.emails[0].html).toContain("Please review contract K-3 and sign it online.");
  });
});

describe("emailPortalLink", () => {
  const portal = { token: "ptok", enabled: true, last_opened_at: null };
  it("previews the 6-digit-code sentences as the message and keeps the button's line fixed", async () => {
    db.rows = { customers: { name: "Sam Tillery", email: null }, customer_portal_access: portal, organizations: org };
    const r = await previewPortalSend("c1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview).toMatchObject({ kind: "portal", to: null, phone: null, subject: "Your Snowbell Electric portal", textReady: false });
    expect(r.preview.body).toContain("6-digit code");
    expect(r.preview.tail.email).toMatch(/^Open my portal: https?:\/\//);
  });
  it("a customer with no email can still be sent to once the sheet gives an address", async () => {
    db.rows = { customers: { name: "Sam Tillery", email: null }, customer_portal_access: portal, organizations: org };
    expect((await emailPortalLink("c1")).ok).toBe(false);
    expect(await emailPortalLink("c1", { to: "sam@thistlewood.example", subject: "Your page", body: "Sam, this is your page.", copyMe: true })).toEqual({ ok: true });
    expect(db.emails[0]).toMatchObject({ to: "sam@thistlewood.example", subject: "Your page", bcc: "erik@larkspur.example" });
    expect(db.emails[0].html).toContain("Sam, this is your page.");
    expect(db.logs[0]).toMatchObject({ docKind: "portal", docId: null, customerId: "c1", channel: "email", body: "Sam, this is your page." });
  });
});
