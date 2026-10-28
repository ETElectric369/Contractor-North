import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE ONE OWNER READ (skeptic #43, S12). ownerFirstName is what every paused door — the refusal's
 * "Ask Larkspur to pick a plan.", /subscribe's subline, the Settings plan card for the office and
 * the crew — asks for the owner's name: the service client (a tech's RLS may not see the owner's
 * row), the company's active owner, one row, the first word of the name. It never throws: a failed
 * read is filed under lapse-words:owner-read and reads "the owner".
 */
const db = vi.hoisted(() => ({
  owner: null as Record<string, unknown> | null,
  error: null as { message: string } | null,
  throws: false,
  reads: [] as { table: string; cols: string; filters: unknown[][]; limit: number | null }[],
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => {
  const from = (table: string) => {
    const q = { table, cols: "", filters: [] as unknown[][], limit: null as number | null };
    db.reads.push(q);
    const b: any = {
      select(cols: string) {
        q.cols = cols;
        return b;
      },
      eq(...a: unknown[]) {
        q.filters.push(["eq", ...a]);
        return b;
      },
      limit(n: number) {
        q.limit = n;
        return b;
      },
      async maybeSingle() {
        if (db.throws) throw new Error("connection reset");
        return { data: db.error ? null : db.owner, error: db.error };
      },
    };
    return b;
  };
  const client = { from };
  return { createClient: async () => client, createServiceClient: () => client };
});

import { ownerFirstName } from "./lapse-words";
import { reportError } from "@/lib/observe";

const ORG = "6f1c2a3e-9b4d-4c5e-8f6a-1b2c3d4e5f60";

beforeEach(() => {
  db.owner = null;
  db.error = null;
  db.throws = false;
  db.reads.length = 0;
  vi.mocked(reportError).mockClear();
});

describe("ownerFirstName", () => {
  it("the company's active owner's first name, one row, on the service client", async () => {
    db.owner = { full_name: "  Larkspur Snowbell " };
    expect(await ownerFirstName(ORG)).toBe("Larkspur");
    expect(db.reads).toHaveLength(1);
    expect(db.reads[0]).toEqual({
      table: "profiles",
      cols: "full_name",
      filters: [["eq", "org_id", ORG], ["eq", "role", "owner"], ["eq", "active", true]],
      limit: 1,
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("no active owner, or a blank name: null — the words then say 'the owner'", async () => {
    expect(await ownerFirstName(ORG)).toBeNull();
    db.owner = { full_name: "   " };
    expect(await ownerFirstName(ORG)).toBeNull();
    db.owner = { full_name: null };
    expect(await ownerFirstName(ORG)).toBeNull();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a name is cut at 40 characters, never a paragraph in a sentence", async () => {
    db.owner = { full_name: "X".repeat(60) };
    expect(await ownerFirstName(ORG)).toBe("X".repeat(40));
  });

  it("no company: null without a read", async () => {
    expect(await ownerFirstName(null)).toBeNull();
    expect(await ownerFirstName(undefined)).toBeNull();
    expect(await ownerFirstName("")).toBeNull();
    expect(db.reads).toHaveLength(0);
  });

  it("a read that answered an error, or that threw: null, and the failure is filed with the company — never thrown through", async () => {
    db.error = { message: "permission denied for table profiles" };
    expect(await ownerFirstName(ORG)).toBeNull();
    expect(reportError).toHaveBeenCalledWith("lapse-words:owner-read", db.error, { orgId: ORG });
    db.error = null;
    db.throws = true;
    expect(await ownerFirstName(ORG)).toBeNull();
    expect(reportError).toHaveBeenLastCalledWith("lapse-words:owner-read", expect.objectContaining({ message: "connection reset" }), { orgId: ORG });
  });
});
