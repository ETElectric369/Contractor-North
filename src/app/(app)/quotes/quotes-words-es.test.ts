import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE ESTIMATES' ANSWERS IN THE CALLER'S LANGUAGE (the estimates-in-Spanish wave, cn-v1145): a
 * Spanish-reading office gets quotes/actions' refusals and notes from lib/words/quotes-server (qs_) in
 * Spanish (the profile's language, read once per call), a count as its own sentence (…One / …Many);
 * an English reader gets the very bytes the actions always said. What the tenant's CUSTOMER reads —
 * the text body, the share sheet's title and text, the notice email's subject — stays English under a
 * Spanish caller. Without a database: a per-table fake, plus the caller's profile.
 */
type Row = Record<string, any>;
const db = vi.hoisted(() => ({
  language: "es" as string,
  /** What each table answers: a row for maybeSingle, a list otherwise; `updated` is an update's read-back. */
  rows: {} as Record<string, any>,
  updated: [{ id: "q1" }] as Row[],
  profileReads: 0,
  sms: [] as { to: string; body: string }[],
  emails: [] as { subject: string }[],
  gate: { ok: true } as Row,
}));

function builder(table: string) {
  let op: "select" | "update" | "insert" | "delete" = "select";
  let single = false;
  const run = () => {
    // The caller's profile: the one language read an answer with words makes (lib/lang-of callerLang).
    if (table === "profiles") {
      db.profileReads += 1;
      return { data: { language: db.language }, error: null };
    }
    if (op === "update" || op === "delete") return { data: db.updated, error: null };
    const v = db.rows[table];
    return { data: single ? (Array.isArray(v) ? (v[0] ?? null) : (v ?? null)) : (Array.isArray(v) ? v : v ? [v] : []), error: null };
  };
  const b: any = {
    select: () => b,
    update: () => ((op = "update"), b),
    delete: () => ((op = "delete"), b),
    insert: () => ((op = "insert"), b),
    eq: () => b,
    in: () => b,
    is: () => b,
    not: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ((single = true), run()),
    single: async () => ((single = true), run()),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}
/** A fresh session client per call, the way requireStaff makes one (the words' memo lives on it). */
const fresh = () => ({ from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } });

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => fresh()), createServiceClient: vi.fn(() => fresh()) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: fresh(), userId: "office-1", orgId: "org-1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Map<string, string>() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));
vi.mock("@/lib/sms", () => ({
  smsReadiness: () => ({ ready: true }),
  sendSms: vi.fn(async (to: string, body: string) => (db.sms.push({ to, body }), true)),
}));
vi.mock("@/lib/org-access", () => ({ orgAccess: async () => ({ state: { active: true } }) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendEmail: vi.fn(async (m: { subject: string }) => (db.emails.push({ subject: m.subject }), { ok: true })),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: async () => false }));
vi.mock("@/lib/usage-meter", () => ({ usageFor: async () => ({ state: "fine", resetOn: "2026-12-01" }) }));
vi.mock("@/lib/ai-cost", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  currentOrgId: async () => "org-1",
  aiAllowed: async () => db.gate,
}));

import {
  addQuoteItem,
  appendQuoteLines,
  emailQuote,
  generateQuoteDraft,
  quoteShareText,
  resolveDuplicateDrafts,
  setQuoteType,
  textQuote,
  updateQuoteStatus,
} from "./actions";

/** An accepted estimate on a job whose schedule has already drawn `n` payments: the edit lock. */
const drawn = (n: number) => {
  db.rows = {
    quotes: { status: "accepted", job_id: "j1", quote_number: "E-7", doc_type: "estimate" },
    contracts: null,
    payment_milestones: Array.from({ length: n }, (_, i) => ({ invoice_id: `inv-${i}`, invoices: { status: "sent" } })),
  };
};

beforeEach(() => {
  db.language = "es";
  db.rows = {};
  db.updated = [{ id: "q1" }];
  db.profileReads = 0;
  db.sms = [];
  db.emails = [];
  db.gate = { ok: true };
});

describe("a Spanish-reading office hears the estimates' refusals in Spanish", () => {
  it("a sent estimate's type, a missing estimate, a blank line, an empty batch and a blank row", async () => {
    db.rows = { quotes: { status: "sent" } };
    expect(await setQuoteType("q1", "quote")).toEqual({ ok: false, error: "Este presupuesto ya se envió — su tipo no se puede cambiar. Usa Duplicar para empezar uno nuevo." });
    db.rows = { quotes: { status: "draft" } };
    db.updated = [];
    expect(await setQuoteType("q1", "quote")).toEqual({ ok: false, error: "No se encontró ese presupuesto." });
    expect(await addQuoteItem("q1", { description: "  ", quantity: 1, unit_price: 0 })).toEqual({ ok: false, error: "La descripción es obligatoria." });
    expect(await appendQuoteLines("q1", [])).toEqual({ ok: false, error: "No hay líneas para agregar." });
    const A = "0b6c5f3e-6f0e-4a8e-9a5e-0f6b1c2d3e4f";
    expect(await appendQuoteLines("q1", [{ id: A, description: "Larkspur trench", quantity: 1, unit_price: 10 } as never, { id: A, description: " ", quantity: 1, unit_price: 0 } as never])).toEqual({
      ok: false,
      error: "La línea 2 no tiene descripción.",
    });
  });

  it("the duplicate cleanup and the status door", async () => {
    expect(await resolveDuplicateDrafts("q1", ["q1"])).toEqual({ ok: false, error: "No hay nada que eliminar." });
    expect(await updateQuoteStatus("q1", "superseded")).toEqual({ ok: false, error: "Reemplazado se pone al aceptar una revisión — usa Crear Revisión en este presupuesto en su lugar." });
  });

  it("the estimator's gate: a blank scope and the AI ceiling, in the language the gate read once", async () => {
    expect(await generateQuoteDraft("   ")).toEqual({ ok: false, error: "Primero describe el trabajo." });
    expect(db.profileReads).toBe(1);
    db.gate = { ok: false, reason: "ceiling", why: "Your company has hit its AI ceiling for the last 30 days. Message us and we'll lift it." };
    expect(await generateQuoteDraft("Snowbell panel swap")).toEqual({ ok: false, error: "Tu empresa llegó a su límite de IA de los últimos 30 días. Escríbenos y lo subimos." });
  });

  it("a count is its own sentence: one drawn payment, two drawn payments (one language read per call)", async () => {
    drawn(1);
    expect(await addQuoteItem("q1", { description: "Snowbell outlet", quantity: 1, unit_price: 50 })).toEqual({
      ok: false,
      error: "E-7 se aceptó y ya se facturó 1 de sus pagos programados — un cambio ahora volvería a calcular los pagos restantes. Usa Crear Revisión en su lugar (o anula el pago).",
    });
    expect(db.profileReads).toBe(1);
    drawn(2);
    expect(await addQuoteItem("q1", { description: "Snowbell outlet", quantity: 1, unit_price: 50 })).toEqual({
      ok: false,
      error: "E-7 se aceptó y ya se facturaron 2 de sus pagos programados — un cambio ahora volvería a calcular los pagos restantes. Usa Crear Revisión en su lugar (o anula el pago).",
    });
  });

  it("a door that says nothing reads no language", async () => {
    db.rows = { quotes: { status: "draft" } };
    expect(await setQuoteType("q1", "quote")).toEqual({ ok: true });
    expect(db.profileReads).toBe(0);
  });
});

describe("an English reader gets the very bytes the actions always said", () => {
  it("the lock, one and many, and the sent estimate's type", async () => {
    db.language = "en";
    drawn(1);
    expect(await addQuoteItem("q1", { description: "Snowbell outlet", quantity: 1, unit_price: 50 })).toEqual({
      ok: false,
      error: "E-7 is accepted and 1 scheduled payment has already been billed against it — changing it now would re-price the remaining draws. Revise it instead (or void the draw).",
    });
    drawn(3);
    expect(await addQuoteItem("q1", { description: "Snowbell outlet", quantity: 1, unit_price: 50 })).toEqual({
      ok: false,
      error: "E-7 is accepted and 3 scheduled payments have already been billed against it — changing it now would re-price the remaining draws. Revise it instead (or void the draw).",
    });
    db.rows = { quotes: { status: "sent" } };
    expect(await setQuoteType("q1", "quote")).toEqual({ ok: false, error: "This estimate was already sent — its type can't be changed. Duplicate it to start a new one." });
  });
});

describe("what the customer reads stays English under a Spanish caller", () => {
  const quote = {
    quote_number: "E-7",
    total: 100,
    public_token: "tok",
    doc_type: "estimate",
    status: "sent",
    title: "Larkspur panel",
    address: null,
    customers: { name: "Larkspur Homes", phone: "+15555550100", email: "office@example.test", address: null },
    inquiry: null,
    jobs: null,
  };
  it("the text body, the share sheet and the notice email's subject", async () => {
    db.rows = { quotes: quote, organizations: { id: "org-1", name: "Snowbell Electric", settings: {}, phone: null, email: null } };
    expect(await textQuote("q1")).toEqual({ ok: true });
    expect(db.sms[0].body).toMatch(/^Snowbell Electric: Estimate E-7 \(\$100\.00\)\. View: /);
    const share = await quoteShareText("q1");
    expect(share.title).toBe("Estimate E-7 — Snowbell Electric");
    expect(share.text).toBe("Snowbell Electric: Estimate E-7 ($100.00). View:");
    expect(await emailQuote("q1")).toEqual({ ok: true });
    expect(db.emails[0].subject).toBe("Estimate E-7 from Snowbell Electric");
    // Nothing above was a refusal or a note, so the caller's language was never read.
    expect(db.profileReads).toBe(0);
  });
  it("a refusal on the same door is the caller's", async () => {
    db.rows = { quotes: { ...quote, customers: { ...quote.customers, phone: null } }, organizations: { id: "org-1", name: "Snowbell Electric", settings: {} } };
    expect(await textQuote("q1")).toEqual({
      ok: false,
      error: "No hay un número de teléfono para la persona de este presupuesto — agrega uno en su prospecto o contacto y vuelve a enviarlo.",
    });
  });
});
