import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzip, text } from "@/test/unzip";
import { EXPORT_TABLES, COMPANY_TABLE, TRAIL_MAX_PAGES } from "@/lib/export/registry";
import { csvEntryName } from "@/lib/export/records-zip";
import { CROSS_SITE_WORDS, TOO_MANY_DOWNLOADS_WORDS } from "@/lib/export/door";

/**
 * THE RECORDS DOWNLOAD IS THE OWNER'S. requireOwnerExport is the refusal: anyone it turns away gets
 * their status and words, and not one row is read (the service client is never even made); after
 * the guard, a cross-site fetch and an eleventh download in the hour are refused the same way. A
 * read that doesn't come back whole refuses the file, in words, naming the table in its README
 * words (never a raw table name); a list past the cap is refused with the support address. The
 * owner's download is the zip, named after the company and the day on its clock, streamed, and one
 * agent_audit_log row says it happened. Every name here is invented (Larkspur, Snowbell, Bayberry,
 * Thistlewood, Catbird).
 */
const ORG = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const PUBLIC = "https://xyz.supabase.co/storage/v1/object/public";

type Verdict = { ok: true; orgId: string; profileId: string } | { ok: false; status: number; words: string };

const state: {
  verdict: Verdict;
  failing: string[];
  capped: string[];
  orgRow: Record<string, unknown> | null;
  orgError: unknown;
  auditError: unknown;
  serviceThrows: boolean;
  reads: { table: string; select: string; eq: [string, unknown][]; order: string[]; ranges: [number, number][] }[];
  inserts: { table: string; row: Record<string, unknown> }[];
  made: number;
  limited: boolean;
  limits: [string, number, number][];
} = { verdict: { ok: true, orgId: ORG, profileId: OWNER }, failing: [], capped: [], orgRow: null, orgError: null, auditError: null, serviceThrows: false, reads: [], inserts: [], made: 0, limited: false, limits: [] };

const rows = (): Record<string, Record<string, unknown>[]> => ({
  profiles: [{ id: "p1", full_name: "Snowbell Owner", role: "owner", active: true, avatar_url: `${PUBLIC}/branding/${ORG}/avatar-p1.jpg`, push_prefs: { nudge: true } }],
  jobs: [{ id: "j1", job_number: "J-012", name: "Thistlewood panel", notes: "=HYPERLINK(\"x\")" }],
  documents: [{ id: "d1", name: "plans.pdf", file_url: `${ORG}/jobs/j1/plans.pdf`, job_id: "j1" }],
  tasks: [{ id: "t1", job_id: "j1", title: "Hang the fixture", photo_path: `${ORG}/jobs/j1/before.jpg` }],
  appointments: [
    {
      id: "a1",
      job_id: "j1",
      capture: { photos: [`${ORG}/appointments/a1/1.jpg`] },
      // The inspection sheet: a file slot holds keys; a note slot with a slash in it is words, not a file.
      inspection_answers: { plans: [`${ORG}/appointments/a1/2-plan.pdf`], conduit: "3/4 EMT", count: 2 },
    },
  ],
  tax_rates: [{ id: "x1", name: "Catbird County", rate: 7.25, is_default: true }],
});

const orgRow = (): Record<string, unknown> => ({
  id: ORG,
  name: "Larkspur Électrique",
  logo_url: `${PUBLIC}/branding/${ORG}/logo.png`,
  plan: "pro",
  settings: { timezone: "America/Denver", lead_inbound_secret: "shh-never" },
});

/** A PostgREST-builder fake: every filter method returns the builder and records itself; a page
 *  past the first is empty (a capped table answers a full page every time); maybeSingle answers
 *  the company; a table in `failing` answers an error; insert records its row. */
function client() {
  return {
    from(table: string) {
      const read = { table, select: "", eq: [] as [string, unknown][], order: [] as string[], ranges: [] as [number, number][] };
      state.reads.push(read);
      let from = 0;
      let insertRow: Record<string, unknown> | null = null;
      const b: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (ok: any, err: any) => {
                if (insertRow) {
                  state.inserts.push({ table, row: insertRow });
                  return Promise.resolve({ data: null, error: table === "agent_audit_log" ? state.auditError : null }).then(ok, err);
                }
                if (state.failing.includes(table)) return Promise.resolve({ data: null, error: { message: "boom", code: "42P01" } }).then(ok, err);
                if (state.capped.includes(table)) {
                  return Promise.resolve({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `r${from + i}` })), error: null }).then(ok, err);
                }
                return Promise.resolve({ data: from > 0 ? [] : (rows()[table] ?? []), error: null }).then(ok, err);
              };
            }
            if (prop === "maybeSingle") {
              return () => {
                if (table === "organizations") return Promise.resolve({ data: state.orgError ? null : state.orgRow, error: state.orgError });
                return Promise.resolve({ data: null, error: null });
              };
            }
            if (prop === "select") {
              return (cols: string) => {
                read.select = cols;
                return b;
              };
            }
            if (prop === "eq") {
              return (col: string, val: unknown) => {
                read.eq.push([col, val]);
                return b;
              };
            }
            if (prop === "order") {
              return (col: string) => {
                read.order.push(col);
                return b;
              };
            }
            if (prop === "range") {
              return (f: number, t: number) => {
                from = f;
                read.ranges.push([f, t]);
                return b;
              };
            }
            if (prop === "insert") {
              return (row: Record<string, unknown>) => {
                insertRow = row;
                return b;
              };
            }
            return () => b;
          },
        },
      );
      return b;
    },
  };
}

const spies = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/lib/export/guard", () => ({ requireOwnerExport: vi.fn(async () => state.verdict) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => {
    state.made += 1;
    if (state.serviceThrows) throw new Error("no key");
    return client();
  }),
}));
vi.mock("@/lib/observe", () => ({ reportError: spies.reportError }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimited: vi.fn(async (key: string, limit: number, window: number) => {
    state.limits.push([key, limit, window]);
    return state.limited;
  }),
}));

import { GET } from "./route";

const ROUTE = join(process.cwd(), "src/app/(app)/settings/export/records/route.ts");

/** The owner's own browser, from the Your Data card (same-origin); `site` is what Sec-Fetch-Site says. */
const get = (site: string | null = "same-origin") =>
  GET(new Request("https://app.example.test/settings/export/records", { headers: site ? { "sec-fetch-site": site } : {} }) as never);

describe("GET /settings/export/records", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T04:30:00Z")); // 10:30 PM Oct 28 in Denver: the file is dated the 28th
    state.verdict = { ok: true, orgId: ORG, profileId: OWNER };
    state.failing = [];
    state.capped = [];
    state.orgRow = orgRow();
    state.orgError = null;
    state.auditError = null;
    state.serviceThrows = false;
    state.reads = [];
    state.inserts = [];
    state.made = 0;
    state.limited = false;
    state.limits = [];
    spies.reportError.mockClear();
    vi.stubEnv("SUPPORT_EMAIL", "support@north.example");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("refuses an office seat, an admin, a tech and a stranger with the guard's status and words, before any read", async () => {
    for (const [status, words] of [
      [403, "Ask Snowbell to download the company's data."],
      [403, "Ask the owner to download the company's data."],
      [401, "Sign in to download the company's data."],
    ] as const) {
      state.verdict = { ok: false, status, words };
      const res = await get();
      expect(res.status).toBe(status);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe(words);
      expect(state.reads).toEqual([]);
      expect(state.made).toBe(0);
      expect(state.inserts).toEqual([]);
      // Nobody the guard turned away is even counted against the company's downloads.
      expect(state.limits).toEqual([]);
    }
  });

  it("a cross-site fetch (an <img src> on a stranger's page) is refused after the guard, before any read or count", async () => {
    const res = await get("cross-site");
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(CROSS_SITE_WORDS);
    expect(CROSS_SITE_WORDS).toBe("Open this from Settings › Getting Paid › Your Data.");
    expect(state.reads).toEqual([]);
    expect(state.made).toBe(0);
    expect(state.limits).toEqual([]);
    // Same-origin (the card's button), same-site and a bare navigation (no header) all pass.
    for (const site of ["same-origin", "same-site", "none", null]) expect((await get(site)).status, String(site)).toBe(200);
  });

  it("the company's downloads are counted, ten an hour across the export doors, keyed on the company; the eleventh is refused in words before any read", async () => {
    await get();
    expect(state.limits).toEqual([[`export:${ORG}`, 10, 3600]]);
    state.reads = [];
    state.inserts = [];
    state.made = 0;
    state.limited = true;
    const res = await get();
    expect(res.status).toBe(429);
    expect(await res.text()).toBe(TOO_MANY_DOWNLOADS_WORDS);
    expect(TOO_MANY_DOWNLOADS_WORDS).toBe("That's enough downloads for this hour. Try again in an hour.");
    expect(state.reads).toEqual([]);
    expect(state.made).toBe(0);
    expect(state.inserts).toEqual([]);
  });

  it("a lapsed owner passes: the route reads no subscription state (source pin) and takes the guard's word", async () => {
    const src = readFileSync(ROUTE, "utf8");
    expect(src).not.toContain("@/lib/subscription");
    expect(src).not.toContain("@/lib/lapse-doors");
    expect(src).not.toContain("requireStaff");
    expect(src).toContain('import { requireOwnerExport } from "@/lib/export/guard";');
    const res = await get();
    expect(res.status).toBe(200);
  });

  it("the route exports only its handler and segment config, maxDuration after dynamic, on the node runtime", async () => {
    const src = readFileSync(ROUTE, "utf8");
    expect(src).toContain('export const dynamic = "force-dynamic";');
    expect(src).toContain('export const runtime = "nodejs";');
    expect(src).toContain("export const maxDuration = 300;");
    expect(src.indexOf("export const maxDuration = 300;")).toBeGreaterThan(src.indexOf('export const dynamic = "force-dynamic";'));
    const mod = await import("./route");
    expect(Object.keys(mod).sort()).toEqual(["GET", "dynamic", "maxDuration", "runtime"]);
  });

  it("reads the company by id and every registry table once, on the service client, naming the company, ordered by its unique column", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(state.made).toBe(1);
    const org = state.reads.filter((r) => r.table === "organizations");
    expect(org).toHaveLength(1);
    expect(org[0].select).toBe(COMPANY_TABLE.columns.join(", "));
    expect(org[0].eq).toEqual([["id", ORG]]);
    expect(org[0].select).not.toMatch(/stripe_/);
    // readAllPages asks the client for each page anew: a table with rows is two calls (its page,
    // then the empty one that says it is whole), an empty table is one. Every call names the
    // company, the registry's columns, and the table's unique order column.
    for (const def of EXPORT_TABLES) {
      // (agent_audit_log is read like the others AND written once at the end; the insert has no select.)
      const reads = state.reads.filter((r) => r.table === def.table && r.select);
      expect(reads.length, def.table).toBe(rows()[def.table]?.length ? 2 : 1);
      for (const r of reads) {
        expect(r.select, def.table).toBe(def.columns.join(", "));
        expect(r.eq, def.table).toEqual([["org_id", ORG]]);
        expect(r.order, def.table).toEqual([def.order]);
        expect(r.ranges, def.table).toHaveLength(1);
      }
      expect(reads[0].ranges[0], def.table).toEqual([0, 999]);
      if (reads[1]) expect(reads[1].ranges[0], def.table).toEqual([rows()[def.table].length, rows()[def.table].length + 999]);
    }
    // Nothing else was read: the company, the registry, and the one audit insert.
    const tables = new Set(state.reads.map((r) => r.table));
    expect([...tables].filter((t) => t !== "organizations" && t !== "agent_audit_log" && !EXPORT_TABLES.some((d) => d.table === t))).toEqual([]);
  });

  it("a table that doesn't come back whole refuses the file in words, naming it in its README words (never the raw table name), and files the failure; no audit row", async () => {
    state.failing = ["time_entries"];
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("Nothing was made. Every punch could not be read. Try again.");
    expect(state.inserts).toEqual([]);
    expect(spies.reportError).toHaveBeenCalledWith("export:records:read", expect.objectContaining({ message: "boom" }), { orgId: ORG, table: "time_entries" });
    // Two failures: the first in registry order is the one said.
    state.failing = ["payments", "customers"];
    expect(await (await get()).text()).toBe("Nothing was made. The customer list could not be read. Try again.");
    // A table whose words carry a colon is said by its head; a raw table name never reaches the card.
    state.failing = ["customer_portal_access"];
    const words = await (await get()).text();
    expect(words).toBe("Nothing was made. Which customers have a portal door open could not be read. Try again.");
    expect(words).not.toContain("customer_portal_access");
  });

  it("the company row failing, or missing, refuses the file in words", async () => {
    state.orgError = { message: "down" };
    let res = await get();
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Nothing was made. The company could not be read. Try again.");
    state.orgError = null;
    state.orgRow = null;
    res = await get();
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Nothing was made. The company could not be read. Try again.");
    expect(state.inserts).toEqual([]);
  });

  it("a list past readAllPages' cap is refused with the support address, nothing made", async () => {
    state.capped = ["time_entries"];
    const res = await get();
    expect(res.status).toBe(413);
    expect(await res.text()).toBe("Every punch is more than this door can pack (over 50,000 rows). Nothing was made. Write to support@north.example.");
    expect(state.inserts).toEqual([]);
    // Fifty full pages were asked for (one client call each) and then the door gave up, whole or nothing.
    expect(state.reads.filter((r) => r.table === "time_entries")).toHaveLength(50);
  });

  it("the two trails that grow by the day (agent_audit_log, reminder_log) may run to 200 pages before the door gives up, and the words say that number", async () => {
    expect(TRAIL_MAX_PAGES).toBe(200);
    expect(EXPORT_TABLES.filter((t) => t.maxPages !== undefined).map((t) => [t.table, t.maxPages])).toEqual([
      ["agent_audit_log", 200],
      ["reminder_log", 200],
    ]);
    state.capped = ["agent_audit_log"];
    const res = await get();
    expect(res.status).toBe(413);
    expect(await res.text()).toBe("The trail is more than this door can pack (over 200,000 rows). Nothing was made. Write to support@north.example.");
    expect(state.reads.filter((r) => r.table === "agent_audit_log" && r.select)).toHaveLength(200);
  });

  it("the support address is the env's, with North's own as the fallback, never a person's", async () => {
    vi.stubEnv("SUPPORT_EMAIL", "");
    state.capped = ["jobs"];
    const words = await (await get()).text();
    expect(words).toBe("Every job is more than this door can pack (over 50,000 rows). Nothing was made. Write to support@contractornorth.com.");
    const src = readFileSync(ROUTE, "utf8");
    expect(src).not.toMatch(/[a-z0-9._-]+@(gmail|icloud|me|yahoo|outlook)\./i);
  });

  it("no service key is a refusal in words, not a crash", async () => {
    state.serviceThrows = true;
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Nothing was made. The company could not be read. Try again.");
    expect(spies.reportError).toHaveBeenCalledWith("export:records:service", expect.any(Error), { orgId: ORG });
  });

  it("hands the owner the zip: streamed, named after the company and the day on its clock, no content-length", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Larkspur Electrique-records-2026-10-28.zip"; filename*=UTF-8''Larkspur%20%C3%89lectrique-records-2026-10-28.zip`,
    );
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toBeInstanceOf(ReadableStream);
  });

  it("the zip: README, manifest counts, company.json without stripe_ or the inbound secret, one CSV per registry table, files.csv", async () => {
    const res = await get();
    const entries = unzip(new Uint8Array(await res.arrayBuffer()));
    const parts = new Map(entries.map((e) => [e.name, text(e.data)]));
    expect(entries.map((e) => e.name)).toEqual(["README.txt", "manifest.json", "company.json", ...EXPORT_TABLES.map((d) => csvEntryName(d.table)), "files.csv"]);

    const readme = parts.get("README.txt")!;
    expect(readme.startsWith("Larkspur Électrique — every record the company has in Contractor North\nMade 2026-10-28 22:30 (America/Denver).")).toBe(true);
    expect(readme).toContain("Files are not in this zip — files.csv lists every one; download them from Settings › Getting Paid › Your Data.");

    const manifest = JSON.parse(parts.get("manifest.json")!);
    expect(manifest.company).toEqual({ id: ORG, name: "Larkspur Électrique" });
    expect(manifest.timezone).toBe("America/Denver");
    expect(manifest.tables.profiles).toBe(1);
    expect(manifest.tables.jobs).toBe(1);
    expect(manifest.tables.invoices).toBe(0);
    expect(Object.keys(manifest.tables)).toEqual(EXPORT_TABLES.map((d) => d.table));
    expect(manifest.files).toBe(6);

    const company = JSON.parse(parts.get("company.json")!);
    expect(company.name).toBe("Larkspur Électrique");
    expect(company.plan).toBe("pro");
    expect(Object.keys(company).some((k) => k.startsWith("stripe_"))).toBe(false);
    expect(company.settings).toEqual({ timezone: "America/Denver" });
    expect(parts.get("company.json")).not.toContain("shh-never");

    const profiles = parts.get(csvEntryName("profiles"))!.split("\r\n");
    expect(profiles[0]).toBe(EXPORT_TABLES.find((d) => d.table === "profiles")!.columns.join(","));
    expect(profiles[1]).toContain("p1,Snowbell Owner,,,owner,true,");
    expect(profiles[1]).toContain(`"{""nudge"":true}"`); // a jsonb cell as JSON text
    expect(parts.get(csvEntryName("jobs"))).toContain(`j1,J-012,,,Thistlewood panel,,"'=HYPERLINK(""x"")",`); // the formula guard
    for (const d of EXPORT_TABLES) expect(parts.get(csvEntryName(d.table))!.startsWith(d.columns.join(",") + "\r\n"), d.table).toBe(true);
    expect(parts.get(csvEntryName("profiles"))).not.toContain("org_id");

    expect(parts.get("files.csv")!.split("\r\n").filter(Boolean)).toEqual([
      "bucket,path,table,row_id,job_id",
      `branding,${ORG}/logo.png,organizations,${ORG},`,
      `branding,${ORG}/avatar-p1.jpg,profiles,p1,`,
      `documents,${ORG}/jobs/j1/plans.pdf,documents,d1,j1`,
      `documents,${ORG}/jobs/j1/before.jpg,tasks,t1,j1`,
      `documents,${ORG}/appointments/a1/1.jpg,appointments,a1,j1`,
      // The inspection sheet's file slot; its note slot ("3/4 EMT") is words, never a pointer.
      `documents,${ORG}/appointments/a1/2-plan.pdf,appointments,a1,j1`,
    ]);
    expect(parts.get("files.csv")).not.toContain("3/4 EMT");
  });

  it("one audit row says the download happened: export.records, risk 1, a read, ok, the counts, from the ui", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(state.inserts).toEqual([
      {
        table: "agent_audit_log",
        row: { org_id: ORG, user_id: OWNER, action: "export.records", risk: 1, effect: "read", ok: true, input_summary: { tables: EXPORT_TABLES.length, rows: 6 }, source: "ui" },
      },
    ]);
    expect(spies.reportError).not.toHaveBeenCalled();
  });

  it("a failed audit insert is filed and does not stop the download", async () => {
    state.auditError = { message: "audit down" };
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(spies.reportError).toHaveBeenCalledWith("export:audit", { message: "audit down" }, { orgId: ORG, action: "export.records" });
  });
});
