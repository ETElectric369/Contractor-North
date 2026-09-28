import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * FIVE KINDS TO PICK, AND AN OLD ROW'S OWN KIND ALWAYS SAVES (W2-06).
 *
 *   create / Propose Times  take only Walk-Through, Job, Service Call, Phone Call or Other; no kind
 *                           sent is Other (a new visit) or a walk-through (offering times).
 *   edit                    takes one of the five, or the row's own stored kind unchanged: a Client
 *                           Meeting whose time moves stays a Client Meeting.
 *   sizeLead                a write guard, not a picker: any known kind saves, so an old lead's
 *                           Quote or Office re-picked still saves (only the pickers narrow).
 */
type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  inserts: [] as { table: string; row: Row }[],
  updates: [] as { table: string; patch: Row }[],
  stored: "meeting" as string | null,
  proposals: [] as Row[],
}));

function builder(table: string) {
  let patch: Row | null = null;
  let insert: Row | null = null;
  const run = () => {
    if (table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } }, error: null };
    if (insert) {
      s.inserts.push({ table, row: insert });
      return { data: { id: "new-1" }, error: null };
    }
    if (patch) {
      s.updates.push({ table, patch });
      return { data: [{ id: "row-1" }], error: null };
    }
    if (table === "appointments") return { data: s.stored === null ? null : { type: s.stored }, error: null };
    return { data: null, error: null };
  };
  const b: any = {
    select: () => b,
    insert: (r: Row) => ((insert = r), b),
    update: (p: Row) => ((patch = p), b),
    single: async () => run(),
    maybeSingle: async () => run(),
    then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
  };
  for (const m of ["eq", "in", "is", "neq", "order", "limit"]) b[m] = () => b;
  return b;
}
const client = { from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })),
  requireMember: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/appointments/proposal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/appointments/proposal")>()),
  createProposalCore: vi.fn(async (_db: unknown, p: Row) => {
    s.proposals.push(p);
    return { ok: true, token: "tok-1" };
  }),
}));

const { createAppointment, updateAppointment, createAppointmentProposal } = await import("./actions");
const { sizeLead } = await import("../leads/actions");
const { WorkShapeControls } = await import("@/components/work-shape-controls");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const PICK = "Pick a kind: Walk-Through, Job, Service Call, Phone Call or Other.";
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("title", "Visit");
  fd.set("starts_at_iso", "2026-10-01T16:00:00.000Z");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  s.inserts = [];
  s.updates = [];
  s.proposals = [];
  s.stored = "meeting";
});

describe("a new visit is one of the five", () => {
  it("each of the five books as given", async () => {
    for (const type of ["inspection", "job", "service_call", "call", "other"]) {
      s.inserts = [];
      expect(await createAppointment(form({ type })), type).toMatchObject({ ok: true });
      expect(s.inserts[0]?.row.type, type).toBe(type);
    }
  });

  it("no kind sent books Other (today's plain appointment, no write-up nag), never a walk-through", async () => {
    const fd = form({});
    fd.delete("type");
    expect(await createAppointment(fd)).toMatchObject({ ok: true });
    expect(s.inserts[0].row.type).toBe("other");
  });

  it("a kind nobody picks any more is refused in the picker's words, and nothing is written", async () => {
    for (const type of ["meeting", "quote", "appointment", "final_inspection", "nonsense"]) {
      expect(await createAppointment(form({ type })), type).toEqual({ ok: false, error: PICK });
    }
    expect(s.inserts).toEqual([]);
  });
});

describe("an edit keeps the row's own kind", () => {
  it("a Client Meeting whose time is edited stays a Client Meeting", async () => {
    s.stored = "meeting";
    expect(await updateAppointment("a1", form({ type: "meeting" }))).toEqual({ ok: true });
    expect(s.updates.find((u) => u.table === "appointments")?.patch.type).toBe("meeting");
  });

  it("an edit can move it to one of the five", async () => {
    expect(await updateAppointment("a1", form({ type: "other" }))).toEqual({ ok: true });
    expect(s.updates.find((u) => u.table === "appointments")?.patch.type).toBe("other");
  });

  it("but never to another old kind it isn't", async () => {
    s.stored = "meeting";
    expect(await updateAppointment("a1", form({ type: "quote" }))).toEqual({ ok: false, error: PICK });
    expect(s.updates).toEqual([]);
  });

  it("a form that sends no kind keeps the row's own, never a silent Other", async () => {
    s.stored = "final_inspection";
    const fd = form({});
    fd.delete("type");
    expect(await updateAppointment("a1", fd)).toEqual({ ok: true });
    expect(s.updates.find((u) => u.table === "appointments")?.patch.type).toBe("final_inspection");
  });
});

describe("offering times", () => {
  const slots = JSON.stringify([{ date: "2026-10-02", time: "09:00" }]);

  it("no kind sent offers a walk-through (it was 'quote', a kind nobody picks now)", async () => {
    const fd = form({ slots_json: slots });
    fd.delete("type");
    expect(await createAppointmentProposal(fd)).toEqual({ ok: true, token: "tok-1" });
    expect(s.proposals[0].type).toBe("inspection");
  });

  it("takes one of the five, and refuses an old kind in words", async () => {
    expect(await createAppointmentProposal(form({ slots_json: slots, type: "service_call" }))).toMatchObject({ ok: true });
    expect(s.proposals[0].type).toBe("service_call");
    expect(await createAppointmentProposal(form({ slots_json: slots, type: "quote" }))).toEqual({ ok: false, error: PICK });
  });
});

describe("sizeLead is a write guard, not a picker", () => {
  it("an old lead's Quote or Office re-picked still saves; Other saves; junk is refused", async () => {
    for (const k of ["quote", "office", "other", "walkthrough", ""]) {
      s.updates = [];
      expect(await sizeLead("lead-1", { workKind: k }), k).toEqual({ ok: true });
      expect(s.updates[0].patch.work_kind, k).toBe(k || null);
    }
    expect(await sizeLead("lead-1", { workKind: "nonsense" })).toEqual({ ok: false, error: "That isn't a kind of work." });
  });
});

describe("the pickers offer the five (and a row's own old kind)", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
  const kindSelect = (workKind: string | null) => {
    const html = renderToStaticMarkup(createElement(WorkShapeControls, { workKind, plannedMinutes: null, onPatch: () => {} }));
    const sel = html.slice(html.indexOf('aria-label="What kind of work"'), html.indexOf("</select>"));
    return [...sel.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => m[2]);
  };

  it("the kind select (lead row and rail) offers Kind? and the five; an old Quote lead keeps Quote, never reads Kind?", () => {
    expect(kindSelect(null)).toEqual(["Kind?", "Walk-Through", "Job", "Service Call", "Phone Call", "Other"]);
    expect(kindSelect("quote")).toEqual(["Kind?", "Walk-Through", "Job", "Service Call", "Phone Call", "Other", "Quote"]);
    expect(kindSelect("office")).toContain("Office");
    // Its selects are 44px targets.
    const html = renderToStaticMarkup(createElement(WorkShapeControls, { workKind: null, plannedMinutes: null, onPatch: () => {} }));
    expect(html).not.toContain("h-8");
  });
  it("the New/Edit Appointment modal maps typeOptions, never the full nine", () => {
    const btn = read("app/(app)/appointments/appointment-button.tsx");
    expect(btn).toContain("const typeOptions = appointmentTypeOptions(appointment?.type ?? null);");
    expect(btn).toContain("{typeOptions.map((t) => (");
    expect(btn).not.toContain("APPOINTMENT_TYPES.map(");
    // The create default: Job from a job, Other anywhere else (the Walk-Throughs tab passes its own).
    expect(btn).toContain('type: appointment?.type ?? defaultType ?? (defaultJobId ? "job" : "other"),');
  });

  it("the lead form and the rail's kind select map kindOptions, never WORK_KINDS", () => {
    for (const f of ["app/(app)/leads/inquiry-fields.tsx", "components/work-shape-controls.tsx"]) {
      const src = read(f);
      expect(src, f).toMatch(/kindOptions\((value\.work_kind|workKind)\)\.map\(/);
      expect(src, f).not.toContain("WORK_KINDS.map(");
    }
  });
});
