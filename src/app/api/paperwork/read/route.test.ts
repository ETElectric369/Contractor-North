import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE READ'S OWN ROUTE (W1-30). Snap Or Note is in the top bar of every page, and a server action
 * runs under the page's own time; this route gives a read started anywhere its 60 seconds. It is the
 * office's (a paper carries prices), and it reads one paper by id inside the caller's company.
 */

const state = vi.hoisted(() => ({ staff: null as any, read: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => state.staff) }));
vi.mock("@/app/(app)/organize/actions", () => ({ readPaperworkItem: state.read, aiReviewItem: state.review }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));

import { POST, maxDuration, runtime } from "./route";

const ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ask = (body: unknown) => POST(new Request("http://x/api/paperwork/read", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

beforeEach(() => {
  state.read.mockReset();
  state.review.mockReset();
  state.staff = { supabase: {}, userId: "u", orgId: "org-1" };
});

describe("/api/paperwork/read", () => {
  it("has the reader's 60 seconds, on Node", () => {
    expect(maxDuration).toBe(60);
    expect(runtime).toBe("nodejs");
  });

  it("reads one paper for the office and hands back what the reader said", async () => {
    state.read.mockResolvedValue({ ok: true, item: { id: ID, vendor: "Home Depot", amount: 84.12 } });
    const res = await ask({ id: ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, item: { id: ID, vendor: "Home Depot", amount: 84.12 } });
    expect(state.read).toHaveBeenCalledWith(ID);
  });

  it("a read that fails is its sentence, never a crash", async () => {
    state.read.mockResolvedValue({ ok: false, error: "AI could not read this file. It is saved and waiting; press Read Now to try again." });
    const body = await (await ask({ id: ID })).json();
    expect(body).toEqual({ ok: false, error: "AI could not read this file. It is saved and waiting; press Read Now to try again." });
  });

  it("the crew is refused in words, and nothing is read", async () => {
    state.staff = { error: "This action is staff-only." };
    const res = await ask({ id: ID });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "This action is staff-only." });
    expect(state.read).not.toHaveBeenCalled();
  });

  it("a sign-in with no company is refused; so is anything that isn't one paper's id", async () => {
    state.staff = { supabase: {}, userId: "u", orgId: null };
    expect((await ask({ id: ID })).status).toBe(403);
    state.staff = { supabase: {}, userId: "u", orgId: "org-1" };
    for (const bad of [{ id: "../../etc" }, {}, "not json"]) expect((await ask(bad)).status).toBe(400);
    expect(state.read).not.toHaveBeenCalled();
  });

  it("an office note, already saved, is read on its own call: the answer is ok or the reader's sentence, and a throw is a sentence too", async () => {
    state.review.mockResolvedValue({ ok: true, message: "Suggested: make a task." });
    expect(await (await ask({ id: ID, note: true })).json()).toEqual({ ok: true });
    expect(state.review).toHaveBeenCalledWith(ID);
    expect(state.read).not.toHaveBeenCalled();
    state.review.mockResolvedValue({ ok: false, message: "Item not found." });
    expect(await (await ask({ id: ID, note: true })).json()).toEqual({ ok: false, error: "Item not found." });
    state.review.mockRejectedValue(new Error("model unreachable"));
    expect(await (await ask({ id: ID, note: true })).json()).toEqual({ ok: false, error: "the reader didn't answer." });
    // The crew never gets a read.
    state.staff = { error: "This action is staff-only." };
    expect((await ask({ id: ID, note: true })).status).toBe(403);
  });
});
