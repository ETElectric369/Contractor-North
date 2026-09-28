import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * NOTES ON THE OVERVIEW, KEPT PRIVATE (W1-21, Erik 2026-09-27: two boxes). The Description is the
 * scope and prints on the customer's invoice; the Notes are the company's own and never reach a
 * customer's paper. Each says which it is in one plain line. There is no Notes tab.
 */
vi.mock("../actions", () => ({ updateJobDescription: vi.fn(), updateJobNotes: vi.fn() }));

import { JobTextBox } from "./job-description";
import { JOB_TAB_ORDER } from "./job-tabs";

const r = (p: Parameters<typeof JobTextBox>[0]) => renderToStaticMarkup(createElement(JobTextBox, p));
const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

describe("the office's two boxes", () => {
  it("Description: the box, and the line that says it prints on the customer's invoice", () => {
    const html = r({ jobId: "j1", field: "description", value: "Swap the 100A panel" });
    expect(html).toContain(">Description<");
    expect(html).toContain("<textarea");
    expect(html).toContain("Swap the 100A panel");
    expect(html).toContain("It prints on the customer&#x27;s invoice.");
  });

  it("Notes, empty: one 44px Add A Note, with the line that says only the company sees them", () => {
    const html = r({ jobId: "j1", field: "notes", value: null });
    expect(html).toContain(">Notes<");
    expect(html).toMatch(/<button[^>]*h-11[^>]*>(?:<svg[\s\S]*?<\/svg>)?\s*Add A Note<\/button>/);
    expect(html).not.toContain("<textarea");
    expect(html).toContain("Only your company sees these. Never on a customer&#x27;s paper.");
  });

  it("Notes with words: the box open, with the same private line", () => {
    const html = r({ jobId: "j1", field: "notes", value: "Gate code 4412" });
    expect(html).toContain("<textarea");
    expect(html).toContain("Gate code 4412");
    expect(html).toContain("Only your company sees these.");
    expect(html).not.toContain("Add A Note");
  });
});

describe("the crew reads", () => {
  it("Notes as plain text only when there are some, and nothing to type into", () => {
    const html = r({ jobId: "j1", field: "notes", value: "Gate code 4412", viewerIsStaff: false });
    expect(html).toContain("Gate code 4412");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<button");
    expect(r({ jobId: "j1", field: "notes", value: "  ", viewerIsStaff: false })).toBe("");
    expect(r({ jobId: "j1", field: "notes", value: null, viewerIsStaff: false })).not.toContain("No notes from the office yet");
  });

  it("the Materials Tab line appears once, under the Description", () => {
    const d = r({ jobId: "j1", field: "description", value: "Swap the panel", viewerIsStaff: false });
    const n = r({ jobId: "j1", field: "notes", value: "Gate code", viewerIsStaff: false });
    expect(d).toContain("Materials Tab");
    expect(n).not.toContain("Materials Tab");
    expect(d).not.toContain("<textarea");
  });
});

describe("the job page", () => {
  const page = src("src/app/(app)/jobs/[id]/page.tsx");

  it("has no Notes tab: the notes are the Overview's second box", () => {
    expect(JOB_TAB_ORDER).not.toContain("notes");
    expect(page).not.toContain('id: "notes"');
    expect(page).toContain('<JobTextBox jobId={j.id} field="description"');
    expect(page).toContain('<JobTextBox jobId={j.id} field="notes"');
  });

  it("description and notes never merge: each box writes its own column", () => {
    const box = src("src/app/(app)/jobs/[id]/job-description.tsx");
    expect(box).toContain('field === "notes" ? await updateJobNotes(jobId, value) : await updateJobDescription(jobId, value)');
    // The job's New Invoice copies the Description, never the notes.
    const actions = src("src/app/(app)/jobs/actions.ts");
    expect(actions).toContain("description: (job as any)?.description ?? null");
    expect(actions).not.toMatch(/description:[^\n]*\.notes/);
  });
});
