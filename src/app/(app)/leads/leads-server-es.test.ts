import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE LEADS' ANSWERS IN THE CALLER'S LANGUAGE (the Ventas-2 wave, cn-v1146): a Spanish-reading office
 * gets leads/actions' refusals and notes from lib/words/leads-server (ld_srv_) in Spanish (the profile's
 * language, read once per call, and not at all when an answer says nothing); an English reader gets the
 * very bytes the actions always said. Without a database: a per-table fake, plus the caller's profile.
 */
type Row = Record<string, any>;
const db = vi.hoisted(() => ({
  language: "es" as string,
  rows: {} as Record<string, any>,
  updated: [{ id: "l1" }] as Row[],
  profileReads: 0,
}));

function builder(table: string) {
  let op: "select" | "update" | "insert" | "delete" = "select";
  let single = false;
  const run = () => {
    if (table === "profiles") {
      db.profileReads += 1;
      return { data: { language: db.language }, error: null };
    }
    if (op === "update" || op === "delete") return { data: db.updated, error: null };
    const v = db.rows[table];
    return { data: single ? (Array.isArray(v) ? (v[0] ?? null) : (v ?? null)) : Array.isArray(v) ? v : v ? [v] : [], error: null };
  };
  const b: any = {
    select: () => b,
    update: () => ((op = "update"), b),
    delete: () => ((op = "delete"), b),
    insert: () => ((op = "insert"), b),
    eq: () => b,
    neq: () => b,
    in: () => b,
    is: () => b,
    or: () => b,
    not: () => b,
    gte: () => b,
    lt: () => b,
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
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: async () => false }));
vi.mock("../schedule/actions", () => ({ placeJobOnDay: vi.fn(), planDayTimes: vi.fn() }));
vi.mock("../quotes/actions", () => ({ saveQuote: vi.fn() }));
vi.mock("@/lib/plan-brief-run", () => ({ runPlanBrief: vi.fn(async () => ({ ok: true })) }));

import {
  convertInquiry,
  createInquiry,
  deleteInquiry,
  intakeFileUrl,
  scheduleLeadsOnDay,
  setLeadContact,
  sizeLead,
  snoozeInquiry,
  updateInquiry,
} from "./actions";

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

beforeEach(() => {
  db.language = "es";
  db.rows = {};
  db.updated = [{ id: "l1" }];
  db.profileReads = 0;
});

describe("a Spanish-reading office hears the leads' refusals in Spanish", () => {
  it("a blank lead, a gone lead, a missing lead (one language read per call)", async () => {
    expect(await createInquiry(form({}))).toEqual({ ok: false, error: "Agrega un nombre, teléfono o nota para guardar el prospecto." });
    expect(db.profileReads).toBe(1);
    db.updated = [];
    expect(await updateInquiry("l1", form({ name: "Larkspur" }))).toEqual({ ok: false, error: "Ese prospecto no está disponible." });
    expect(await convertInquiry("l1", "customer")).toEqual({ ok: false, error: "Prospecto no encontrado." });
    expect(await deleteInquiry("l1")).toEqual({ ok: false, error: "Prospecto no encontrado." });
    expect(await intakeFileUrl("l1", "org-1/x.pdf")).toEqual({ ok: false, error: "No se encontró." });
  });

  it("the batch, the sizing and the contact spot", async () => {
    expect(await scheduleLeadsOnDay([], "2026-11-06")).toEqual({ ok: false, error: "Elige al menos un prospecto.", booked: 0, failures: [] });
    expect(await scheduleLeadsOnDay(["l1"], "Thursday")).toEqual({ ok: false, error: "Elige un día.", booked: 0, failures: [] });
    expect(await sizeLead("l1", { workKind: "juggling" })).toEqual({ ok: false, error: "Ese no es un tipo de trabajo." });
    expect(await sizeLead("l1", { plannedMinutes: -5 })).toEqual({ ok: false, error: "Esa duración no tiene sentido." });
    expect(await setLeadContact("l1", { email: "snowbell" })).toEqual({ ok: false, error: "Ese correo no se ve bien." });
  });

  it("a lib's refusal comes back in the caller's words too (the come-back day)", async () => {
    expect(await snoozeInquiry("l1", "soon")).toEqual({ ok: false, error: "Elige un día." });
  });

  it("a note handed to the screen: two customers with the lead's name", async () => {
    db.rows = { customers: [{ id: "c1", name: "Bayberry Lane" }, { id: "c2", name: "Bayberry Lane" }], inquiries: { id: "l9" } };
    const r = await createInquiry(form({ name: "Bayberry Lane" }));
    expect(r).toMatchObject({ ok: true, id: "l9" });
    expect(r.note).toBe(
      'Tienes 2 clientes llamados "Bayberry Lane" — un nombre solo no alcanza para elegir entre ellos, así que este prospecto no quedó enlazado a ninguno. Agrega su teléfono o correo y al convertirlo se encontrará el correcto.',
    );
    expect(db.profileReads).toBe(1);
  });

  it("a door that says nothing reads no language", async () => {
    expect(await sizeLead("l1", {})).toEqual({ ok: true });
    expect(await setLeadContact("l1", { phone: "5305550100" })).toEqual({ ok: true });
    expect(await updateInquiry("l1", form({ name: "Larkspur" }))).toEqual({ ok: true });
    expect(db.profileReads).toBe(0);
  });
});

describe("an English reader gets the very bytes the actions always said", () => {
  it("the same doors, in English", async () => {
    db.language = "en";
    expect(await createInquiry(form({}))).toEqual({ ok: false, error: "Add a name, phone, or note to save the lead." });
    db.rows = { customers: [{ id: "c1", name: "Bayberry Lane" }, { id: "c2", name: "Bayberry Lane" }], inquiries: { id: "l9" } };
    expect((await createInquiry(form({ name: "Bayberry Lane" }))).note).toBe(
      'You have 2 customers named "Bayberry Lane" — a name alone can\'t pick between them, so this lead isn\'t linked to either. Add their phone or email and converting it will find the right one.',
    );
    db.rows = {};
    db.updated = [];
    expect(await updateInquiry("l1", form({ name: "Larkspur" }))).toEqual({ ok: false, error: "That lead isn't available." });
    expect(await convertInquiry("l1", "customer")).toEqual({ ok: false, error: "Lead not found." });
    expect(await scheduleLeadsOnDay([], "2026-11-06")).toEqual({ ok: false, error: "Pick at least one lead.", booked: 0, failures: [] });
    expect(await sizeLead("l1", { plannedMinutes: -5 })).toEqual({ ok: false, error: "That duration isn't sensible." });
    expect(await setLeadContact("l1", { email: "snowbell" })).toEqual({ ok: false, error: "That email doesn't look right." });
    expect(await snoozeInquiry("l1", "soon")).toEqual({ ok: false, error: "Pick a day." });
  });
});
