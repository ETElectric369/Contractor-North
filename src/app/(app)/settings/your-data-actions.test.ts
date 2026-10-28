import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb } from "@/test/fake-supabase";
import { JOB_LIST_UNREAD_WORDS } from "@/lib/export-files/jobs-with-files";

/**
 * THE NEXT PAGE OF FILES BY JOB (cn-v1138): the owner only (the one export guard, so a lapsed owner
 * passes and everyone else gets the guard's words), the next fifty from the offset, newest first,
 * and a failed read said in words and filed. Every name here is invented.
 */
const state = vi.hoisted(() => ({
  verdict: { ok: true, orgId: "org-1", profileId: "u-owner" } as Record<string, unknown>,
  tables: {} as Record<string, Record<string, unknown>[]>,
  failTable: null as string | null,
  reads: [] as string[],
  errors: [] as unknown[][],
}));

vi.mock("@/lib/export/guard", () => ({ requireOwnerExport: vi.fn(async () => state.verdict) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn((...a: unknown[]) => state.errors.push(a)) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("the list reads on the service client behind the owner guard (0366 revokes the answers column from the signed-in role)");
  },
  createServiceClient: () => {
    const db = fakeDb(state.tables);
    const failing = () => {
      const b: Record<string, unknown> = new Proxy(
        {},
        { get: (_t, k) => (k === "then" ? (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: "boom" } }) : () => b) },
      );
      return b;
    };
    return {
      from: (table: string) => {
        state.reads.push(table);
        return table === state.failTable ? failing() : db.sb.from(table);
      },
    };
  },
}));

import { listJobsWithFiles } from "./your-data-actions";

const ORG = "org-1";

beforeEach(() => {
  state.verdict = { ok: true, orgId: ORG, profileId: "u-owner" };
  state.failTable = null;
  state.reads = [];
  state.errors = [];
  const jobs: Record<string, unknown>[] = [];
  const documents: Record<string, unknown>[] = [];
  for (let i = 0; i < 52; i++) {
    const id = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
    jobs.push({
      id,
      org_id: ORG,
      job_number: `J-${String(i).padStart(3, "0")}`,
      name: `${i} Larkspur Way`,
      created_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      customers: { name: "Snowbell Homes", company_name: null },
    });
    documents.push({ id: `d${i}`, org_id: ORG, job_id: id, file_url: `${ORG}/${id}/1-a.jpg` });
  }
  state.tables = { jobs, documents, tasks: [], appointments: [], job_picks: [] };
});

describe("listJobsWithFiles", () => {
  it("a non-owner gets the guard's words and no read", async () => {
    state.verdict = { ok: false, status: 403, words: "Ask Larkspur to download the company's data." };
    expect(await listJobsWithFiles(50)).toEqual({ error: "Ask Larkspur to download the company's data." });
    expect(state.reads).toEqual([]);
  });

  it("the owner gets the next page from the offset, newest first, with the total", async () => {
    const got = await listJobsWithFiles(50);
    expect(got).toEqual({
      ok: true,
      total: 52,
      rows: [
        { id: "00000001-0000-4000-8000-000000000000", label: "1 Larkspur Way · J-001 — Snowbell Homes", files: 1 },
        { id: "00000000-0000-4000-8000-000000000000", label: "0 Larkspur Way · J-000 — Snowbell Homes", files: 1 },
      ],
    });
    const first = await listJobsWithFiles(0);
    if (!("ok" in first)) throw new Error(first.error);
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0].label).toBe("51 Larkspur Way · J-051 — Snowbell Homes");
  });

  it("a bad offset is the first page, never a throw", async () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, 3.7]) {
      const got = await listJobsWithFiles(bad);
      if (!("ok" in got)) throw new Error(got.error);
      expect(got.total).toBe(52);
      expect(got.rows[0].label).toBe(bad === 3.7 ? "48 Larkspur Way · J-048 — Snowbell Homes" : "51 Larkspur Way · J-051 — Snowbell Homes");
    }
  });

  it("past the end is an empty page with the total, not an error", async () => {
    expect(await listJobsWithFiles(500)).toEqual({ ok: true, rows: [], total: 52 });
  });

  it("a failed read is said in words and filed; nothing partial comes back", async () => {
    state.failTable = "job_picks";
    expect(await listJobsWithFiles(0)).toEqual({ error: JOB_LIST_UNREAD_WORDS });
    expect(state.errors).toEqual([["your-data:list-jobs-with-files", { message: "boom" }, { orgId: ORG, offset: 0 }]]);
  });
});
