import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * "YOU'RE ON THIS JOB", IN EACH PERSON'S LANGUAGE (lib/crew-notify, cn-v1138). Driven through the
 * REAL notifyPeople on a fake service client: one profiles read for the languages, a Spanish bell
 * line and push for the es person and English for the en one in the SAME call, the type "assigned"
 * and the kind "assigned" as before; only the additions hear, never the caller; a failed language
 * read is English for everyone and never a lost line; nothing ever throws out of it.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const state = vi.hoisted(() => ({
  people: [] as { id: string; language: string | null }[],
  failLangRead: false,
  langReads: [] as unknown[][],
  orgFilters: [] as unknown[],
  rows: [] as Record<string, unknown>[],
  insertFails: false,
}));

function profiles() {
  let wanted: unknown[] = [];
  const api: any = {
    select: () => api,
    in: (_k: string, vs: unknown[]) => ((wanted = vs), state.langReads.push(vs), api),
    // The language read names the company (three companies, one database): a stranger's id answers "en".
    eq: (k: string, v: unknown) => (k === "org_id" && state.orgFilters.push(v), api),
    then: (res: (v: unknown) => void) => {
      if (state.failLangRead) return res({ data: null, error: { message: "profiles unreadable" } });
      res({ data: state.people.filter((p) => wanted.includes(p.id)), error: null });
    },
  };
  return api;
}
function notifications() {
  return {
    insert: async (rows: Record<string, unknown>[]) => {
      if (state.insertFails) return { error: { message: "insert refused" } };
      state.rows.push(...rows);
      return { error: null };
    },
  };
}
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from: (t: string) => (t === "profiles" ? profiles() : notifications()) }) }));
const push = vi.fn(async (ids: string[]) => ids);
vi.mock("@/lib/push", () => ({
  sendPushToProfiles: (...a: unknown[]) => push(...(a as [string[]])),
  pushKindIsOptIn: (kind: string) => kind === "day_ahead",
}));

import { reportError } from "@/lib/observe";
import { notifyJobCrewAdded } from "./crew-notify";

const job = { id: "job-1", org_id: "org-1", job_number: "J-047", name: "Larkspur deck" };

beforeEach(() => {
  state.people = [];
  state.failLangRead = false;
  state.langReads = [];
  state.orgFilters = [];
  state.rows = [];
  state.insertFails = false;
  push.mockClear();
  vi.mocked(reportError).mockClear();
});

describe("notifyJobCrewAdded", () => {
  it("es and en in one call: one language read, each person their own bell line and push, the type and kind as before", async () => {
    state.people = [
      { id: "larkspur", language: "es" },
      { id: "snowbell", language: "en" },
      { id: "bayberry", language: null },
    ];
    await notifyJobCrewAdded(job, ["snowbell"], ["snowbell", "larkspur", "bayberry", "me"], "me");
    // Only the additions, never the caller, and ONE read for their languages, filtered to the job's company.
    expect(state.langReads).toEqual([["larkspur", "bayberry"]]);
    expect(state.orgFilters).toEqual(["org-1"]);
    expect(state.rows).toEqual([
      { org_id: "org-1", user_id: "larkspur", type: "assigned", title: "Nuevo trabajo asignado", body: "Estás en J-047 · Larkspur deck.", url: "/jobs/job-1" },
      { org_id: "org-1", user_id: "bayberry", type: "assigned", title: "New job assigned", body: "You're on J-047 · Larkspur deck.", url: "/jobs/job-1" },
    ]);
    expect(push.mock.calls).toEqual([
      [["larkspur"], "assigned", { title: "Nuevo trabajo asignado", body: "Estás en J-047 · Larkspur deck.", url: "/jobs/job-1" }],
      [["bayberry"], "assigned", { title: "New job assigned", body: "You're on J-047 · Larkspur deck.", url: "/jobs/job-1" }],
    ]);
  });

  it("a job with no number and no name is 'a job' in each language", async () => {
    state.people = [{ id: "larkspur", language: "es" }];
    await notifyJobCrewAdded({ id: "job-2", org_id: "org-1" }, [], ["larkspur", "snowbell"], "me");
    expect(state.rows.map((r) => [r.user_id, r.body])).toEqual([
      ["larkspur", "Estás en un trabajo."],
      ["snowbell", "You're on a job."],
    ]);
  });

  it("nobody added, or only the caller: no read, no line, no push", async () => {
    await notifyJobCrewAdded(job, ["larkspur"], ["larkspur"], "me");
    await notifyJobCrewAdded(job, [], ["me"], "me");
    await notifyJobCrewAdded(job, null, [], "me");
    expect(state.langReads).toEqual([]);
    expect(state.rows).toEqual([]);
    expect(push).not.toHaveBeenCalled();
  });

  it("a failed language read is English for everyone, filed, and still a line and a push; a refused insert never throws out", async () => {
    state.people = [{ id: "larkspur", language: "es" }];
    state.failLangRead = true;
    await notifyJobCrewAdded(job, [], ["larkspur"], "me");
    expect(state.rows.map((r) => [r.user_id, r.title])).toEqual([["larkspur", "New job assigned"]]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith("lang-of:read", { message: "profiles unreadable" }, { count: 1 });
    state.insertFails = true;
    await expect(notifyJobCrewAdded(job, [], ["larkspur"], "me")).resolves.toBeUndefined();
  });
});
