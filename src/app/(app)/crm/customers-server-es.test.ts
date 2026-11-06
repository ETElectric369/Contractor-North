import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE CUSTOMERS' ANSWERS IN THE CALLER'S LANGUAGE (the Ventas-2 wave, cn-v1146): a Spanish-reading
 * office gets crm/actions', share-actions' and portal-look-actions' refusals from
 * lib/words/customers-server (cu_srv_) in Spanish (the profile's language, read once per call, and not
 * at all when an answer says nothing), a count of a contact's records as its own sentence (…One /
 * …Many); an English reader gets the very bytes the actions always said. What the tenant's CUSTOMER
 * reads — the portal email's subject, heading, message and button — stays English under a Spanish
 * caller. Without a database: a per-table fake, plus the caller's profile.
 */
type Row = Record<string, any>;
const db = vi.hoisted(() => ({
  language: "es" as string,
  rows: {} as Record<string, any>,
  counts: {} as Record<string, number>,
  updated: [{ id: "c1" }] as Row[],
  profileReads: 0,
  emails: [] as { subject: string; html: string }[],
}));

function builder(table: string) {
  let op: "select" | "update" | "insert" | "delete" = "select";
  let single = false;
  let languageRead = false;
  const run = () => {
    if (table === "profiles" && languageRead) {
      db.profileReads += 1;
      return { data: { language: db.language }, error: null };
    }
    if (op === "update" || op === "delete") return { data: db.updated, error: null };
    const v = db.rows[table];
    return {
      data: single ? (Array.isArray(v) ? (v[0] ?? null) : (v ?? null)) : Array.isArray(v) ? v : v ? [v] : [],
      error: null,
      count: db.counts[table] ?? 0,
    };
  };
  const b: any = {
    // lib/lang-of callerLang's read is select("language"); any other profiles read is a row of the table.
    select: (cols?: string) => ((languageRead = cols === "language"), b),
    update: () => ((op = "update"), b),
    delete: () => ((op = "delete"), b),
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
/** A fresh session client per call, the way requireStaff makes one (the words' memo lives on it). */
const fresh = () => ({
  from: (t: string) => builder(t),
  rpc: async () => ({ data: null, error: null }),
  auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) },
});

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => fresh()), createServiceClient: vi.fn(() => fresh()) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: fresh(), userId: "office-1", orgId: "org-1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustCustomerPdfs: vi.fn(async () => {}) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendEmail: vi.fn(async (m: { subject: string; html: string }) => (db.emails.push({ subject: m.subject, html: m.html }), { ok: true })),
}));

import { createCustomer, deleteCustomer, emailPortalLink, mergeCustomers, patchCustomer, updateCustomer } from "./actions";
import { getShareLink } from "../share-actions";
import { portalOfficeLookUrl } from "../portal-look-actions";

beforeEach(() => {
  db.language = "es";
  db.rows = {};
  db.counts = {};
  db.updated = [{ id: "c1" }];
  db.profileReads = 0;
  db.emails = [];
});

describe("a Spanish-reading office hears the customers' refusals in Spanish", () => {
  it("the portal link's refusals name the card's buttons in the screen's words", async () => {
    expect(await emailPortalLink("c1")).toEqual({ ok: false, error: "Cliente no encontrado." });
    db.rows = { customers: { name: "Larkspur Homes", email: null } };
    expect(await emailPortalLink("c1")).toEqual({ ok: false, error: "Este cliente no tiene correo electrónico." });
    db.rows = { customers: { name: "Larkspur Homes", email: "office@example.test" } };
    expect(await emailPortalLink("c1")).toEqual({ ok: false, error: "Este cliente aún no tiene enlace. Toca Nuevo Enlace primero." });
    db.rows.customer_portal_access = { token: "tok", enabled: false, last_opened_at: null };
    expect(await emailPortalLink("c1")).toEqual({ ok: false, error: "Su enlace está desactivado. Toca Activar primero." });
    expect(db.profileReads).toBe(4);
  });

  it("a blank name, an empty patch, a gone contact, a merge into itself", async () => {
    expect(await createCustomer(new FormData())).toEqual({ ok: false, error: "El nombre es obligatorio." });
    expect(await patchCustomer("c1", {})).toEqual({ ok: false, error: "No hay nada que actualizar." });
    expect(await patchCustomer("c1", { name: "  " })).toEqual({ ok: false, error: "El nombre no puede estar vacío." });
    db.updated = [];
    const f = new FormData();
    f.set("name", "Snowbell");
    expect(await updateCustomer("c1", f)).toEqual({ ok: false, error: "Ese contacto no está disponible." });
    expect(await mergeCustomers("c1", "c1")).toEqual({ ok: false, error: "No se puede combinar un cliente consigo mismo." });
    expect(await mergeCustomers("c1", "")).toEqual({ ok: false, error: "Elige el cliente con el que se va a combinar." });
  });

  it("the delete guard counts each kind as its own sentence (one language read for the whole list)", async () => {
    db.counts = { jobs: 2, quotes: 1, customer_credits: 1 };
    expect(await deleteCustomer("c1")).toEqual({
      ok: false,
      error:
        "Este contacto tiene 2 trabajos, 1 presupuesto, 1 crédito a favor. Reasígnalos primero, combina este registro con el que te quedas, o marca el contacto como inactivo en lugar de eliminarlo.",
    });
    expect(db.profileReads).toBe(1);
    db.counts = { appointments: 1, work_orders: 3 };
    expect(await deleteCustomer("c1")).toEqual({ ok: false, error: "Eliminar este contacto deja 3 órdenes de trabajo, 1 cita sin contacto." });
  });

  it("the share card and the office's look", async () => {
    expect(await getShareLink()).toEqual({ url: "", qr: "", error: "No hay una empresa en esta cuenta." });
    expect(await portalOfficeLookUrl("not-a-uuid")).toEqual({ ok: false, error: "Ese cliente no está en tu libreta de contactos." });
    expect(await portalOfficeLookUrl("0b6c5f3e-6f0e-4a8e-9a5e-0f6b1c2d3e4f", "nope")).toEqual({ ok: false, error: "Ese trabajo no está en tu libreta de contactos." });
    expect(await portalOfficeLookUrl("0b6c5f3e-6f0e-4a8e-9a5e-0f6b1c2d3e4f")).toEqual({ ok: false, error: "Su página no se pudo abrir. Recarga e inténtalo de nuevo." });
  });

  it("a door that says nothing reads no language", async () => {
    expect(await deleteCustomer("c1")).toEqual({ ok: true });
    expect(await patchCustomer("c1", { phone: "5305550100" })).toEqual({ ok: true });
    expect(db.profileReads).toBe(0);
  });
});

describe("an English reader gets the very bytes the actions always said", () => {
  it("the same doors, in English", async () => {
    db.language = "en";
    db.rows = { customers: { name: "Larkspur Homes", email: "office@example.test" } };
    expect(await emailPortalLink("c1")).toEqual({ ok: false, error: "This customer has no link yet. Tap New Link first." });
    db.rows = {};
    db.counts = { jobs: 1, invoices: 2, job_contacts: 3 };
    expect(await deleteCustomer("c1")).toEqual({
      ok: false,
      error: "This contact has 1 job, 2 invoices, 3 job links. Reassign those first, merge this record into the one you're keeping, or mark the contact inactive instead of deleting it.",
    });
    db.counts = { documents: 1, recurring_templates: 2 };
    expect(await deleteCustomer("c1")).toEqual({ ok: false, error: "Deleting this contact leaves 1 document, 2 recurring templates with no contact attached." });
    expect(await patchCustomer("c1", {})).toEqual({ ok: false, error: "Nothing to update." });
    expect(await mergeCustomers("c1", "c1")).toEqual({ ok: false, error: "Can't merge a customer into itself." });
    expect(await getShareLink()).toEqual({ url: "", qr: "", error: "No company on this account." });
    expect(await portalOfficeLookUrl("not-a-uuid")).toEqual({ ok: false, error: "That customer isn't in your book." });
  });
});

describe("what the customer reads stays English under a Spanish caller", () => {
  it("the portal email's subject, heading, message and button", async () => {
    db.rows = {
      customers: { name: "Larkspur Homes", email: "office@example.test" },
      customer_portal_access: { token: "tok", enabled: true, last_opened_at: null },
      organizations: { name: "Snowbell Electric", phone: null, email: null, settings: {} },
    };
    expect(await emailPortalLink("c1")).toEqual({ ok: true });
    expect(db.emails).toHaveLength(1);
    expect(db.emails[0].subject).toBe("Your Snowbell Electric portal");
    expect(db.emails[0].html).toContain("Your customer portal");
    expect(db.emails[0].html).toContain("Open my portal");
    expect(db.emails[0].html).toContain("Bookmark it for easy access.");
    // Nothing above was said to the caller, so the caller's language was never read.
    expect(db.profileReads).toBe(0);
  });
});
