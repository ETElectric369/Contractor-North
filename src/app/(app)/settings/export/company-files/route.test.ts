import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb } from "@/test/fake-supabase";
import { unzip, text } from "@/test/unzip";
import { todayStrInTz } from "@/lib/tz";
import { fileNameFromDisposition } from "@/lib/download-name";
import { CROSS_SITE_WORDS, TOO_MANY_DOWNLOADS_WORDS } from "@/lib/export/door";
import { COMPANY_NO_FILES_WORDS, COMPANY_UNREAD_WORDS, FILES_UNLISTED_WORDS } from "@/lib/export-files/words";

/**
 * THE COMPANY'S OWN FILES AS A ZIP (cn-v1138): the owner only, before any read; then no cross-site
 * fetch and ten downloads an hour; every folder walked under the company's own prefix (the visits'
 * folders among them); a walk or a row read that fails refuses in words and is filed; no files; the
 * cap; a failed object → no zip and the counts; the zip read back sorted into its folders, named for
 * the company and its today, with one audit row. Every name here is invented.
 */
const ORG = "org-1";
const TZ = "America/Los_Angeles";

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

vi.mock("@/lib/export/guard", () => ({ requireOwnerExport: vi.fn(async () => state.verdict) }));
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
    throw new Error("the company files route reads through the service client, named on every read");
  },
}));

import { GET, dynamic, maxDuration, runtime } from "./route";
import * as route from "./route";

/** The owner's own browser, from the Your Data card (same-origin); `site` is what Sec-Fetch-Site says. */
const get = (site: string | null = "same-origin") =>
  GET(new Request("https://app.example.test/settings/export/company-files", { headers: site ? { "sec-fetch-site": site } : {} }) as never);
const words = async (res: Response) => ({ status: res.status, type: res.headers.get("content-type"), body: await res.text() });

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
    employee_documents: [{ id: "e1", org_id: ORG, profile_id: "p1", name: "Driver License", file_url: `${ORG}/employees/p1/1727000000000-scan.pdf` }],
    profiles: [
      { id: "p1", org_id: ORG, full_name: "Thistlewood Catbird" },
      { id: "p2", org_id: ORG, full_name: "Snowbell Bayberry" },
      { id: "p3", org_id: "org-2", full_name: "Elsewhere" },
    ],
    organized_items: [{ id: "o1", org_id: ORG, title: "Bayberry Supply receipt", file_url: `${ORG}/organize/1727000000000-IMG_1.jpg` }],
    agent_audit_log: [],
  };
  state.objects = {
    documents: [
      { path: `${ORG}/employees/p1/1727000000000-scan.pdf`, size: 4, bytes: "scan" },
      { path: `${ORG}/employees/p2/1727000000001-w4.pdf`, size: 2, bytes: "w4" },
      { path: `${ORG}/insurance/1727000000000-policy.pdf`, size: 6, bytes: "policy" },
      { path: `${ORG}/organize/1727000000000-IMG_1.jpg`, size: 3, bytes: "rcp" },
      // Two visits: one on a job, one a lead's (no job yet); both are the company's.
      { path: `${ORG}/appointments/a1/1727000000002-visit.jpg`, size: 5, bytes: "visit" },
      { path: `${ORG}/appointments/a2/1727000000004-site-plan.pdf`, size: 9, bytes: "site plan" },
      { path: `${ORG}/ai-uploads/stash.pdf`, size: 9, bytes: "never" },
      { path: `${ORG}/bug-screenshots/shot.png`, size: 9, bytes: "never" },
      { path: `org-2/insurance/1727000000000-theirs.pdf`, size: 9, bytes: "never" },
    ],
    "intake-uploads": [{ path: `${ORG}/intake/plans.pdf`, size: 5, bytes: "plans" }],
    branding: [
      { path: `${ORG}/logo-1727000000000.png`, size: 4, bytes: "logo" },
      { path: `${ORG}/avatars/u1-1727000000000.jpg`, size: 2, bytes: "av" },
    ],
    "lead-uploads": [{ path: `${ORG}/1727000000000-9b2c.jpg`, size: 4, bytes: "lead" }],
  };
});

describe("who may, before any read", () => {
  it("a non-owner gets the guard's words and status; not one row or folder is read, and nothing is counted", async () => {
    state.verdict = { ok: false, status: 403, words: "Ask Larkspur to download the company's data." };
    expect(await words(await get())).toEqual({ status: 403, type: "text/plain; charset=utf-8", body: "Ask Larkspur to download the company's data." });
    expect(state.reads).toEqual([]);
    expect(state.lists).toEqual([]);
    expect(state.limits).toEqual([]);
  });

  it("a cross-site fetch is refused after the guard, before any read or count; same-origin, same-site and a bare navigation pass", async () => {
    expect(await words(await get("cross-site"))).toEqual({ status: 403, type: "text/plain; charset=utf-8", body: CROSS_SITE_WORDS });
    expect(state.reads).toEqual([]);
    expect(state.lists).toEqual([]);
    expect(state.limits).toEqual([]);
    for (const site of ["same-origin", "same-site", "none", null]) expect((await get(site)).status, String(site)).toBe(200);
  });

  it("the company's downloads are counted (ten an hour, one key for the three doors); the eleventh is refused before any read", async () => {
    await get();
    expect(state.limits).toEqual([[`export:${ORG}`, 10, 3600]]);
    state.reads = [];
    state.lists = [];
    state.downloads = [];
    state.limited = true;
    expect(await words(await get())).toEqual({ status: 429, type: "text/plain; charset=utf-8", body: TOO_MANY_DOWNLOADS_WORDS });
    expect(state.reads).toEqual([]);
    expect(state.lists).toEqual([]);
    expect(state.downloads).toEqual([]);
  });

  it("reads no subscription state: a lapsed owner takes their data out", () => {
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(src).not.toContain("@/lib/subscription");
    expect(src).not.toContain("accessState");
  });
});

describe("the reads", () => {
  it("a company read that fails refuses in words, filed, and walks nothing", async () => {
    state.failTable = "organizations";
    expect(await words(await get())).toEqual({ status: 503, type: "text/plain; charset=utf-8", body: COMPANY_UNREAD_WORDS });
    expect(state.lists).toEqual([]);
    expect(state.errors).toEqual([["export:company-files:company", { message: "boom" }, { orgId: ORG }]]);
  });

  it("no service key is a refusal in words, filed, not a crash", async () => {
    state.serviceThrows = true;
    expect(await words(await get())).toEqual({ status: 503, type: "text/plain; charset=utf-8", body: COMPANY_UNREAD_WORDS });
    expect(state.errors).toEqual([["export:company-files:service", expect.any(Error), { orgId: ORG }]]);
    expect(state.reads).toEqual([]);
  });

  it("a row read or any one folder walk that fails (the visits' among them) refuses in words, filed; nothing is downloaded", async () => {
    state.failTable = "organized_items";
    expect(await words(await get())).toEqual({ status: 503, type: "text/plain; charset=utf-8", body: FILES_UNLISTED_WORDS });
    expect(state.errors).toEqual([["export:company-files:list", { message: "boom" }, { orgId: ORG }]]);
    state.failTable = null;
    state.errors = [];
    state.failList = `branding:${ORG}`;
    expect(await (await get()).text()).toBe(FILES_UNLISTED_WORDS);
    expect(state.errors).toEqual([["export:company-files:list", { message: "boom" }, { orgId: ORG }]]);
    state.errors = [];
    state.failList = `documents:${ORG}/appointments/a2`;
    expect(await (await get()).text()).toBe(FILES_UNLISTED_WORDS);
    expect(state.errors).toEqual([["export:company-files:list", { message: "boom" }, { orgId: ORG }]]);
    expect(state.downloads).toEqual([]);
  });

  it("walks exactly the company's own folders: employees, insurance, organize, intake, the visits, branding, lead uploads — never ai-uploads or bug-screenshots", async () => {
    await get();
    const roots = [
      `branding:${ORG}`,
      `documents:${ORG}/employees`,
      `documents:${ORG}/insurance`,
      `documents:${ORG}/organize`,
      `documents:${ORG}/appointments`,
      `intake-uploads:${ORG}/intake`,
      `lead-uploads:${ORG}`,
    ];
    expect(state.lists).toEqual(expect.arrayContaining(roots));
    expect(state.lists.filter((l) => /ai-uploads|bug-screenshots|org-2/.test(l))).toEqual([]);
    // The folders below a root were walked too (a person's folder, each visit's, the avatars), and nothing else.
    const below = state.lists.filter((l) => !roots.includes(l)).sort();
    expect(below).toEqual([
      `branding:${ORG}/avatars`,
      `documents:${ORG}/appointments/a1`,
      `documents:${ORG}/appointments/a2`,
      `documents:${ORG}/employees/p1`,
      `documents:${ORG}/employees/p2`,
    ]);
  });
});

describe("the files", () => {
  it("no files: 404 in words", async () => {
    state.tables.employee_documents = [];
    state.tables.organized_items = [];
    state.objects = {};
    expect(await words(await get())).toEqual({ status: 404, type: "text/plain; charset=utf-8", body: COMPANY_NO_FILES_WORDS });
    expect(COMPANY_NO_FILES_WORDS).toBe("The company has no files yet.");
  });

  it("too big by the known sizes: 413 naming the support address, before a byte is downloaded", async () => {
    state.objects.branding[0].size = 400 * 1024 * 1024;
    expect(await words(await get())).toEqual({ status: 413, type: "text/plain; charset=utf-8", body: "Too big to pack here. Write to support@contractornorth.com." });
    expect(state.downloads).toEqual([]);
  });

  it("one object that could not be read: 503 with the real counts, filed, no zip, no audit row", async () => {
    state.objects["lead-uploads"][0].fail = true;
    expect(await words(await get())).toEqual({ status: 503, type: "text/plain; charset=utf-8", body: "1 of 10 files could not be read. Nothing was made. Try again." });
    expect(state.inserted.agent_audit_log ?? []).toEqual([]);
    expect(state.errors).toEqual([["export:company-files:pack", expect.objectContaining({ message: "1 of 10 objects could not be read" }), { orgId: ORG }]]);
  });

  it("success: a streamed zip named for the company and its today, sorted into folders (each visit its own under Visits), and one audit row", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fileNameFromDisposition(res.headers.get("content-disposition"))).toBe(`Larkspur Electric-files-${todayStrInTz(TZ)}.zip`);
    const entries = unzip(new Uint8Array(await res.arrayBuffer()));
    expect(entries.map((e) => [e.name, text(e.data)])).toEqual([
      ["Employees/Thistlewood Catbird/Driver License.pdf", "scan"],
      ["Employees/Snowbell Bayberry/w4.pdf", "w4"],
      ["Insurance/policy.pdf", "policy"],
      ["Organized/Bayberry Supply receipt.jpg", "rcp"],
      ["Intake/plans.pdf", "plans"],
      ["Visits/a1/visit.jpg", "visit"],
      ["Visits/a2/site-plan.pdf", "site plan"],
      ["Branding/logo-1727000000000.png", "logo"],
      ["Branding/Avatars/u1-1727000000000.jpg", "av"],
      ["Lead Uploads/9b2c.jpg", "lead"],
    ]);
    expect(state.downloads.filter((d) => /ai-uploads|bug-screenshots|org-2/.test(d))).toEqual([]);
    expect(state.inserted.agent_audit_log).toEqual([
      expect.objectContaining({ org_id: ORG, user_id: "u-owner", action: "export.company_files", risk: 1, effect: "read", ok: true, source: "ui", input_summary: { files: 10, bytes: expect.any(Number) } }),
    ]);
    expect(state.errors).toEqual([]);
  });
});

describe("the route file", () => {
  it("exports only the handler and its segment config, with maxDuration after dynamic and the node runtime", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "maxDuration", "runtime"]);
    expect(dynamic).toBe("force-dynamic");
    expect(runtime).toBe("nodejs");
    expect(maxDuration).toBe(300);
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(src.indexOf("export const maxDuration = 300;")).toBeGreaterThan(src.indexOf('export const dynamic = "force-dynamic";'));
    expect(src).not.toMatch(/select\("\*"\)/);
    // Every row read names the company.
    expect(src.match(/\.from\("(employee_documents|profiles|organized_items)"\)[^\n]*\.eq\("org_id", orgId\)/g)).toHaveLength(3);
    // The door's two checks come right after the guard; the service client is made inside a try.
    expect(src.indexOf("exportDoorRefusal(req, orgId)")).toBeGreaterThan(src.indexOf("requireOwnerExport()"));
    expect(src.indexOf("exportDoorRefusal(req, orgId)")).toBeLessThan(src.indexOf("createServiceClient()"));
    expect(src).toContain("svc = createServiceClient();\n  } catch (e) {");
  });
});
