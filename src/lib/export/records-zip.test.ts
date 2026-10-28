import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { unzip, text } from "@/test/unzip";
import { EXPORT_TABLES, companyJson } from "@/lib/export/registry";
import {
  FILES_NOTE,
  TABLE_WORDS,
  buildRecordsZip,
  csvCell,
  csvEntryName,
  filePointers,
  momentInTz,
  objectPointer,
  tableSaid,
  type ExportRows,
} from "@/lib/export/records-zip";

/**
 * THE RECORDS ZIP, FROM ROWS: README, manifest, company.json, one CSV per registry table in registry
 * order with the registry's header, files.csv from every storage pointer. Every name here is a
 * stand-in (Larkspur, Snowbell, Bayberry); nothing real.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const PUBLIC = "https://xyz.supabase.co/storage/v1/object/public";

const orgRow = {
  id: ORG,
  name: "Larkspur Électrique",
  logo_url: `${PUBLIC}/branding/${ORG}/logo-1.png`,
  phone: "530-555-0100",
  plan: "pro",
  stripe_customer_id: "cus_secret",
  stripe_account_id: "acct_secret",
  settings: { timezone: "America/Los_Angeles", lead_inbound_secret: "shh", portfolio: [{ url: `${PUBLIC}/branding/${ORG}/portfolio-1.jpg`, path: `${ORG}/portfolio-1.jpg` }, { url: `${PUBLIC}/branding/${ORG}/portfolio-2.jpg` }] },
};

const col = (table: string) => EXPORT_TABLES.find((t) => t.table === table)!.columns;
const rows = (table: string, list: Record<string, unknown>[]): ExportRows => ({ table, columns: col(table), rows: list });

const fixture = (): ExportRows[] => [
  // Out of registry order on purpose: the zip puts them back.
  rows("tasks", [
    { id: "t1", job_id: "j1", title: "=SUM(A1:A9) hang the fixture", notes: null, photo_path: `${ORG}/jobs/j1/before.jpg`, done_photo_path: null, tags: ["a", "b"] },
  ]),
  rows("profiles", [
    { id: "p1", full_name: "Snowbell Owner", role: "owner", active: true, avatar_url: `${PUBLIC}/branding/${ORG}/avatar-p1.jpg`, push_prefs: { nudge: false } },
    { id: "p2", full_name: "Bayberry Tech", role: "tech", active: false, avatar_url: null, hourly_rate: 42.5 },
  ]),
  rows("jobs", [{ id: "j1", job_number: "J-012", name: "Thistlewood panel, Catbird Lane", notes: "-10% if paid by Friday\nline two", created_at: "2026-10-01T18:00:00+00:00" }]),
  rows("documents", [{ id: "d1", name: "plans.pdf", file_url: `${ORG}/jobs/j1/plans.pdf`, job_id: "j1" }]),
  rows("appointments", [
    {
      id: "a1",
      job_id: "j1",
      capture: { notes: "x", photos: [`${ORG}/appointments/a1/1.jpg`, `${ORG}/appointments/a1/2.jpg`] },
      // The inspection sheet: a file slot's keys (one of them also a capture photo: listed once per
      // pointer, the files door dedupes); a note with a slash and a stranger's key are no pointer.
      inspection_answers: { plans: [`${ORG}/appointments/a1/3-plan.pdf`, `${ORG}/appointments/a1/1.jpg`], conduit: "3/4 EMT", theirs: "other-org/appointments/a1/x.pdf" },
    },
  ]),
  rows("inquiries", [{ id: "q1", name: "Catbird", intake: { intake_answers: { plans: [`${ORG}/intake/1-aaaa-plan.pdf`], note: "n/a" } } }]),
  rows("supplier_invoices", [
    { id: "s1", job_id: "j1", source_file: `${ORG}/organize/ced/invoice_1.pdf` },
    { id: "s2", job_id: null, source_file: "invoice_8802.pdf" },
  ]),
  rows("invoices", []),
];

const build = (tables = fixture()) =>
  buildRecordsZip({
    company: companyJson(orgRow, orgRow.settings),
    tz: "America/Los_Angeles",
    now: new Date("2026-10-28T21:05:00Z"),
    tables,
    deflate: (b) => new Uint8Array(deflateRawSync(b)),
    modified: new Date("2026-10-28T14:05:00Z"),
  });

describe("buildRecordsZip", () => {
  it("README, manifest, company.json, the CSVs in registry order, files.csv — and nothing else", () => {
    const entries = unzip(build());
    expect(entries.map((e) => e.name)).toEqual([
      "README.txt",
      "manifest.json",
      "company.json",
      csvEntryName("profiles"),
      csvEntryName("inquiries"),
      csvEntryName("jobs"),
      csvEntryName("appointments"),
      csvEntryName("tasks"),
      csvEntryName("invoices"),
      csvEntryName("supplier_invoices"),
      csvEntryName("documents"),
      "files.csv",
    ]);
    // nn is the table's place in the registry, two digits, parent before child.
    expect(csvEntryName("profiles")).toBe("records/01-profiles.csv");
    const jobs = EXPORT_TABLES.findIndex((t) => t.table === "jobs") + 1;
    expect(csvEntryName("jobs")).toBe(`records/${String(jobs).padStart(2, "0")}-jobs.csv`);
  });

  it("the README names the company, the moment on its clock, every file, and that the files are elsewhere", () => {
    const readme = text(unzip(build()).find((e) => e.name === "README.txt")!.data);
    expect(readme.startsWith("Larkspur Électrique — every record the company has in Contractor North\n")).toBe(true);
    expect(readme).toContain("Made 2026-10-28 14:05 (America/Los_Angeles).");
    expect(readme).toContain("  records/01-profiles.csv — the people on the roster: name, role, rates, home base (2 rows).");
    expect(readme).toContain(`  ${csvEntryName("invoices")} — every invoice (0 rows).`);
    expect(readme).toContain("  files.csv — every file the records point at (12 pointers)");
    expect(readme).toContain(FILES_NOTE);
    expect(FILES_NOTE).toBe("Files are not in this zip — files.csv lists every one; download them from Settings › Getting Paid › Your Data.");
    expect(readme).not.toMatch(/shelf/i);
  });

  it("every registry table has its README words", () => {
    for (const t of EXPORT_TABLES) expect(TABLE_WORDS[t.table], t.table).toMatch(/\S{3,}/);
    expect(Object.keys(TABLE_WORDS).filter((k) => !EXPORT_TABLES.some((t) => t.table === k))).toEqual([]);
    for (const w of Object.values(TABLE_WORDS)) expect(w).not.toMatch(/shelf/i);
  });

  it("the manifest counts every table's rows; company.json carries no stripe_ column and no inbound secret", () => {
    const parts = new Map(unzip(build()).map((e) => [e.name, text(e.data)]));
    const manifest = JSON.parse(parts.get("manifest.json")!);
    expect(manifest.company).toEqual({ id: ORG, name: "Larkspur Électrique" });
    expect(manifest.exported_at).toBe("2026-10-28T21:05:00.000Z");
    expect(manifest.timezone).toBe("America/Los_Angeles");
    expect(manifest.tables).toEqual({ profiles: 2, inquiries: 1, jobs: 1, appointments: 1, tasks: 1, invoices: 0, supplier_invoices: 2, documents: 1 });
    expect(manifest.files).toBe(12);
    const company = JSON.parse(parts.get("company.json")!);
    expect(company.name).toBe("Larkspur Électrique");
    expect(company.phone).toBe("530-555-0100");
    expect(company.license).toBeNull(); // a column the fixture never set is there, empty
    expect(Object.keys(company).filter((k) => k.startsWith("stripe_"))).toEqual([]);
    expect(company.settings).toEqual({ timezone: "America/Los_Angeles", portfolio: orgRow.settings.portfolio });
    expect(JSON.stringify(company)).not.toContain("shh");
    expect(JSON.stringify(company)).not.toContain("cus_secret");
  });

  it("each CSV has the registry's header and the rows: jsonb as JSON text, booleans as words, null empty, a formula guarded, a line break quoted", () => {
    const parts = new Map(unzip(build()).map((e) => [e.name, text(e.data)]));
    const profiles = parts.get(csvEntryName("profiles"))!.split("\r\n");
    expect(profiles[0]).toBe(col("profiles").join(","));
    expect(profiles[1].startsWith("p1,Snowbell Owner,,,owner,true,")).toBe(true);
    expect(profiles[1]).toContain(`"{""nudge"":false}"`);
    expect(profiles[2].startsWith("p2,Bayberry Tech,,,tech,false,,,42.5,")).toBe(true);
    expect(profiles.at(-1)).toBe(""); // CRLF-terminated
    const tasks = parts.get(csvEntryName("tasks"))!;
    expect(tasks).toContain(`t1,j1,,'=SUM(A1:A9) hang the fixture,`); // the formula guard
    expect(tasks).toContain(`"[""a"",""b""]"`);
    const jobs = parts.get(csvEntryName("jobs"))!;
    expect(jobs).toContain(`"'-10% if paid by Friday\nline two"`);
    expect(jobs).toContain("2026-10-01T18:00:00+00:00"); // a timestamp as stored
    const invoices = parts.get(csvEntryName("invoices"))!;
    expect(invoices).toBe(col("invoices").join(",") + "\r\n"); // no rows: the header alone, never a missing file
  });

  it("files.csv: one row per pointer, the bucket by the table, a public URL read back to its path, a bare file name skipped", () => {
    const files = text(unzip(build()).find((e) => e.name === "files.csv")!.data).split("\r\n").filter(Boolean);
    expect(files[0]).toBe("bucket,path,table,row_id,job_id");
    expect(files.slice(1)).toEqual([
      `branding,${ORG}/logo-1.png,organizations,${ORG},`,
      `branding,${ORG}/portfolio-1.jpg,organizations,${ORG},`,
      `branding,${ORG}/portfolio-2.jpg,organizations,${ORG},`,
      `branding,${ORG}/avatar-p1.jpg,profiles,p1,`,
      `documents,${ORG}/jobs/j1/plans.pdf,documents,d1,j1`,
      `documents,${ORG}/jobs/j1/before.jpg,tasks,t1,j1`,
      `documents,${ORG}/appointments/a1/1.jpg,appointments,a1,j1`,
      `documents,${ORG}/appointments/a1/2.jpg,appointments,a1,j1`,
      `documents,${ORG}/appointments/a1/3-plan.pdf,appointments,a1,j1`,
      `documents,${ORG}/appointments/a1/1.jpg,appointments,a1,j1`,
      `documents,${ORG}/organize/ced/invoice_1.pdf,supplier_invoices,s1,j1`,
      `intake-uploads,${ORG}/intake/1-aaaa-plan.pdf,inquiries,q1,`,
    ]);
    // The bare file name (s2's "invoice_8802.pdf") is not a stored path and is not listed; nor is a
    // sheet's note, nor a stranger's key inside a sheet.
    expect(files.join("\n")).not.toContain("invoice_8802");
    expect(files.join("\n")).not.toContain("3/4 EMT");
    expect(files.join("\n")).not.toContain("other-org");
  });

  it("a table said in a sentence: its README words up to the first colon or parenthesis, capitalized; a name with spaces when it has none", () => {
    expect(tableSaid("time_entries")).toBe("Every punch");
    expect(tableSaid("agent_audit_log")).toBe("The trail");
    expect(tableSaid("invoices")).toBe("Every invoice");
    expect(tableSaid("kits")).toBe("Kits");
    expect(tableSaid("accountant_exports")).toBe("Accountant downloads that were recorded");
    expect(tableSaid("not_a_table")).toBe("Not a table");
    for (const t of EXPORT_TABLES) {
      expect(tableSaid(t.table), t.table).toMatch(/^[A-Z]/);
      expect(tableSaid(t.table), t.table).not.toMatch(/[_:(]/);
    }
  });

  it("files.csv rows, exactly", () => {
    const pointers = filePointers(companyJson(orgRow, orgRow.settings), fixture());
    expect(pointers).toEqual([
      { bucket: "branding", path: `${ORG}/logo-1.png`, table: "organizations", row_id: ORG, job_id: "" },
      { bucket: "branding", path: `${ORG}/portfolio-1.jpg`, table: "organizations", row_id: ORG, job_id: "" },
      { bucket: "branding", path: `${ORG}/portfolio-2.jpg`, table: "organizations", row_id: ORG, job_id: "" },
      { bucket: "branding", path: `${ORG}/avatar-p1.jpg`, table: "profiles", row_id: "p1", job_id: "" },
      { bucket: "documents", path: `${ORG}/jobs/j1/plans.pdf`, table: "documents", row_id: "d1", job_id: "j1" },
      { bucket: "documents", path: `${ORG}/jobs/j1/before.jpg`, table: "tasks", row_id: "t1", job_id: "j1" },
      { bucket: "documents", path: `${ORG}/appointments/a1/1.jpg`, table: "appointments", row_id: "a1", job_id: "j1" },
      { bucket: "documents", path: `${ORG}/appointments/a1/2.jpg`, table: "appointments", row_id: "a1", job_id: "j1" },
      { bucket: "documents", path: `${ORG}/appointments/a1/3-plan.pdf`, table: "appointments", row_id: "a1", job_id: "j1" },
      { bucket: "documents", path: `${ORG}/appointments/a1/1.jpg`, table: "appointments", row_id: "a1", job_id: "j1" },
      { bucket: "documents", path: `${ORG}/organize/ced/invoice_1.pdf`, table: "supplier_invoices", row_id: "s1", job_id: "j1" },
      { bucket: "intake-uploads", path: `${ORG}/intake/1-aaaa-plan.pdf`, table: "inquiries", row_id: "q1", job_id: "" },
    ]);
  });

  it("a pointer: a bare path keeps the table's bucket; an object URL names its own; a foreign URL, an empty value or a climb is none", () => {
    expect(objectPointer(`${ORG}/jobs/j1/a.jpg`, "documents")).toEqual({ bucket: "documents", path: `${ORG}/jobs/j1/a.jpg` });
    expect(objectPointer(`/${ORG}/x.jpg`, "documents")).toEqual({ bucket: "documents", path: `${ORG}/x.jpg` });
    expect(objectPointer(`${PUBLIC}/branding/${ORG}/logo%20one.png?t=1`, "documents")).toEqual({ bucket: "branding", path: `${ORG}/logo one.png` });
    expect(objectPointer(`https://xyz.supabase.co/storage/v1/object/sign/documents/${ORG}/a.pdf?token=x`, "branding")).toEqual({ bucket: "documents", path: `${ORG}/a.pdf` });
    expect(objectPointer("https://example.test/photo.jpg", "branding")).toBeNull();
    expect(objectPointer("", "documents")).toBeNull();
    expect(objectPointer(null, "documents")).toBeNull();
    expect(objectPointer("../other-org/x.jpg", "documents")).toBeNull();
  });

  it("a cell: null empty, a number a number, a string as stored, a boolean a word, a structure JSON text", () => {
    expect(csvCell(null)).toBeNull();
    expect(csvCell(undefined)).toBeNull();
    expect(csvCell(12.5)).toBe(12.5);
    expect(csvCell("2026-10-01T18:00:00+00:00")).toBe("2026-10-01T18:00:00+00:00");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(false)).toBe("false");
    expect(csvCell({ a: [1, "x"] })).toBe('{"a":[1,"x"]}');
    expect(csvCell(["a"])).toBe('["a"]');
  });

  it("the moment on the company's clock", () => {
    expect(momentInTz(new Date("2026-10-28T21:05:00Z"), "America/Los_Angeles")).toBe("2026-10-28 14:05");
    expect(momentInTz(new Date("2026-10-28T06:30:00Z"), "America/New_York")).toBe("2026-10-28 02:30");
  });

  it("a table not in the registry is left out; a company with no name is still a zip", () => {
    const entries = unzip(
      buildRecordsZip({
        company: companyJson({ id: ORG }, null),
        tz: "UTC",
        now: new Date("2026-01-01T00:00:00Z"),
        tables: [{ table: "not_a_table", columns: ["id"], rows: [{ id: 1 }] }, rows("tax_rates", [{ id: "x", name: "Nevada County", rate: 7.5, is_default: true }])],
      }),
    );
    expect(entries.map((e) => e.name)).toEqual(["README.txt", "manifest.json", "company.json", csvEntryName("tax_rates"), "files.csv"]);
    expect(text(entries[0].data).startsWith("The company — every record")).toBe(true);
    expect(text(entries[3].data)).toBe(`${col("tax_rates").join(",")}\r\nx,Nevada County,7.5,true,,\r\n`);
    expect(text(entries[4].data)).toBe("bucket,path,table,row_id,job_id\r\n");
  });
});
