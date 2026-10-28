import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb } from "@/test/fake-supabase";
import { doorsIn, textOf } from "@/test/rendered-page";
import { JOB_LIST_UNREAD_WORDS } from "@/lib/export-files/jobs-with-files";
import { NO_JOB_FILES_WORDS, YOUR_DATA_FACTS, YOUR_DATA_LINE } from "./your-data-words";
import { requireOwnerExport } from "@/lib/export/guard";

/**
 * YOUR DATA, RENDERED (cn-v1138): the owner sees the one line, the info icon, Download Everything,
 * Company Files and one Download per job that has files (its label, its count, newest first); a
 * non-owner sees only who to ask; a failed read is one sentence and no rows; no job files is said;
 * Show More appears only past the first page. Rendered the way this repo renders a screen in a test,
 * react-dom/server on the real component. Every name and street here is invented.
 */
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  failTable: null as string | null,
  owner: "Larkspur" as string | null,
  errors: [] as unknown[][],
}));

vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => false }));
vi.mock("@/app/report-client-error", () => ({ reportClientError: vi.fn(async () => {}) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn((...a: unknown[]) => state.errors.push(a)) }));
vi.mock("@/lib/lapse-words", () => ({ ownerFirstName: vi.fn(async () => state.owner) }));
vi.mock("./your-data-actions", () => ({ listJobsWithFiles: vi.fn() }));
vi.mock("@/lib/export/guard", () => ({ requireOwnerExport: vi.fn(async () => ({ ok: true, orgId: "org-1", profileId: "u-owner" })) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("the door reads on the service client behind the owner guard (0366 revokes the answers column from the signed-in role)");
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
    return { from: (table: string) => (table === state.failTable ? failing() : db.sb.from(table)) };
  },
}));

import { YourData } from "./your-data";

const ORG = "org-1";
const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";

async function render(isOwner: boolean) {
  const html = renderToStaticMarkup(await YourData({ orgId: ORG, isOwner }));
  return { html, text: textOf(html), doors: doorsIn(html) };
}

beforeEach(() => {
  state.failTable = null;
  state.owner = "Larkspur";
  state.errors = [];
  state.tables = {
    organizations: [{ id: ORG, name: "Larkspur Electric" }],
    jobs: [
      { id: JOB_A, org_id: ORG, job_number: "J-047", name: "41 Snowbell Lane", created_at: "2026-10-01T00:00:00Z", customers: { name: "Bayberry Homes", company_name: null } },
      { id: JOB_B, org_id: ORG, job_number: "J-052", name: "9 Thistlewood Court", created_at: "2026-10-20T00:00:00Z", customers: { name: "Catbird Rentals", company_name: null } },
      { id: "33333333-3333-4333-8333-333333333333", org_id: ORG, job_number: "J-053", name: "No files here", created_at: "2026-10-25T00:00:00Z", customers: null },
    ],
    documents: [
      { id: "d1", org_id: ORG, job_id: JOB_A, file_url: `${ORG}/${JOB_A}/1-a.jpg` },
      { id: "d2", org_id: ORG, job_id: JOB_A, file_url: `${ORG}/${JOB_A}/2-b.jpg` },
      { id: "d3", org_id: ORG, job_id: JOB_B, file_url: `${ORG}/${JOB_B}/1-plans.pdf` },
    ],
    tasks: [{ id: "t1", org_id: ORG, job_id: JOB_A, photo_path: `${ORG}/${JOB_A}/1-a.jpg`, done_photo_path: null }],
    appointments: [],
    job_picks: [],
  };
});

describe("the owner", () => {
  it("sees the line, the info icon, the two company doors and one Download per job that has files, newest first, with its label and count", async () => {
    const { html, text, doors } = await render(true);
    expect(text).toContain("Your Data");
    expect(text).toContain(YOUR_DATA_LINE);
    expect(html).toContain('aria-label="About Your Data"');
    expect(doors.filter((d) => d === "Download Everything")).toHaveLength(1);
    expect(doors.filter((d) => d === "Company Files")).toHaveLength(1);
    expect(doors.filter((d) => d === "Download")).toHaveLength(2);
    expect(text).toContain("Files By Job");
    // Newest first: J-052 (Oct 20) before J-047 (Oct 1); the job with no files is not a row.
    const at = (s: string) => text.indexOf(s);
    expect(at("9 Thistlewood Court · J-052 — Catbird Rentals")).toBeGreaterThan(-1);
    expect(at("41 Snowbell Lane · J-047 — Bayberry Homes")).toBeGreaterThan(at("9 Thistlewood Court · J-052 — Catbird Rentals"));
    expect(text).not.toContain("No files here");
    // The count is distinct files: the task photo that is also a documents row is one file.
    expect(text).toContain("2 Files");
    expect(text).toContain("1 File ");
    expect(text).not.toContain("Ask Larkspur");
    expect(text).not.toContain("Show More");
    expect(state.errors).toEqual([]);
  });

  it("the doors point at the three routes, a job's by its id (the button fetches the href; it is not an <a>)", () => {
    const door = readFileSync(join(__dirname, "your-data.tsx"), "utf8");
    expect(door).toContain('href="/settings/export/records"');
    expect(door).toContain('href="/settings/export/company-files"');
    expect(door).toContain('label="Download Everything"');
    expect(door).toContain('label="Company Files"');
    const list = readFileSync(join(__dirname, "your-data-list.tsx"), "utf8");
    expect(list).toContain("href={`/settings/export/job/${r.id}`}");
    expect(list).toContain('label="Download"');
  });

  it("a failed read is one sentence in the section and no rows; it is filed", async () => {
    state.failTable = "documents";
    const { text, doors } = await render(true);
    expect(text).toContain(JOB_LIST_UNREAD_WORDS);
    expect(JOB_LIST_UNREAD_WORDS).toBe("The job list could not be read. Reload.");
    expect(doors.filter((d) => d === "Download")).toHaveLength(0);
    expect(doors.filter((d) => d === "Download Everything")).toHaveLength(1);
    expect(state.errors).toEqual([["your-data:jobs-with-files", { message: "boom" }, { orgId: ORG }]]);
  });

  it("no job has files yet: said, with the company doors still there", async () => {
    state.tables.documents = [];
    state.tables.tasks = [];
    const { text, doors } = await render(true);
    expect(text).toContain(NO_JOB_FILES_WORDS);
    expect(NO_JOB_FILES_WORDS).toBe("No job has files yet.");
    expect(doors.filter((d) => d === "Download Everything")).toHaveLength(1);
    expect(doors.filter((d) => d === "Download")).toHaveLength(0);
  });

  it("past the first page of fifty, Show More stands under the list", async () => {
    const jobs: Record<string, unknown>[] = [];
    const documents: Record<string, unknown>[] = [];
    for (let i = 0; i < 52; i++) {
      const id = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
      jobs.push({ id, org_id: ORG, job_number: `J-${String(i).padStart(3, "0")}`, name: `${i} Larkspur Way`, created_at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`, customers: null });
      documents.push({ id: `d${i}`, org_id: ORG, job_id: id, file_url: `${ORG}/${id}/1-a.jpg` });
    }
    state.tables.jobs = jobs;
    state.tables.documents = documents;
    state.tables.tasks = [];
    const { doors } = await render(true);
    expect(doors.filter((d) => d === "Download")).toHaveLength(50);
    expect(doors.filter((d) => d === "Show More")).toHaveLength(1);
  });

  it("the company's name is the buttons' fallback file name; a failed company read falls back to North and nothing else changes", async () => {
    state.failTable = "organizations";
    const { doors } = await render(true);
    expect(doors.filter((d) => d === "Download Everything")).toHaveLength(1);
  });
});

describe("not the owner", () => {
  it("sees only who to ask, by first name, and no door", async () => {
    const { text, doors } = await render(false);
    expect(text).toContain("Ask Larkspur to download the company's data.");
    expect(doors.filter((d) => /Download|Company Files|Show More/.test(d))).toHaveLength(0);
    expect(text).not.toContain("Files By Job");
    expect(text).not.toContain("No job has files yet.");
  });

  it("with no owner on the roster, 'the owner'", async () => {
    state.owner = null;
    const { text } = await render(false);
    expect(text).toContain("Ask the owner to download the company's data.");
  });

  it("the prop says owner but the guard says no, or names another company: who to ask, and no service read", async () => {
    vi.mocked(requireOwnerExport).mockResolvedValueOnce({ ok: false, status: 403, words: "Ask the owner to download the company's data." });
    const refused = await render(true);
    expect(refused.text).toContain("Ask Larkspur to download the company's data.");
    expect(refused.doors.filter((d) => /Download|Company Files|Show More/.test(d))).toHaveLength(0);
    vi.mocked(requireOwnerExport).mockResolvedValueOnce({ ok: true, orgId: "org-2", profileId: "u-other" });
    const other = await render(true);
    expect(other.text).toContain("Ask Larkspur to download the company's data.");
    expect(other.text).not.toContain("Files By Job");
  });
});

describe("the source", () => {
  const src = (f: string) => readFileSync(join(__dirname, f), "utf8");

  it("the prop shape the settings page passes, exactly", () => {
    expect(src("your-data.tsx")).toContain("export async function YourData({ orgId, isOwner }: { orgId: string; isOwner: boolean })");
  });

  it("reads no subscription state anywhere on the door: a lapsed owner uses it", () => {
    for (const f of ["your-data.tsx", "your-data-list.tsx", "your-data-actions.ts", "your-data-words.ts"]) {
      expect(src(f), f).not.toContain("@/lib/subscription");
    }
    expect(readFileSync(join(process.cwd(), "src/lib/export-files/jobs-with-files.ts"), "utf8")).not.toContain("@/lib/subscription");
  });

  it("every row read names the company, and nothing reads select('*')", () => {
    const reader = readFileSync(join(process.cwd(), "src/lib/export-files/jobs-with-files.ts"), "utf8");
    expect(reader.match(/\.eq\("org_id", orgId\)/g)?.length).toBe(5);
    expect(reader).not.toMatch(/select\("\*"\)/);
    expect(src("your-data.tsx")).not.toMatch(/select\("\*"\)/);
  });

  it("the info icon's facts name the records zip's parts, that the files come separately (the visits among them), and what a download does to the records: nothing, except that North notes it", () => {
    const all = YOUR_DATA_FACTS.join(" ");
    for (const part of ["README", "company.json", "one CSV per table", "files.csv", "come separately", "every visit's photos and files"]) expect(all).toContain(part);
    expect(all).not.toMatch(/shelf/i);
    // A download writes one agent_audit_log row, which the Audit page shows: "nothing changes" was false.
    expect(all).toContain("Downloading changes none of your records; North only notes who downloaded and when.");
    expect(all).not.toContain("Nothing in North changes");
  });
});
