import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * NOT A COST, FROM THE TAP TO THE PAGE'S OWN ACTION (the owner, 2026-11-10: a supplier's quote filed
 * on a job as a Receipt kept asking to be recorded). The row table, the map, the switchboard and the
 * registry are all real here; only the caller (who is asking) and the job page's server action (what
 * it wrote) are stubbed, so the test reads the door the way a tap walks it:
 *
 *   row-buttons (⋯ Not a Cost, verb notACost) → dispatchAction → resolveRowVerb (receipt-<doc> → the
 *   paper) → executeAction (the role gate, the audit row) → document.notACost → markPaperNotACost.
 *
 * And the assistant is not offered it: this is a row door, like appointment.wontHappen.
 */
const m = vi.hoisted(() => ({
  markPaperNotACost: vi.fn(),
  buildActionCtx: vi.fn(),
  revalidatePath: vi.fn(),
  audit: [] as Record<string, unknown>[],
}));

vi.mock("@/app/(app)/jobs/actions", async (orig) => ({ ...(await orig<object>()), markPaperNotACost: m.markPaperNotACost }));
vi.mock("@/lib/actions/context", () => ({ buildActionCtx: m.buildActionCtx }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath, revalidateTag: vi.fn() }));
// The one database touch on these paths is executeAction's best-effort audit row.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        m.audit.push(row);
        return { error: null };
      },
    }),
  })),
}));

import { dispatchAction } from "./dispatch";
import { doorVerb, rowButtons } from "./row-buttons";
import { AFFORDANCES, KIND_STREAM, type ActionItem } from "./types";
import { REGISTRY } from "@/lib/actions/registry";
import { AGENT_READ_ALLOWED, AGENT_WRITE_ALLOWED, agentWriteToolsForRole } from "@/lib/actions/agent-tools";
import { actionRisk } from "@/lib/actions/risk";
import { NOT_A_COST_CATEGORY } from "@/lib/job-photos";
import { isTechDocument } from "@/lib/tech-documents";
import { categoryIsShowable } from "@/lib/portal/doc-kinds";

/** The row as the build makes it (query.ts): receipt-<document>, on the job's Costs tab. */
const receipt: ActionItem = {
  id: "receipt-doc-1",
  kind: "receipt_unbilled",
  stream: KIND_STREAM.receipt_unbilled,
  title: "Receipt · Jun 18",
  subtitle: "Larkspur · J-014",
  when: null,
  urgency: 1,
  done: false,
  href: "/jobs/job-1?tab=costs",
  affordances: AFFORDANCES.receipt_unbilled,
};
const as = (role: string) => m.buildActionCtx.mockResolvedValue({ userId: `user-${role}`, orgId: "org-1", role, lang: "en" });
const tap = () => {
  const door = rowButtons(receipt, { leadsOn: true, isStaff: true }).more.find((d) => d.label === "Not a Cost")!;
  return dispatchAction({ kind: receipt.kind, id: receipt.id, verb: doorVerb(door)! });
};

beforeEach(() => {
  vi.clearAllMocks();
  m.audit.length = 0;
  m.markPaperNotACost.mockResolvedValue({ ok: true });
  as("owner");
});

describe("the receipt row's Not a Cost, walked from the tap", () => {
  it("the office: it runs the job page's own action on the paper itself, and Needs You is refreshed", async () => {
    expect(await tap()).toEqual({ ok: true, error: undefined });
    // The row's prefix came off: the action is handed the paper, never "receipt-doc-1".
    expect(m.markPaperNotACost).toHaveBeenCalledTimes(1);
    expect(m.markPaperNotACost).toHaveBeenCalledWith("doc-1");
    expect(m.revalidatePath).toHaveBeenCalledWith("/planner");
    // Audited as a write under its own name: the keys and the id, never a value.
    expect(m.audit).toHaveLength(1);
    expect(m.audit[0]).toMatchObject({ action: "document.notACost", effect: "write", ok: true, source: "ui", user_id: "user-owner", org_id: "org-1", input_summary: { keys: ["id"], id: "doc-1" } });
  });

  it("every office seat runs it", async () => {
    for (const role of ["owner", "admin", "office"]) {
      as(role);
      expect((await tap()).ok, role).toBe(true);
    }
    expect(m.markPaperNotACost).toHaveBeenCalledTimes(3);
  });

  it("a refusal comes back as the action said it, for the sheet to say, and the list is not refreshed", async () => {
    const said = "That paper changed a moment ago: it isn't waiting to be recorded any more. Reload to see it.";
    m.markPaperNotACost.mockResolvedValue({ ok: false, error: said });
    expect(await tap()).toEqual({ ok: false, error: said });
    expect(m.revalidatePath).not.toHaveBeenCalled();
    expect(m.audit[0]).toMatchObject({ action: "document.notACost", ok: false, error: said });
  });

  it("a tech is refused by the registry's own gate, before the action runs", async () => {
    as("tech");
    expect(await tap()).toEqual({ ok: false, error: "This action is staff-only." });
    expect(m.markPaperNotACost).not.toHaveBeenCalled();
    expect(m.revalidatePath).not.toHaveBeenCalled();
    // …and a tech's row never draws the door in the first place.
    expect(rowButtons(receipt, { leadsOn: true, isStaff: false }).more).toEqual([]);
  });

  it("nobody signed in is refused; the Couldn't Check line and any other kind of row send nothing", async () => {
    m.buildActionCtx.mockResolvedValue({ userId: null, orgId: null, role: null });
    expect(await tap()).toEqual({ ok: false, error: "Not signed in." });
    as("owner");
    expect(await dispatchAction({ kind: "receipt_unbilled", id: "receipts-unread", verb: "notACost" })).toEqual({ ok: false, error: "That action isn't available here." });
    expect(await dispatchAction({ kind: "organize", id: "receipt-doc-1", verb: "notACost" })).toEqual({ ok: false, error: "That action isn't available here." });
    expect(m.markPaperNotACost).not.toHaveBeenCalled();
  });

  it("the build hands a real receipt row the verb and its paper's id; the Couldn't Check line gets neither", () => {
    const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    const from = query.indexOf("// 6) RECEIPTS NOT ON A BILL");
    expect(from).toBeGreaterThan(0);
    const feeder = query.slice(from, query.indexOf("counts.receipts_not_on_a_bill =", from));
    expect(feeder).toContain("id: `receipt-${d.id}`,");
    expect(feeder).toContain("affordances: AFFORDANCES.receipt_unbilled,");
    const unread = feeder.slice(feeder.indexOf('id: "receipts-unread"'), feeder.indexOf("} else {"));
    expect(unread).toContain('affordances: ["open"],');
    // Staff only, like every money feeder: a tech's list never holds the row at all.
    expect(feeder).toContain("if (isStaff && receiptsR) {");
  });

  it("the action says nothing extra on the way through: the confirm already said it, so no toast follows", async () => {
    // dispatchAction turns a warning / speak / recorded into the list's sticky note; this door has none.
    expect(await tap()).not.toHaveProperty("note");
  });
});

describe("the assistant is not offered Not a Cost (a row door only, like appointment.wontHappen)", () => {
  const def = REGISTRY["document.notACost"];

  it("it is a staff write in the document group, a reversible field edit like document.update", () => {
    expect(def).toMatchObject({ name: "document.notACost", group: "document", auth: "staff", effect: "write" });
    expect(def.stepUp).toBeUndefined();
    expect(actionRisk(def)).toBe(actionRisk(REGISTRY["document.update"]));
    expect(def.description).toMatch(/as Not a Cost, so it stops asking to be recorded as one/);
    expect(def.description).toMatch(/stays with the job's papers for the office \(the crew and the customer are not shown it\) and no cost changes/);
    expect(def.description).not.toMatch(/\bOther\b/);
  });

  it("it is on neither of the assistant's lists", () => {
    expect(AGENT_WRITE_ALLOWED.has("document.notACost")).toBe(false);
    expect(AGENT_READ_ALLOWED.has("document.notACost")).toBe(false);
  });

  it("no role is offered it as a tool, and no tool name resolves to it", () => {
    for (const role of ["owner", "admin", "office", "tech"]) {
      const { tools, resolve } = agentWriteToolsForRole(role);
      expect(tools.map((t) => t.name), role).not.toContain("document__notACost");
      expect(resolve("document__notACost"), role).toBeNull();
    }
  });

  it("but Nort can point at it: his map names the door by the words on it, and where it leaves the paper", () => {
    const map = readFileSync(join(process.cwd(), "src/lib/nort-product-map.ts"), "utf8");
    const line = map.split("\n").find((l) => l.startsWith("- My Day → Needs You:"))!;
    expect(line).toContain(
      "a receipt filed on a job that no bill holds comes as Receipts Not on a Bill (Record It opens the job's Costs tab; when the paper never was a cost, a supplier's quote say, its ⋯ has Not a Cost, which files it under that name: it stays with the job's papers for the office, the crew and the customer don't see it, and the pencil under Receipts & Papers on the job's Costs tab re-files it)",
    );
    // True in code: its own category, on neither the crew's list nor the customer's.
    expect(NOT_A_COST_CATEGORY).toBe("Not a Cost");
    expect(isTechDocument({ category: NOT_A_COST_CATEGORY })).toBe(false);
    expect(categoryIsShowable(NOT_A_COST_CATEGORY)).toBe(false);
    // True in code: the row's two doors, by those words, and the paper is only re-filed.
    const b = rowButtons(receipt, { leadsOn: true, isStaff: true });
    expect(b.primary).toEqual({ label: "Record It", act: { type: "open", href: "/jobs/job-1?tab=costs" } });
    expect(b.more.map((d) => d.label)).toEqual(["Not a Cost"]);
  });
});
