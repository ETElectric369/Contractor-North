import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE PLANS DOOR ON SCREEN (Erik 2026-09-25: "uploading a plan file from a dropdown in the costs
 * tab is the most unituitive thing ive seen on this app in a while"). The Plans And Drawings card
 * leads with one primary Add Plans Or Drawings button; its two ways in are Upload File (PDFs or
 * pictures, several at once) and Take Photo; no category dropdown anywhere in the door; every
 * target 44px and full width on a 375px phone. The Show On Portal sheet a new file opens on starts
 * with its title cleaned from the file name, says nothing is shown yet, and its way out is Not Now.
 */

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/app/report-client-error", () => ({ reportClientError: vi.fn(async () => {}) }));
vi.mock("@/lib/job-file-upload", () => ({ uploadJobFile: vi.fn() }));
vi.mock("../actions", () => ({ deleteDocument: vi.fn() }));
vi.mock("../portal-share-actions", () => ({
  filePlan: vi.fn(),
  showPaper: vi.fn(),
  takePaperOff: vi.fn(),
  updateShownPaper: vi.fn(),
}));

import { AddPlansDoor, PLAN_ACCEPT, PapersCard, PaperSheet, startingTitle } from "./job-portal-papers";
import type { JobPaper, PapersState, SharedPaperRow } from "../portal-share-actions";

const noop = () => {};

const paper = (over: Partial<JobPaper> = {}): JobPaper => ({
  id: "doc-1",
  name: "IMG_1234.JPG",
  category: "Plan",
  createdAt: "2026-09-25T15:00:00Z",
  format: "image",
  signedUrl: null,
  refusal: null,
  ...over,
});

const share = (over: Partial<SharedPaperRow> = {}): SharedPaperRow => ({
  document_id: "doc-old",
  kind: "plan",
  title: "Panel Plan",
  replaces_document_id: null,
  shared_by: null,
  shared_at: "2026-09-01T15:00:00Z",
  removed_at: null,
  removed_by: null,
  replaces_marked_by: null,
  replaces_marked_at: null,
  ...over,
});

/** The <button> whose text contains `label`, as markup. */
function button(html: string, label: string): string | null {
  for (const m of html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)) {
    if (m[0].replace(/<[^>]+>/g, "").includes(label)) return m[0];
  }
  return null;
}
const classOf = (el: string | null) => /class="([^"]*)"/.exec(el ?? "")?.[1].split(/\s+/) ?? [];

/** At 375px: a 44px target (h-11), full width below the sm breakpoint, nothing fixed wider. */
function phoneFit(el: string | null) {
  const c = classOf(el);
  expect(el).not.toBeNull();
  expect(c).toContain("h-11");
  expect(c).toContain("w-full");
  expect(c.some((k) => /^(min-)?w-\[\d+px\]$/.test(k))).toBe(false);
}

function card(state: PapersState) {
  return renderToStaticMarkup(createElement(PapersCard, { jobId: "job-1", orgId: "org-1", state, setState: noop, who: "Nora" }));
}

describe("Plans And Drawings card: the Add Plans Or Drawings door", () => {
  it("leads with the primary button, 44px and full width on a 375px phone, with no category dropdown", () => {
    const html = card({ ready: true, papers: [], shares: [], people: {} });
    const add = button(html, "Add Plans Or Drawings");
    phoneFit(add);
    // Primary: the sea-glass fill, not an outline.
    expect(add).toMatch(/bg-\[rgb\(var\(--glass-ink\)\)\]/);
    expect(add).toMatch(/aria-expanded="false"/);
    // The door's file input takes PDFs and pictures, several at once; the camera one is the phone's camera.
    expect(html).toMatch(new RegExp(`<input[^>]*type="file"[^>]*multiple=""[^>]*accept="${PLAN_ACCEPT.replace("/", "\\/").replace("*", "\\*")}"`));
    expect(html).toMatch(/<input[^>]*accept="image\/\*"[^>]*capture="environment"/);
    // No dropdown in the card's own door (the only <select>s live on the sheet, which is closed).
    expect(html).not.toMatch(/<select/);
    // The empty list points at the door, not at the Costs tab.
    expect(html).toContain("with Add Plans Or Drawings above");
    expect(html).not.toContain("Receipts And Documents");
  });

  it("opened: the two ways in, Upload File and Take Photo, each 44px and full width on a phone", () => {
    const html = renderToStaticMarkup(
      createElement(AddPlansDoor, { adding: true, filing: false, who: "Nora", onOpen: noop, onUpload: noop, onTakePhoto: noop, onDrop: noop }),
    );
    phoneFit(button(html, "Upload File"));
    phoneFit(button(html, "Take Photo"));
    expect(button(html, "Add Plans Or Drawings")).toMatch(/aria-expanded="true"/);
    // It says what happens, in plain words, before anyone picks a file.
    expect(html).toContain("Each is filed on this job as a plan. Nothing goes on Nora&#x27;s page until you press");
    expect(html).not.toMatch(/<select/);
  });

  it("while filing, the door says so and can't be pressed twice", () => {
    const html = renderToStaticMarkup(
      createElement(AddPlansDoor, { adding: true, filing: true, who: "Nora", onOpen: noop, onUpload: noop, onTakePhoto: noop, onDrop: noop }),
    );
    expect(button(html, "Filing…")).toMatch(/disabled=""/);
    expect(button(html, "Upload File")).toMatch(/disabled=""/);
    expect(button(html, "Take Photo")).toMatch(/disabled=""/);
  });

  it("isn't offered before the papers are ready (0326 off): the card only says why", () => {
    const html = card({ ready: false, reason: "Not switched on yet." });
    expect(button(html, "Add Plans Or Drawings")).toBeNull();
    expect(html).toContain("Not switched on yet.");
  });
});

describe("the Show On Portal sheet a new plan opens on", () => {
  function sheet(p: JobPaper, shares: SharedPaperRow[] = []) {
    return renderToStaticMarkup(
      createElement(PaperSheet, { paper: p, share: null, mode: "show", fresh: true, shares, who: "Nora", onClose: noop, onSaved: noop }),
    );
  }
  const titleValue = (html: string) => /<input[^>]*id="paper-title"[^>]*value="([^"]*)"/.exec(html)?.[1];

  it("a camera name (IMG_1234.JPG) starts as \"Plan, <date>\"", () => {
    expect(titleValue(sheet(paper()))).toBe("Plan, Sep 25, 2026");
  });

  it("a real name starts cleaned: no extension, no underscores", () => {
    expect(titleValue(sheet(paper({ name: "123_Main_St_Panel_Schedule_v2.pdf", format: "pdf" })))).toBe("123 Main St Panel Schedule v2");
  });

  it("says it is filed and not shown, the way out is Not Now, and Show On Portal is the only way on", () => {
    const html = sheet(paper());
    expect(html).toContain("Filed on this job as a plan. It goes on Nora&#x27;s page only when you press Show On Portal.");
    expect(button(html, "Not Now")).not.toBeNull();
    expect(button(html, "Cancel")).toBeNull();
    expect(button(html, "Show On Portal")).not.toBeNull();
  });

  it("offers Replaces only when the job already shows a paper", () => {
    expect(sheet(paper())).not.toContain('id="paper-replaces"');
    const html = sheet(paper(), [share()]);
    expect(html).toContain('id="paper-replaces"');
    expect(html).toContain("Panel Plan (Plan)");
  });

  it("an older paper opened from the list keeps Cancel and no filed note", () => {
    const html = renderToStaticMarkup(
      createElement(PaperSheet, { paper: paper(), share: null, mode: "show", shares: [], who: "Nora", onClose: noop, onSaved: noop }),
    );
    expect(button(html, "Cancel")).not.toBeNull();
    expect(html).not.toContain("Filed on this job as a plan");
  });

  it("startingTitle falls back by what the paper is filed as", () => {
    expect(startingTitle(paper({ category: "Permit", name: "Scan 3.pdf" }))).toBe("Permit, Sep 25, 2026");
    expect(startingTitle(paper({ category: "Other", name: "photo-1727312345678.jpg" }))).toBe("Document, Sep 25, 2026");
    expect(startingTitle(null)).toBe("");
  });
});
