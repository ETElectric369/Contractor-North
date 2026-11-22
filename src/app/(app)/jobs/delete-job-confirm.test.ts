import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { translator } from "@/lib/i18n";
import { deleteJobConfirmText } from "./[id]/job-manage-menu";

/**
 * DELETE JOB SAYS WHAT GOES AND WHAT STAYS (cn-v1180, audit C5). The second confirm listed contracts,
 * the lien record, claims, milestones, documents, permits and change orders, the tables someone named
 * in July. It said nothing of the job's tasks and its materials list, which the database deletes with
 * the job (ON DELETE CASCADE: tasks 0018, material_lists 0001), nor of the estimates, invoices, work
 * orders and clocked hours it leaves on the books with no job (ON DELETE SET NULL: quotes, work_orders,
 * time_entries 0001, invoices 0003). Both groups are counted now, in the reader's language, and a count
 * that could not be read is said, never drawn as zero.
 *
 * The stand-in honours what a read asks for: the table, `eq` / `is` / `in` / `neq` on each row, a head
 * count of the rows left; so a count read of another job's rows, or of a step under a task, is zero.
 */
const state = vi.hoisted(() => ({ client: null as any, reportError: vi.fn() }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-a", orgId: "org-a" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: state.reportError }));

import { deleteJob } from "./actions";

const JOB = "22222222-2222-4222-8222-222222222901";
const OTHER = "22222222-2222-4222-8222-222222222902";
type Row = Record<string, unknown>;

function fake(rows: Record<string, Row[]>, opts: { lang?: string; fail?: string[] } = {}) {
  const deletes: string[] = [];
  const all: Record<string, Row[]> = { profiles: [{ id: "user-a", language: opts.lang ?? "en" }], jobs: [{ id: JOB, inquiry_id: null }], ...rows };
  const client = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let head = false;
      let deleting = false;
      const answer = () => {
        if (deleting) return { data: null, error: null };
        if (opts.fail?.includes(table)) return { data: null, count: null, error: { code: "57014", message: "timeout" } };
        const hit = (all[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return head ? { data: null, count: hit.length, error: null } : { data: hit, count: hit.length, error: null };
      };
      const chain: any = {
        select: (_cols: string, o?: { head?: boolean }) => {
          head = !!o?.head;
          return chain;
        },
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
        neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), chain),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), chain),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), chain),
        not: () => chain,
        limit: () => chain,
        update: () => chain,
        delete: () => {
          deleting = true;
          deletes.push(table);
          return chain;
        },
        maybeSingle: async () => {
          const a = answer();
          return { data: Array.isArray(a.data) ? (a.data[0] ?? null) : null, error: a.error };
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(answer()).then(res, rej),
      };
      return chain;
    },
  };
  return { client, deletes };
}

/** A job with two tasks (one with a step), its materials list, an accepted estimate and a draft, one
 *  invoice, one work order and three clocked entries, beside another job's rows that must not count. */
const FULL: Record<string, Row[]> = {
  tasks: [
    { id: "t1", job_id: JOB, parent_id: null },
    { id: "t2", job_id: JOB, parent_id: null },
    { id: "t1s", job_id: JOB, parent_id: "t1" },
    { id: "tx", job_id: OTHER, parent_id: null },
  ],
  material_lists: [{ id: "m1", job_id: JOB }, { id: "mx", job_id: OTHER }],
  quotes: [{ id: "q1", job_id: JOB, status: "accepted" }, { id: "q2", job_id: JOB, status: "draft" }, { id: "qx", job_id: OTHER, status: "accepted" }],
  invoices: [{ id: "i1", job_id: JOB, invoice_kind: "standard" }, { id: "ix", job_id: OTHER, invoice_kind: "standard" }],
  work_orders: [{ id: "w1", job_id: JOB }],
  time_entries: [{ id: "h1", job_id: JOB }, { id: "h2", job_id: JOB }, { id: "h3", job_id: JOB }, { id: "hx", job_id: OTHER }],
  permits: [{ id: "p1", job_id: JOB }],
};

describe("Delete Job's confirm: what goes with the job and what stays with no job", () => {
  beforeEach(() => state.reportError.mockClear());

  it("counts both groups, this job's rows only, and deletes nothing until the person agrees", async () => {
    const f = fake(FULL);
    state.client = f.client;
    const r = await deleteJob(JOB);
    expect(r.ok).toBe(false);
    expect(r.needsConfirm).toBe(true);
    expect(r.destroys).toEqual(["Permits: 1", "Tasks: 2", "Materials lists: 1"]);
    expect(r.stays).toEqual(["Estimates: 2", "Invoices: 1", "Work orders: 1", "Clocked time entries: 3"]);
    expect(f.deletes).toEqual([]);
  });

  it("a job whose only records stay behind still asks (an accepted estimate left on no job is said)", async () => {
    const f = fake({ quotes: [{ id: "q1", job_id: JOB, status: "accepted" }] });
    state.client = f.client;
    const r = await deleteJob(JOB);
    expect(r).toMatchObject({ ok: false, needsConfirm: true, destroys: [], stays: ["Estimates: 1"] });
    expect(f.deletes).toEqual([]);
  });

  it("a count that could not be read is said on its line and filed, never drawn as zero", async () => {
    const f = fake(FULL, { fail: ["tasks", "time_entries"] });
    state.client = f.client;
    const r = await deleteJob(JOB);
    expect(r.destroys).toContain("Tasks: couldn't be counted just now");
    expect(r.stays).toContain("Clocked time entries: couldn't be counted just now");
    expect(r.destroys!.some((l) => /Tasks: 0/.test(l))).toBe(false);
    expect(state.reportError).toHaveBeenCalledWith("deleteJob.count", expect.anything(), { jobId: JOB, table: "tasks" });
    expect(f.deletes).toEqual([]);
  });

  it("in Spanish for a Spanish reader", async () => {
    const f = fake(FULL, { lang: "es" });
    state.client = f.client;
    const r = await deleteJob(JOB);
    expect(r.destroys).toEqual(["Permisos: 1", "Tareas: 2", "Listas de materiales: 1"]);
    expect(r.stays).toEqual(["Presupuestos: 2", "Facturas: 1", "Órdenes de trabajo: 1", "Registros de horas: 3"]);
    expect(r.error).toBe(translator("es")("jb_delNeedsConfirm"));
  });

  // skeptic #83 (S10): five more, each verified against its key in the migrations. CASCADE: the job's
  // blocks on the schedule (job_schedule_segments 0040) and its panel map (job_panels 0333). SET NULL:
  // supplier bills (0017), purchase orders (0002), visits (appointments 0042).
  const MORE: Record<string, Row[]> = {
    job_schedule_segments: [{ id: "s1", job_id: JOB }, { id: "s2", job_id: JOB }, { id: "sx", job_id: OTHER }],
    job_panels: [{ id: "pn1", job_id: JOB, removed_at: null }, { id: "pn0", job_id: JOB, removed_at: "2026-11-01T00:00:00Z" }, { id: "pnx", job_id: OTHER, removed_at: null }],
    bills: [{ id: "b1", job_id: JOB }, { id: "b2", job_id: JOB }, { id: "bx", job_id: OTHER }],
    purchase_orders: [{ id: "po1", job_id: JOB }],
    appointments: [{ id: "a1", job_id: JOB }, { id: "ax", job_id: OTHER }],
  };

  it("skeptic #83 (S10): names the blocks on the schedule and the panel map that go, and the bills, purchase orders and visits that stay", async () => {
    const f = fake({ ...FULL, ...MORE });
    state.client = f.client;
    const r = await deleteJob(JOB);
    expect(r.destroys).toEqual(["Permits: 1", "Tasks: 2", "Materials lists: 1", "Its blocks on the schedule: 2", "Panel maps: 1"]);
    expect(r.stays).toEqual([
      "Estimates: 2",
      "Invoices: 1",
      "Work orders: 1",
      "Clocked time entries: 3",
      "Supplier bills and receipts: 2",
      "Purchase orders: 1",
      "Visits: 1",
    ]);
    expect(f.deletes).toEqual([]);
  });

  it("skeptic #83 (S10): only bills or visits on a job still ask, in Spanish too; a failed count of them is said", async () => {
    let f = fake({ bills: [{ id: "b1", job_id: JOB }] }, { lang: "es" });
    state.client = f.client;
    expect(await deleteJob(JOB)).toMatchObject({ ok: false, needsConfirm: true, destroys: [], stays: ["Cuentas y recibos de proveedores: 1"] });
    f = fake({ ...MORE }, { lang: "es" });
    state.client = f.client;
    const es = await deleteJob(JOB);
    expect(es.destroys).toEqual(["Sus bloques en el calendario: 2", "Mapas del panel: 1"]);
    expect(es.stays).toEqual(["Cuentas y recibos de proveedores: 2", "Órdenes de compra: 1", "Visitas: 1"]);
    f = fake({ ...MORE }, { fail: ["job_schedule_segments", "appointments"] });
    state.client = f.client;
    const failed = await deleteJob(JOB);
    expect(failed.destroys).toContain("Its blocks on the schedule: couldn't be counted just now");
    expect(failed.stays).toContain("Visits: couldn't be counted just now");
    expect(f.deletes).toEqual([]);
  });

  it("agreed, the job is deleted; a job with nothing on it is deleted with no second question", async () => {
    let f = fake(FULL);
    state.client = f.client;
    expect(await deleteJob(JOB, { confirmDestructive: true })).toEqual({ ok: true });
    expect(f.deletes).toEqual(["jobs"]);
    f = fake({ tasks: [{ id: "tx", job_id: OTHER, parent_id: null }] });
    state.client = f.client;
    expect(await deleteJob(JOB)).toEqual({ ok: true });
  });

  it("the dialog draws both headings and the lines, and a group with none draws no heading", () => {
    const en = translator("en");
    const text = deleteJobConfirmText("J-901", ["Tasks: 2"], ["Estimates: 1"], en);
    expect(text).toBe(
      "Deleting job J-901 also permanently deletes:\n\n  • Tasks: 2\n\nThese stay, with no job:\n\n  • Estimates: 1\n\nThis cannot be undone. Delete anyway?",
    );
    expect(deleteJobConfirmText("J-901", [], ["Estimates: 1"], en)).not.toContain("permanently deletes");
    expect(deleteJobConfirmText("J-901", ["Tasks: 2"], [], translator("es"))).toContain("Borrar el trabajo J-901 también borra para siempre:");
  });

  it("the menu asks on either group, and its first confirm is in the reader's language", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-manage-menu.tsx"), "utf8");
    expect(src).toContain("res.needsConfirm && (res.destroys?.length || res.stays?.length)");
    expect(src).toContain('fillText(t("jb_delFirstConfirm"), { job: jobNumber })');
  });
});
