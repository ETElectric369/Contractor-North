import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LangProvider } from "@/components/lang-provider";
import { JobRow, type JobRowData } from "./job-row";
import { CompletedJobsSection } from "./completed-section";

/**
 * THE /jobs LIST IN THE TECH'S LANGUAGE (cn-v1138, skeptic #44 B2). sh_spanishCovers promises "jobs",
 * and the Jobs tile lands here: the page's header and empty states, the filter chip, each row's status
 * badge (lib/job-status jobStatusLabel with the language) and the Completed shelf all read the jb_
 * catalog. The row takes `lang` as a prop because it is drawn on the server (the page) and in the
 * client (the shelf); the English is byte for byte what the screens said.
 */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const row: JobRowData = {
  id: "j1",
  name: "Larkspur panel",
  job_number: "J-047",
  status: "in_progress",
  address: "41 Larkspur Ln",
  scheduled_start: null,
  customer: "Snowbell",
  billing: "paid_in_full",
};

describe("a job row", () => {
  it("reads its status badge and the invoices door's title in the viewer's language; English with no language, as before", () => {
    const en = renderToStaticMarkup(createElement(JobRow, { job: row }));
    expect(text(en)).toContain("in progress");
    expect(en).toContain('title="Open this job&#x27;s invoices"');
    const es = renderToStaticMarkup(createElement(JobRow, { job: row, lang: "es" }));
    expect(text(es)).toContain("En Curso");
    expect(text(es)).not.toContain("in progress");
    expect(es).toContain('title="Abrir las facturas de este trabajo"');
    // The data is the data: the job's name, number, customer and street are untouched.
    for (const s of ["Larkspur panel", "J-047", "Snowbell", "41 Larkspur Ln"]) expect(text(es)).toContain(s);
  });
});

describe("the Completed shelf", () => {
  const r = (lang: "en" | "es", jobs: JobRowData[], total: number) =>
    renderToStaticMarkup(createElement(LangProvider, { lang, children: createElement(CompletedJobsSection, { jobs, total }) }));
  it("its heading reads Completed / Terminados with the count, and hands the rows the language", () => {
    const done = { ...row, status: "complete" };
    expect(text(r("en", [done], 1))).toContain("Completed (1)");
    expect(text(r("es", [done], 1))).toContain("Terminados (1)");
    // The shelf is collapsed on the server render, so the rows and the "showing" line are not drawn yet;
    // the source hands each row the language and reads the line through the catalog.
    const src = read("src/app/(app)/jobs/completed-section.tsx");
    expect(src).toContain("<JobRow key={j.id} job={j} hideStatus lang={lang} />");
    expect(src).toContain('fillText(t("jb_showingLatestOf"), { n: String(jobs.length), total: String(total) })');
    expect(src).toContain('{t("jb_viewAllCompleted")}');
    expect(src).not.toContain("View All Completed");
  });
});

describe("the page (source pins: a server component with a session)", () => {
  it("reads the viewer's language beside the role, and every word it shows comes through the catalog", () => {
    const src = read("src/app/(app)/jobs/page.tsx");
    expect(src).toContain('select("role, language")');
    expect(src).toContain("const lang = asLang((me as { language?: string | null } | null)?.language);");
    expect(src).toContain('<PageHeader title={t("jb_jobsTitle")} description={t("jb_jobsDesc")}>');
    expect(src).toContain('{fillText(t("jb_filtered"), { status: jobStatusLabel(status, lang, t) })}');
    expect(src).toContain('title={!status && allJobs.length > 0 ? t("jb_noActiveJobs") : t("jb_noJobs")}');
    expect(src).toContain('description={isStaff ? t("jb_createJobToStart") : t("jb_officeAddsYourJobs")}');
    expect(src).toContain('{fillText(t("jb_nCancelled"), { n: String(cancelledCount) })}');
    expect(src).toContain("lang={lang} />");
    for (const gone of ['title="Jobs"', '"No active jobs"', '"Create a job to get started."', "{cancelledCount} cancelled"]) expect(src).not.toContain(gone);
  });
});
