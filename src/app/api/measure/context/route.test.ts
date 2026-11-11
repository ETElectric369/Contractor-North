import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WHO IS ON THE PHONE, AND THE JOB HE IS CLOCKED ON (cn-v1160): the one read Measure from the + makes,
 * a route and not a server action (Next sends one client's actions one at a time, and this read is
 * asked at every mount of the +). Pinned: it is the office's alone, refused with no words (the client
 * says its own); every read names the company (three share one database); no money column is read; a
 * punch with no job, no punch, and a punch on a job that is gone all answer "clocked on nothing"; a
 * clock read that FAILED still names who is on the phone and says `punchUnread`, never "not on the
 * clock". And the client's ask: its own sentence on any failure, in the reader's language.
 * Every id and name is invented.
 */

const state = vi.hoisted(() => ({ staff: null as any }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => state.staff) }));

const { POST } = await import("./route");
import { askMeasureContext, measureOwnerKey } from "@/lib/quick-measure";
import { translator } from "@/lib/i18n";

const ORG = "0a000000-0000-4000-8000-00000000c001";
const USER = "0d000000-0000-4000-8000-00000000f001";
const JOB = "0b000000-0000-4000-8000-00000000d001";

type Call = { table: string; cols?: string; eqs: [string, unknown][]; limit?: number; writes: string[] };
let calls: Call[];

/** A scriptable PostgREST fake that records every table, select list and .eq(). */
function fake(script: Record<string, { data: unknown; error: unknown }>) {
  return {
    from(table: string) {
      const mine: Call = { table, eqs: [], writes: [] };
      calls.push(mine);
      const chain: any = {
        select(cols?: string) { mine.cols = cols; return chain; },
        eq(col: string, val: unknown) { mine.eqs.push([col, val]); return chain; },
        limit(n: number) { mine.limit = n; return chain; },
        insert() { mine.writes.push("insert"); return chain; },
        update() { mine.writes.push("update"); return chain; },
        delete() { mine.writes.push("delete"); return chain; },
        maybeSingle: () => Promise.resolve(script[table] ?? { data: null, error: null }),
      };
      return chain;
    },
  };
}
const signIn = (script: Record<string, { data: unknown; error: unknown }>, orgId: string | null = ORG) => {
  state.staff = { supabase: fake(script), userId: USER, orgId, role: "owner" };
};
const ask = async () => {
  const res = await POST();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  calls = [];
});

describe("the office's alone", () => {
  it("a crew member, a signed-out page and a cut seat are refused with no words, and nothing is read", async () => {
    for (const error of ["This action is staff-only.", "Not signed in.", "This account has been deactivated."]) {
      state.staff = { error };
      expect(await ask()).toEqual({ status: 403, body: { ok: false } });
    }
    expect(calls).toEqual([]);
  });

  it("a sign-in with no company is refused before any read: nothing runs unscoped", async () => {
    signIn({}, null);
    expect(await ask()).toEqual({ status: 403, body: { ok: false } });
    expect(calls).toEqual([]);
  });
});

describe("on the clock on a job", () => {
  const onJob = () =>
    signIn({
      time_entries: { data: { job_id: JOB }, error: null },
      jobs: { data: { id: JOB, job_number: "J-047", name: "Larkspur" }, error: null },
    });

  it("answers who is on the phone and the job's id and label", async () => {
    onJob();
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, userId: USER, orgId: ORG, punchJob: { id: JOB, label: "J-047 · Larkspur" } });
  });

  it("EVERY READ NAMES THE COMPANY: the punch is this person's open one in this company, the job is that job in this company", async () => {
    onJob();
    await ask();
    expect(calls.map((c) => c.table)).toEqual(["time_entries", "jobs"]);
    for (const c of calls) expect(c.eqs, c.table).toContainEqual(["org_id", ORG]);
    expect(calls[0].eqs).toEqual([["org_id", ORG], ["profile_id", USER], ["status", "open"]]);
    expect(calls[0].limit).toBe(1);
    expect(calls[1].eqs).toEqual([["org_id", ORG], ["id", JOB]]);
    expect(calls.flatMap((c) => c.writes)).toEqual([]);
  });

  it("no money column is read: a punch's job id, and a job's number and name", async () => {
    onJob();
    await ask();
    expect(calls[0].cols).toBe("job_id");
    expect(calls[1].cols).toBe("id, job_number, name");
    for (const c of calls) expect(c.cols).not.toMatch(/\*|rate|cost|price|amount|total|pay|wage|budget|contract/i);
  });

  it("a job with a number and no name is labelled by its number; one with a name and no number by its name", async () => {
    signIn({ time_entries: { data: { job_id: JOB }, error: null }, jobs: { data: { id: JOB, job_number: "J-048", name: null }, error: null } });
    expect((await ask()).body).toMatchObject({ ok: true, punchJob: { id: JOB, label: "J-048" } });
    signIn({ time_entries: { data: { job_id: JOB }, error: null }, jobs: { data: { id: JOB, job_number: " ", name: "Snowbell" }, error: null } });
    expect((await ask()).body).toMatchObject({ ok: true, punchJob: { id: JOB, label: "Snowbell" } });
  });
});

describe("clocked on nothing a result can be saved to", () => {
  it("A PUNCH WITH NO JOB, or no punch at all: punchJob is null, and the jobs are never read", async () => {
    for (const data of [{ job_id: null }, null]) {
      calls = [];
      signIn({ time_entries: { data, error: null } });
      expect((await ask()).body).toEqual({ ok: true, userId: USER, orgId: ORG, punchJob: null });
      expect(calls.map((c) => c.table)).toEqual(["time_entries"]);
    }
  });

  it("a punch on a job that is gone, or one with nothing to call it by: no door is drawn with no name on it", async () => {
    signIn({ time_entries: { data: { job_id: JOB }, error: null }, jobs: { data: null, error: null } });
    expect((await ask()).body).toEqual({ ok: true, userId: USER, orgId: ORG, punchJob: null });
    signIn({ time_entries: { data: { job_id: JOB }, error: null }, jobs: { data: { id: JOB, job_number: "", name: "  " }, error: null } });
    expect((await ask()).body).toEqual({ ok: true, userId: USER, orgId: ORG, punchJob: null });
  });
});

describe("a clock read that failed still names who is on the phone, and says so", () => {
  it("the punch could not be read: who is here, no job, and punchUnread; the database's sentence never leaves", async () => {
    signIn({ time_entries: { data: null, error: { message: "connection reset" } } });
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, userId: USER, orgId: ORG, punchJob: null, punchUnread: true });
    expect(JSON.stringify(body)).not.toContain("connection reset");
  });

  it("the punch read, its job not: the same", async () => {
    signIn({ time_entries: { data: { job_id: JOB }, error: null }, jobs: { data: null, error: { message: "timeout" } } });
    expect((await ask()).body).toEqual({ ok: true, userId: USER, orgId: ORG, punchJob: null, punchUnread: true });
  });
});

describe("the client's ask (lib/quick-measure askMeasureContext)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });
  const answering = (status: number, body: unknown) => {
    const f = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    globalThis.fetch = f as unknown as typeof fetch;
    return f;
  };

  it("posts to the route with a signal, and hands on what it answered", async () => {
    const f = answering(200, { ok: true, userId: USER, orgId: ORG, punchJob: { id: JOB, label: "J-047 · Larkspur" } });
    const c = await askMeasureContext("no");
    expect(c).toEqual({ ok: true, userId: USER, orgId: ORG, punchJob: { id: JOB, label: "J-047 · Larkspur" } });
    expect(measureOwnerKey(c)).toBe(`${USER}:${ORG}`);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/measure/context");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("an unread clock comes through as said, with who is on the phone", async () => {
    answering(200, { ok: true, userId: USER, orgId: ORG, punchJob: null, punchUnread: true });
    expect(await askMeasureContext("no")).toEqual({ ok: true, userId: USER, orgId: ORG, punchJob: null, punchUnread: true });
  });

  it("a refusal, a broken answer and a dropped connection are each the reader's OWN sentence, and name nobody", async () => {
    const es = translator("es")("sh_checkSignal");
    answering(403, { ok: false });
    let c = await askMeasureContext(es);
    expect(c).toEqual({ ok: false, error: es });
    expect(measureOwnerKey(c)).toBeNull();
    answering(200, { ok: true });
    expect(await askMeasureContext(es)).toEqual({ ok: false, error: es });
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Load failed");
    }) as unknown as typeof fetch;
    c = await askMeasureContext(es);
    expect(c).toEqual({ ok: false, error: es });
  });

  it("gives up on its own timeout: the read never hangs on with no signal", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise((_ok, bad) => init.signal?.addEventListener("abort", () => bad(new DOMException("aborted", "AbortError")))),
    ) as unknown as typeof fetch;
    const asked = askMeasureContext("no", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await asked).toEqual({ ok: false, error: "no" });
  });
});

describe("the file, pinned", () => {
  const src = readFileSync(join(process.cwd(), "src/app/api/measure/context/route.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("a route file exports only its handler and its segment config", () => {
    const exported = src.split("\n").filter((l) => /^export\s/.test(l));
    expect(exported).toEqual(['export const runtime = "nodejs";', "export async function POST() {"]);
  });

  it("guards with requireStaff before anything else, and every table it reads is read with the company named", () => {
    const body = code.slice(code.indexOf("export async function POST"));
    expect(body.indexOf("await requireStaff()")).toBeGreaterThan(-1);
    expect(body.indexOf("await requireStaff()")).toBeLessThan(body.indexOf(".from("));
    const reads = code.match(/\.from\("[a-z_]+"\)[^;]*;/g) ?? [];
    expect(reads.map((r) => /\.from\("([a-z_]+)"\)/.exec(r)![1])).toEqual(["time_entries", "jobs"]);
    for (const r of reads) expect(r, r).toContain('.eq("org_id", orgId)');
    expect(code).not.toMatch(/createAdminClient|service_role|createServiceClient/);
    expect(code).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
  });

  it("the sentence the sheet says for an unread clock names the button it draws under it, in both languages", () => {
    for (const lang of ["en", "es"]) {
      const t = translator(lang);
      expect(t("sh_measure_clockUnread")).toContain(t("sh_tryAgain"));
      expect(t("sh_measure_clockUnread")).not.toBe("sh_measure_clockUnread");
    }
  });
});
