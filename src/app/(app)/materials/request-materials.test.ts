import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A CREW MEMBER'S "TELL THE OFFICE" ASK (requestMaterials), since 2026-09-27: a LINE on the job's one
 * materials list, never a second task. The job's live "Buy Materials · N Open" row already counts
 * every open line, so a task saying the same thing would put the need on the Tasks list twice. The
 * office's bell and push stay, and now open the list.
 */
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
const createNotifications = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/lib/notifications", () => ({
  createNotifications: (...a: unknown[]) => createNotifications(...a),
  officeRecipients: vi.fn(async () => ["boss-1"]),
  ringOffice: vi.fn(async () => {}),
}));
const sendPushToProfiles = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/push", () => ({ sendPushToProfiles: (...a: unknown[]) => sendPushToProfiles(...a) }));
const createTask = vi.fn();
vi.mock("@/app/(app)/tasks/actions", () => ({ createTask: (...a: unknown[]) => createTask(...a) }));

type Op = { table: string; verb: "select" | "insert" | "delete" | "update"; payload?: unknown; filters: string[] };
const ops: Op[] = [];
let listOnJob: string | null = "list-1";

/** The caller's client: every read and write recorded, answered like the database would. */
function answer(op: Op): { data: unknown; error: null } {
  if (op.table === "profiles" && op.verb === "select" && op.filters.includes("eq:id=u-brian")) {
    return { data: { role: "tech", org_id: "org-1", full_name: "Brian Smith" }, error: null };
  }
  if (op.table === "profiles") return { data: [{ id: "boss-1", role: "owner" }, { id: "u-2", role: "tech" }], error: null };
  if (op.table === "jobs") return { data: { id: "job-1", org_id: "org-1", job_number: "J-028", name: "85 Whitney Place" }, error: null };
  if (op.table === "material_lists" && op.verb === "select") return { data: listOnJob ? { id: listOnJob } : null, error: null };
  if (op.table === "material_lists" && op.verb === "insert") {
    listOnJob = "list-new";
    return { data: { id: "list-new" }, error: null };
  }
  if (op.table === "material_list_items" && op.verb === "select") return { data: { sort_order: 4 }, error: null };
  if (op.table === "material_list_items" && op.verb === "insert") return { data: { id: "line-9" }, error: null };
  return { data: null, error: null };
}
function client() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u-brian" } } }) },
    from(table: string) {
      const op: Op = { table, verb: "select", filters: [] };
      ops.push(op);
      const b: any = {
        select: () => b,
        insert: (payload: unknown) => ((op.verb = "insert"), (op.payload = payload), b),
        delete: () => ((op.verb = "delete"), b),
        update: (payload: unknown) => ((op.verb = "update"), (op.payload = payload), b),
        eq: (c: string, v: unknown) => (op.filters.push(`eq:${c}=${String(v)}`), b),
        neq: (c: string, v: unknown) => (op.filters.push(`neq:${c}=${String(v)}`), b),
        order: () => b,
        limit: () => b,
        maybeSingle: async () => answer(op),
        single: async () => answer(op),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(answer(op)).then(ok, bad),
      };
      return b;
    },
  };
}
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));

import { requestMaterials } from "./actions";

beforeEach(() => {
  ops.length = 0;
  listOnJob = "list-1";
  [createNotifications, sendPushToProfiles, createTask].forEach((f) => f.mockClear());
});

describe("requestMaterials: a line on the list, never a duplicate task", () => {
  it("puts his words on the job's one list as a line to buy, with no price", async () => {
    const r = await requestMaterials("job-1", "Need two 3 gang faceplates by tomorrow");
    expect(r.ok).toBe(true);
    const lines = ops.filter((o) => o.table === "material_list_items" && o.verb === "insert");
    expect(lines).toHaveLength(1);
    const row = lines[0].payload as Record<string, unknown>;
    expect(row).toMatchObject({ list_id: "list-1", description: "Need two 3 gang faceplates by tomorrow", quantity: 1, unit: "ea", sort_order: 5 });
    // A tech's line carries no money keys at all (withoutMoney; 0254 pins them anyway).
    for (const k of ["vendor", "est_cost", "is_tool"]) expect(row).not.toHaveProperty(k);
  });

  it("makes no task: nothing touches the tasks table, and createTask is never called", async () => {
    await requestMaterials("job-1", "Need two 3 gang faceplates");
    expect(ops.some((o) => o.table === "tasks")).toBe(false);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("keeps the office's bell and push, pointed at the list", async () => {
    await requestMaterials("job-1", "Short on 12-2 for the far wall");
    expect(createNotifications).toHaveBeenCalledTimes(1);
    const [org, to, n] = createNotifications.mock.calls[0] as [string, string[], Record<string, string>];
    expect(org).toBe("org-1");
    expect(to).toEqual(["boss-1"]);
    expect(n.title).toMatch(/^Materials needed — .*85 Whitney Place/);
    expect(n.body).toBe("Brian Smith: Short on 12-2 for the far wall");
    expect(n.url).toBe("/jobs/job-1?tab=materials");
    expect(sendPushToProfiles).toHaveBeenCalledTimes(1);
    expect((sendPushToProfiles.mock.calls[0] as unknown[])[2]).toMatchObject({ url: "/jobs/job-1?tab=materials" });
  });

  it("a job with no list yet: the ask starts the list, then lands on it", async () => {
    listOnJob = null;
    const r = await requestMaterials("job-1", "Conduit");
    expect(r.ok).toBe(true);
    expect(ops.some((o) => o.table === "material_lists" && o.verb === "insert")).toBe(true);
    const line = ops.find((o) => o.table === "material_list_items" && o.verb === "insert");
    expect((line?.payload as Record<string, unknown>).list_id).toBe("list-new");
  });

  it("a long ask is a line's length on the list; the whole ask is in the office's bell", async () => {
    const long =
      "The 12-2 on the list won't do it for the far wall, it's a longer run than the plans show,\nso bring another 250 ft roll and two 3-gang faceplates by tomorrow morning";
    const r = await requestMaterials("job-1", long);
    expect(r.ok).toBe(true);
    const row = ops.find((o) => o.table === "material_list_items" && o.verb === "insert")?.payload as Record<string, unknown>;
    const description = String(row.description);
    expect(description.length).toBeLessThanOrEqual(120);
    expect(description).not.toContain("\n");
    expect(description.endsWith("…")).toBe(true);
    const [, , n] = createNotifications.mock.calls[0] as [string, string[], Record<string, string>];
    expect(n.body).toBe(`Brian Smith: ${long}`);
    // The push stays a push's length.
    expect(String((sendPushToProfiles.mock.calls[0] as any[])[2].body).length).toBeLessThanOrEqual("Brian Smith: ".length + 140);
  });

  it("the door asks for an item, not a message", async () => {
    const { readFileSync } = await import("node:fs");
    const door = readFileSync(new URL("./need-materials.tsx", import.meta.url), "utf8");
    // An item, and any company's (no electrician's example: nort-examples.test.ts is the law).
    expect(door).toContain('placeholder="Two more boxes of screws — need them tomorrow"');
    expect(door).not.toContain("won't do it for the far wall");
    expect(door).not.toMatch(/placeholder="[^"]*faceplate/i);
  });

  it("says what's wrong in words and writes nothing for an empty ask", async () => {
    expect(await requestMaterials("job-1", "   ")).toEqual({ ok: false, error: "Say what you need." });
    expect(ops.some((o) => o.verb === "insert")).toBe(false);
    expect(createNotifications).not.toHaveBeenCalled();
  });
});
