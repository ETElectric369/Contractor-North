import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb } from "@/test/fake-supabase";
import { unzip, text } from "@/test/unzip";
import { todayStrInTz } from "@/lib/tz";
import { fileNameFromDisposition } from "@/lib/download-name";
import { OWNER_ONLY_WORDS } from "@/lib/export/guard";
import { CROSS_SITE_WORDS, TOO_MANY_DOWNLOADS_WORDS } from "@/lib/export/door";
import { COMPANY_UNREAD_WORDS, FILES_UNLISTED_WORDS, JOB_NOT_HERE_WORDS, JOB_NO_FILES_WORDS } from "@/lib/export-files/words";

/**
 * ONE JOB'S FILES AS A ZIP (cn-v1138): the owner only, before any read; then no cross-site fetch
 * and ten downloads an hour; a job of another company "isn't here"; the cap in words; no files; a
 * failed object → no zip and the counts; the zip read back with its name and one audit row; every
 * failure of North's own filed. The guard, the service client, the limiter and the error sink are
 * fakes; the storage fake lists a folder one level at a time the way Supabase does. Every name and
 * street here is invented.
 */
const ORG = "org-1";
const JOB = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB = "22222222-2222-4222-8222-222222222222";
const TZ = "America/Los_Angeles";

type Obj = { path: string; size?: number; bytes?: string; fail?: boolean };

const state = vi.hoisted(() => ({
  verdict: { ok: true, orgId: "org-1", profileId: "u-owner" } as Record<string, unknown>,
  tables: {} as Record<string, Record<string, unknown>[]>,
  objects: {} as Record<string, { path: string; size?: number; bytes?: string; fail?: boolean }[]>,
  failTable: null as string | null,
  failList: null as string | null,
  serviceThrows: false,
  limited: false,
  limits: [] as [string, number, number][],
  reads: [] as string[],
  lists: [] as string[],
  downloads: [] as string[],
  inserted: {} as Record<string, Record<string, unknown>[]>,
  errors: [] as unknown[][],
}));

vi.mock("@/lib/export/guard", () => ({
  requireOwnerExport: vi.fn(async () => state.verdict),
  OWNER_ONLY_WORDS: "Ask the owner to download the company's data.",
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn((...a: unknown[]) => state.errors.push(a)) }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimited: vi.fn(async (key: string, limit: number, window: number) => {
    state.limits.push([key, limit, window]);
    return state.limited;
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => {
    if (state.serviceThrows) throw new Error("no service key");
    const db = fakeDb(state.tables);
    state.inserted = db.inserted;
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
      storage: {
        from: (bucket: string) => {
          const all = state.objects[bucket] ?? [];
          return {
            list: async (prefix: string, { limit, offset }: { limit: number; offset: number }) => {
              state.lists.push(`${bucket}:${prefix}`);
              if (state.failList === `${bucket}:${prefix}`) return { data: null, error: { message: "boom" } };
              const head = prefix ? `${prefix}/` : "";
              const entries = new Map<string, unknown>();
              for (const o of all) {
                if (!o.path.startsWith(head)) continue;
                const rest = o.path.slice(head.length);
                const slash = rest.indexOf("/");
                if (slash < 0) entries.set(rest, { name: rest, id: `id-${o.path}`, metadata: { size: o.size ?? null } });
                else if (!entries.has(rest.slice(0, slash))) entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null });
              }
              return { data: Array.from(entries.values()).slice(offset, offset + limit), error: null };
            },
            download: async (path: string) => {
              state.downloads.push(`${bucket}:${path}`);
              const o = all.find((x) => x.path === path);
              if (!o || o.fail) return { data: null, error: { message: "Object not found" } };
              return { data: new Blob([new TextEncoder().encode(o.bytes ?? "")]), error: null };
            },
          };
        },
      },
    };
  },
  createClient: async () => {
    throw new Error("the job files route reads through the service client, named on every read");
  },
}));

import { GET, dynamic, maxDuration, runtime } from "./route";
import * as route from "./route";

const inJob = (file: string) => `${ORG}/${JOB}/${file}`;
const inVisit = (file: string) => `${ORG}/appointments/a1/${file}`;
/** The owner's own browser, from the Your Data card (same-origin); `site` is what Sec-Fetch-Site says. */
const get = (id: string = JOB, site: string | null = "same-origin") =>
  GET(new Request(`https://app.example.test/settings/export/job/${id}`, { headers: site ? { "sec-fetch-site": site } : {} }) as never, { params: Promise.resolve({ id }) });

beforeEach(() => {
  state.verdict = { ok: true, orgId: ORG, profileId: "u-owner" };
  state.failTable = null;
  state.failList = null;
  state.serviceThrows = false;
  state.limited = false;
  state.limits = [];
  state.reads = [];
  state.lists = [];
  state.downloads = [];
  state.errors = [];
  delete process.env.SUPPORT_EMAIL;
  state.tables = {
    organizations: [{ id: ORG, name: "Larkspur Electric", settings: { timezone: TZ } }],
    jobs: [
      { id: JOB, org_id: ORG, job_number: "J-047", name: "41 Snowbell Lane", customers: { name: "Bayberry Homes", company_name: null } },
      { id: OTHER_JOB, org_id: "org-2", job_number: "J-002", name: "9 Elsewhere", customers: null },
    ],
    documents: [{ id: "d1", org_id: ORG, job_id: JOB, name: "Panel before", file_url: inJob("1727000000000-img1.jpg"), size_bytes: null }],
    tasks: [{ id: "t1", org_id: ORG, job_id: JOB, photo_path: inJob("1727000000000-img1.jpg"), done_photo_path: inJob("1727000000001-img2.jpg") }],
    appointments: [
      {
        id: "a1",
        org_id: ORG,
        job_id: JOB,
        capture: { photos: [inVisit("1727000000002-visit.jpg")] },
        // The inspection sheet: a file slot's keys; a note slot with a slash is words, not a file.
        inspection_answers: { plans: [inVisit("1727000000004-site-plan.pdf")], conduit: "3/4 EMT" },
      },
    ],
    job_picks: [{ id: "k1", org_id: ORG, job_id: JOB, file_path: `${ORG}/picks/${JOB}/swatch.png` }],
    agent_audit_log: [],
  };
  state.objects = {
    documents: [
      { path: inJob("1727000000000-img1.jpg"), size: 5, bytes: "img-1" },
      { path: inJob("1727000000001-img2.jpg"), size: 5, bytes: "img-2" },
      { path: inJob("1727000000003-plans.pdf"), size: 8, bytes: "plans!!!" },
      { path: inVisit("1727000000002-visit.jpg"), size: 5, bytes: "visit" },
      { path: inVisit("1727000000004-site-plan.pdf"), size: 9, bytes: "site plan" },
      // In the visit's folder with no row pointing at it (a slot answer that did not save): walked in.
      { path: inVisit("1727000000005-meter.jpg"), size: 5, bytes: "meter" },
      { path: `${ORG}/picks/${JOB}/swatch.png`, size: 6, bytes: "swatch" },
    ],
  };
});

const words = async (res: Response) => ({ status: res.status, type: res.headers.get("content-type"), body: await res.text() });

describe("who may, before any read", () => {
  it("a non-owner gets the guard's words and status, and not one row or folder is read", async () => {
    state.verdict = { ok: false, status: 403, words: "Ask Larkspur to download the company's data." };
    expect(await words(await get())).toEqual({ status: 403, type: "text/plain; charset=utf-8", body: "Ask Larkspur to download the company's data." });
    state.verdict = { ok: false, status: 401, words: "Sign in to download the company's data." };
    expect((await get()).status).toBe(401);
    state.verdict = { ok: false, status: 403, words: OWNER_ONLY_WORDS };
    expect(await (await get()).text()).toBe(OWNER_ONLY_WORDS);
    expect(state.reads).toEqual([]);
    expect(state.lists).toEqual([]);
    expect(state.limits).toEqual([]);
  });

  it("a cross-site fetch is refused after the guard, before any read or count; same-origin, same-site and a bare navigation pass", async () => {
    expect(await words(await get(JOB, "cross-site"))).toEqual({ status: 403, type: "text/plain; charset=utf-8", body: CROSS_SITE_WORDS });
    expect(state.reads).toEqual([]);
    expect(state.limits).toEqual([]);
    for (const site of ["same-origin", "same-site", "none", null]) expect((await get(JOB, site)).status, String(site)).toBe(200);
  });

  it("the company's downloads are counted (ten an hour, keyed on the company, the same key as the other export doors); the eleventh is refused before any read", async () => {
    await get();
    expect(state.limits).toEqual([[`export:${ORG}`, 10, 3600]]);
    state.reads = [];
    state.downloads = [];
    state.limited = true;
    expect(await words(await get())).toEqual({ status: 429, type: "text/plain; charset=utf-8", body: TOO_MANY_DOWNLOADS_WORDS });
    expect(state.reads).toEqual([]);
    expect(state.downloads).toEqual([]);
  });

  it("reads no subscription state: a lapsed owner takes their data out", () => {
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(src).not.toContain("@/lib/subscription");
    expect(src).not.toContain("accessState");
  });
});

describe("the job", () => {
  it("a job of another company, or none, 'isn't here' — the same 404 words, so a stranger learns nothing", async () => {
    expect(await words(await get(OTHER_JOB))).toEqual({ status: 404, type: "text/plain; charset=utf-8", body: JOB_NOT_HERE_WORDS });
    expect(await (await get("33333333-3333-4333-8333-333333333333")).text()).toBe(JOB_NOT_HERE_WORDS);
    expect(state.downloads).toEqual([]);
    expect(JOB_NOT_HERE_WORDS).toBe("That job isn't here.");
  });

  it("an id that is not a uuid is 'not here' before the service client reads anything", async () => {
    expect((await get("J-047")).status).toBe(404);
    expect(state.reads).toEqual([]);
  });

  it("a company read that fails, or a job read that fails, refuses in words, makes nothing, and files the failure", async () => {
    state.failTable = "organizations";
    expect(await words(await get())).toEqual({ status: 503, type: "text/plain; charset=utf-8", body: COMPANY_UNREAD_WORDS });
    expect(state.errors).toEqual([["export:job-files:company", { message: "boom" }, { orgId: ORG }]]);
    state.errors = [];
    state.failTable = "jobs";
    expect(await (await get()).text()).toBe("This job couldn't be read just now. Nothing was made; try again.");
    expect(state.errors).toEqual([["export:job-files:job", { message: "boom" }, { orgId: ORG, jobId: JOB }]]);
    expect(state.downloads).toEqual([]);
  });

  it("no service key is a refusal in words, filed, not a crash", async () => {
    state.serviceThrows = true;
    expect(await words(await get())).toEqual({ status: 503, type: "text/plain; charset=utf-8", body: COMPANY_UNREAD_WORDS });
    expect(state.errors).toEqual([["export:job-files:service", expect.any(Error), { orgId: ORG }]]);
    expect(state.reads).toEqual([]);
  });
});

describe("the files", () => {
  it("no files: 404 in words", async () => {
    state.tables.documents = [];
    state.tables.tasks = [];
    state.tables.appointments = [];
    state.tables.job_picks = [];
    state.objects.documents = [];
    expect(await words(await get())).toEqual({ status: 404, type: "text/plain; charset=utf-8", body: JOB_NO_FILES_WORDS });
    expect(JOB_NO_FILES_WORDS).toBe("This job has no files yet.");
  });

  it("a pointer read, the job folder's walk or a visit folder's walk that fails refuses in words, filed; nothing partial is packed", async () => {
    state.failTable = "tasks";
    expect(await words(await get())).toEqual({ status: 503, type: "text/plain; charset=utf-8", body: FILES_UNLISTED_WORDS });
    expect(state.errors).toEqual([["export:job-files:list", { message: "boom" }, { orgId: ORG, jobId: JOB }]]);
    state.failTable = null;
    state.errors = [];
    state.failList = `documents:${ORG}/${JOB}`;
    expect(await (await get()).text()).toBe(FILES_UNLISTED_WORDS);
    expect(state.errors).toEqual([["export:job-files:list", { message: "boom" }, { orgId: ORG, jobId: JOB }]]);
    state.errors = [];
    state.failList = `documents:${ORG}/appointments/a1`;
    expect(await (await get()).text()).toBe(FILES_UNLISTED_WORDS);
    expect(state.errors).toEqual([["export:job-files:list", { message: "boom" }, { orgId: ORG, jobId: JOB }]]);
    expect(state.downloads).toEqual([]);
  });

  it("too big by the known sizes: 413 naming the support address, by its env name first, before a byte is downloaded", async () => {
    state.objects.documents[2].size = 400 * 1024 * 1024 + 1;
    expect(await words(await get())).toEqual({ status: 413, type: "text/plain; charset=utf-8", body: "Too big to pack here. Write to support@contractornorth.com." });
    process.env.SUPPORT_EMAIL = "help@larkspur.test";
    expect(await (await get()).text()).toBe("Too big to pack here. Write to help@larkspur.test.");
    expect(state.downloads).toEqual([]);
  });

  it("one object that could not be read: 503 with the real counts, filed, no zip, no audit row", async () => {
    state.objects.documents[3].fail = true;
    expect(await words(await get())).toEqual({ status: 503, type: "text/plain; charset=utf-8", body: "1 of 7 files could not be read. Nothing was made. Try again." });
    expect(state.inserted.agent_audit_log ?? []).toEqual([]);
    expect(state.errors).toEqual([["export:job-files:pack", expect.objectContaining({ message: "1 of 7 objects could not be read" }), { orgId: ORG, jobId: JOB }]]);
  });

  it("success: a streamed zip named for the job and the company's today, every file under its name — the visit's photos, sheet files and folder included — and one audit row", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-length")).toBeNull();
    const today = todayStrInTz(TZ);
    expect(fileNameFromDisposition(res.headers.get("content-disposition"))).toBe(`41 Snowbell Lane · J-047 — Bayberry Homes-files-${today}.zip`);
    const entries = unzip(new Uint8Array(await res.arrayBuffer()));
    expect(entries.map((e) => [e.name, text(e.data)])).toEqual([
      ["Panel before.jpg", "img-1"],
      ["img2.jpg", "img-2"],
      ["plans.pdf", "plans!!!"],
      ["visit.jpg", "visit"],
      ["site-plan.pdf", "site plan"],
      ["meter.jpg", "meter"],
      ["swatch.png", "swatch"],
    ]);
    expect(state.downloads).toHaveLength(7);
    // The job's own folder and each visit's folder were walked; the sheet's note slot is no path.
    expect(state.lists).toEqual([`documents:${ORG}/${JOB}`, `documents:${ORG}/appointments/a1`]);
    expect(state.downloads.join("\n")).not.toContain("3/4 EMT");
    expect(state.inserted.agent_audit_log).toEqual([
      expect.objectContaining({
        org_id: ORG,
        user_id: "u-owner",
        action: "export.job_files",
        risk: 1,
        effect: "read",
        ok: true,
        source: "ui",
        input_summary: { job_id: JOB, files: 7, bytes: expect.any(Number) },
      }),
    ]);
    // Every pointer read named the company.
    expect(state.reads).toEqual(expect.arrayContaining(["organizations", "jobs", "documents", "tasks", "appointments", "job_picks", "agent_audit_log"]));
    expect(state.errors).toEqual([]);
  });

  it("a failed audit insert is filed and never stops the download", async () => {
    state.failTable = "agent_audit_log";
    const res = await get();
    expect(res.status).toBe(200);
    expect(state.errors).toEqual([["export-files:audit", { message: "boom" }, { orgId: ORG, action: "export.job_files" }]]);
  });
});

describe("the route file", () => {
  it("exports only the handler and its segment config, with maxDuration after dynamic and the node runtime", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "maxDuration", "runtime"]);
    expect(dynamic).toBe("force-dynamic");
    expect(runtime).toBe("nodejs");
    expect(maxDuration).toBe(300);
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(src).toContain('export const dynamic = "force-dynamic";');
    expect(src).toContain("export const maxDuration = 300;");
    expect(src.indexOf("export const maxDuration = 300;")).toBeGreaterThan(src.indexOf('export const dynamic = "force-dynamic";'));
    expect(src).not.toMatch(/select\("\*"\)/);
    // The door's two checks come right after the guard, before the id is even looked at; the service
    // client is made inside a try, and the visits' sheet files ride the appointments read.
    expect(src.indexOf("exportDoorRefusal(req, orgId)")).toBeGreaterThan(src.indexOf("requireOwnerExport()"));
    expect(src.indexOf("exportDoorRefusal(req, orgId)")).toBeLessThan(src.indexOf("UUID.test("));
    expect(src).toContain("svc = createServiceClient();\n  } catch (e) {");
    expect(src).toContain('select("id, capture, inspection_answers")');
  });
});
