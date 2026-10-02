import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CHANGE ORDERS LIVE ON THEIR JOB, AND ALWAYS HAVE ONE (W2-12).
 *   · /change-orders is a redirect to /jobs: each change order opens from its job's tab.
 *   · A change order can never be saved without its job: New Change Order posts the job tab's one job
 *     (no Job box, no "— None —"), the edit has no Job box, createChangeOrder refuses a missing job and
 *     updateChangeOrder an empty one, and Nort's create needs the job while its update can't touch it.
 *     Before this, one made on the job tab without touching the box saved with NO job, showed on no
 *     job, and after the redirect nothing could have opened it.
 *   · Every write asks for its row back: a zero-row write changed nothing, and says so.
 */

const state = vi.hoisted(() => ({
  ctx: null as any,
  /** What each table answers: rows for a read, the rows a write "returned". */
  jobRow: { id: "job-11" } as unknown,
  writeRows: [{ id: "co-1" }] as unknown[] | null,
  writeError: null as unknown,
  calls: [] as { table: string; op: string; patch?: unknown; filters: [string, unknown][] }[],
  revalidated: [] as unknown[][],
  redirected: [] as string[],
}));

function fakeClient() {
  const from = (table: string) => {
    const call: { table: string; op: string; patch?: unknown; filters: [string, unknown][] } = { table, op: "select", filters: [] };
    state.calls.push(call);
    const q: any = {
      select: () => q,
      insert: (p: unknown) => ((call.op = "insert"), (call.patch = p), q),
      update: (p: unknown) => ((call.op = "update"), (call.patch = p), q),
      delete: () => ((call.op = "delete"), q),
      eq: (k: string, v: unknown) => (call.filters.push([k, v]), q),
      maybeSingle: async () => ({ data: table === "jobs" ? state.jobRow : null, error: null }),
      single: async () => ({ data: state.writeRows?.[0] ?? null, error: state.writeError }),
      then: (ok: any, err?: any) => Promise.resolve({ data: state.writeRows, error: state.writeError }).then(ok, err),
    };
    return q;
  };
  return { from };
}

vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => state.ctx) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => void state.revalidated.push(a) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  redirect: (to: string) => {
    state.redirected.push(to);
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
// The modals draw their bodies as if open: a static render never taps the trigger.
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => createElement("div", { "data-modal": "" }, children, footer),
  ModalActions: ({ saveLabel }: { saveLabel?: string }) => createElement("button", { "data-save": "" }, saveLabel ?? "Save"),
}));

import { createChangeOrder, updateChangeOrder, deleteChangeOrder, setChangeOrderStatus } from "./actions";
import { NewChangeOrderButton } from "./new-co-button";
import { CoRowActions } from "./co-row-actions";
import { CO_NEEDS_JOB, CO_NOT_AVAILABLE, CO_OPEN_A_JOB, CO_STAYS_ON_JOB } from "./co-words";
import ChangeOrdersPage from "./page";
import { changeOrderActions } from "@/lib/actions/entities/changeOrder";
import { featureForPath } from "@/lib/feature-doors";

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const writes = () => state.calls.filter((c) => c.table === "change_orders");
const JOB = { id: "job-11", job_number: "J-011", name: "13897 Honeysuckle" };
const CO = { id: "co-1", co_number: "CO-00004", description: "Add two circuits", amount: 480, job_id: "job-11" };

beforeEach(() => {
  state.ctx = { supabase: fakeClient(), userId: "u1", orgId: "org-1" };
  state.jobRow = { id: "job-11" };
  state.writeRows = [{ id: "co-1" }];
  state.writeError = null;
  state.calls = [];
  state.revalidated = [];
  state.redirected = [];
});

describe("/change-orders is a redirect to /jobs", () => {
  it("the page redirects, and draws nothing of its own", () => {
    expect(() => ChangeOrdersPage()).toThrow("NEXT_REDIRECT /jobs");
    expect(state.redirected).toEqual(["/jobs"]);
    const src = readFileSync(join(process.cwd(), "src/app/(app)/change-orders/page.tsx"), "utf8");
    expect(src).toContain('import { redirect } from "next/navigation";');
    expect(src).toContain('redirect("/jobs");');
    expect(src).not.toContain("FeatureOffLine");
  });

  it("the route stays the Estimates switch's (so the redirect draws no Off line of its own), and nothing revalidates the old list", () => {
    expect(featureForPath("/change-orders")).toBe("estimates");
    for (const f of ["src/app/(app)/change-orders/actions.ts", "src/app/(app)/billing/actions.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toContain('revalidatePath("/change-orders")');
    }
  });
});

describe("New Change Order posts its job, and has no Job box", () => {
  it("one job: the job goes with the form as a hidden field; no select, no '— None —'", () => {
    const html = renderToStaticMarkup(createElement(NewChangeOrderButton, { jobs: [JOB] }));
    expect(html).toContain('<input type="hidden" name="job_id" value="job-11"/>');
    expect(html).not.toContain("— None —");
    expect(html).not.toMatch(/<select[^>]*name="job_id"/);
    expect(html).not.toContain("<select");
    expect(html).toContain("New Change Order");
    expect(html).toContain("On 13897 Honeysuckle.");
  });

  it("anything but exactly one job: a plain line, never a form that could save a stray", () => {
    for (const jobs of [[], [JOB, { ...JOB, id: "job-12", name: "9 Pine" }]]) {
      const html = renderToStaticMarkup(createElement(NewChangeOrderButton, { jobs }));
      expect(html).toBe(`<p class="text-sm text-slate-500">${CO_OPEN_A_JOB}</p>`);
    }
    expect(CO_OPEN_A_JOB).toBe("Open a job to add a change order.");
  });

  it("the source has no job picker left to fall back to", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/change-orders/new-co-button.tsx"), "utf8");
    expect(src).not.toContain("— None —");
    expect(src).not.toContain("<Select");
  });
});

describe("the edit has no Job box: it can't unlink the job", () => {
  it("renders description and amount only, with 44px Edit and Delete", () => {
    const html = renderToStaticMarkup(createElement(CoRowActions, { co: CO, jobs: [JOB] }));
    expect(html).not.toContain("co-job");
    expect(html).not.toMatch(/name="job_id"/);
    expect(html).not.toContain("— None —");
    expect(html).toContain('id="co-desc"');
    expect(html).toContain('id="co-amount"');
    for (const t of ["Edit", "Delete"]) expect(html).toMatch(new RegExp(`<button[^>]*h-11 w-11[^>]*title="${t}"[^>]*aria-label="${t}"`));
    const src = readFileSync(join(process.cwd(), "src/app/(app)/change-orders/co-row-actions.tsx"), "utf8");
    expect(src).not.toContain("<Select");
  });
});

describe("createChangeOrder: a change order always has its job", () => {
  it("refuses a missing job, in words, and writes nothing", async () => {
    expect(await createChangeOrder(fd({ description: "Add two circuits", amount: "480" }))).toEqual({ ok: false, error: CO_NEEDS_JOB });
    expect(await createChangeOrder(fd({ description: "Add two circuits", amount: "480", job_id: "  " }))).toEqual({ ok: false, error: CO_NEEDS_JOB });
    expect(writes()).toEqual([]);
    expect(CO_NEEDS_JOB).toBe("Pick the job this change order belongs to.");
  });

  it("refuses a job that isn't this company's", async () => {
    state.jobRow = null;
    expect(await createChangeOrder(fd({ description: "Add two circuits", job_id: "job-elsewhere" }))).toEqual({ ok: false, error: CO_NEEDS_JOB });
    expect(writes()).toEqual([]);
    const jobRead = state.calls.find((c) => c.table === "jobs")!;
    expect(jobRead.filters).toEqual([
      ["id", "job-elsewhere"],
      ["org_id", "org-1"],
    ]);
  });

  it("saves on its job, and the job pages are revalidated (there is no list page)", async () => {
    expect(await createChangeOrder(fd({ description: "Add two circuits", amount: "480", job_id: "job-11" }))).toEqual({ ok: true, id: "co-1" });
    const [insert] = writes();
    expect(insert.op).toBe("insert");
    expect(insert.patch).toMatchObject({ description: "Add two circuits", amount: 480, job_id: "job-11", status: "pending", created_by: "u1" });
    expect(state.revalidated).toEqual([["/jobs/[id]", "page"]]);
  });

  it("a tech is refused before anything is read", async () => {
    state.ctx = { error: "This action is staff-only." };
    expect(await createChangeOrder(fd({ description: "x", job_id: "job-11" }))).toEqual({ ok: false, error: "This action is staff-only." });
  });
});

describe("updateChangeOrder: it stays on its job, and a zero-row write says so", () => {
  it("refuses a present-but-empty job_id (the last unlink door), writing nothing", async () => {
    expect(await updateChangeOrder("co-1", fd({ job_id: "" }))).toEqual({ ok: false, error: CO_STAYS_ON_JOB });
    expect(await updateChangeOrder("co-1", fd({ description: "Add two circuits", job_id: " " }))).toEqual({ ok: false, error: CO_STAYS_ON_JOB });
    expect(writes()).toEqual([]);
    expect(CO_STAYS_ON_JOB).toBe("A change order stays on its job.");
  });

  it("an edit with no job_id never touches the job, and is scoped to the company", async () => {
    expect(await updateChangeOrder("co-1", fd({ description: "Add three circuits", amount: "620" }))).toEqual({ ok: true });
    const [update] = writes();
    expect(update.op).toBe("update");
    expect(update.patch).toEqual({ description: "Add three circuits", amount: 620 });
    expect(update.filters).toEqual([
      ["id", "co-1"],
      ["org_id", "org-1"],
    ]);
  });

  it("zero rows back: that change order isn't available, so nothing changed", async () => {
    state.writeRows = [];
    expect(await updateChangeOrder("gone", fd({ amount: "5" }))).toEqual({ ok: false, error: CO_NOT_AVAILABLE });
    expect(CO_NOT_AVAILABLE).toBe("That change order isn't available, so nothing changed.");
  });
});

describe("delete and status: a zero-row write is an error", () => {
  it("a status write that changes no row says so", async () => {
    state.writeRows = [];
    expect(await setChangeOrderStatus("gone", "approved")).toEqual({ ok: false, error: CO_NOT_AVAILABLE });
    state.writeRows = null;
    expect(await setChangeOrderStatus("gone", "approved")).toEqual({ ok: false, error: CO_NOT_AVAILABLE });
  });

  it("a delete that changes no row says so", async () => {
    state.writeRows = [];
    expect(await deleteChangeOrder("gone")).toEqual({ ok: false, error: CO_NOT_AVAILABLE });
  });

  it("with the row back, both are ok and scoped to the company", async () => {
    expect(await setChangeOrderStatus("co-1", "approved")).toEqual({ ok: true });
    expect(await deleteChangeOrder("co-1")).toEqual({ ok: true });
    for (const w of writes()) expect(w.filters).toEqual([
      ["id", "co-1"],
      ["org_id", "org-1"],
    ]);
    expect(writes().map((w) => w.op)).toEqual(["update", "delete"]);
  });
});

describe("Nort: create needs the job, update can't touch it", () => {
  it("changeorder.create requires job_id", () => {
    const create = changeOrderActions["changeorder.create"];
    expect(create.input.safeParse({ description: "Add two circuits", amount: 480 }).success).toBe(false);
    expect(create.input.safeParse({ description: "Add two circuits", amount: 480, job_id: null }).success).toBe(false);
    expect(create.input.safeParse({ description: "Add two circuits", amount: 480, job_id: "job-11" }).success).toBe(true);
  });

  it("changeorder.update has no job_id, and says nothing about unlinking", () => {
    const update = changeOrderActions["changeorder.update"];
    const parsed = update.input.safeParse({ id: "co-1", job_id: null });
    expect(parsed.success).toBe(true);
    // An old caller's job_id is dropped by the schema, so the handler can never send one.
    expect(parsed.success && Object.keys(parsed.data as object)).toEqual(["id"]);
    expect(update.description).not.toMatch(/unlink/i);
    expect(update.description).not.toContain("job_id");
  });

  it("an update through Nort sends only what it was given, never a job", async () => {
    await changeOrderActions["changeorder.update"].handler({ id: "co-1", amount: 620 } as any, {} as any);
    const [update] = writes();
    expect(update.patch).toEqual({ amount: 620 });
  });
});
