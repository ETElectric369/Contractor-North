import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { coerceNeed } from "./answers";
import { ACCEPT_ATTR, MAX_UPLOAD_MB, extOf, intakePaths, isAllowedUpload, isOwnIntakePath, uploadDisplayName } from "./uploads";
import { parsePlaybook } from "./parse";
import type { Need } from "./types";

const ORG = "7d6da1e2-c9a0-47d8-bcc1-5b4c3e412fed";
const OTHER = "60195593-2e18-4230-bc8e-7a32d36d038d";
const fileNeed: Need = {
  key: "plan_files",
  label: "Plans",
  ask: "Upload your plans",
  slot: { type: "file", multi: true, maxMb: 100 },
};

describe("what a stranger may upload", () => {
  it("takes plans and photos, refuses the things that execute", () => {
    for (const ok of ["plan.pdf", "SITE.DWG", "detail.dxf", "photo.jpg", "shot.HEIC", "a.png"])
      expect(isAllowedUpload(ok), ok).toBe(true);
    for (const no of ["payload.exe", "run.sh", "macro.docm", "x.svg", "noextension", "a.pdf.exe"])
      expect(isAllowedUpload(no), no).toBe(false);
  });

  it("the picker offers exactly what the server accepts — one list, no drift", () => {
    for (const ext of ACCEPT_ATTR.split(",")) expect(isAllowedUpload(`f${ext}`), ext).toBe(true);
  });

  it("extension comes off the END, so a.pdf.exe is an exe", () => {
    expect(extOf("a.pdf.exe")).toBe("exe");
    expect(extOf("Plans v2.final.pdf")).toBe("pdf");
  });
});

describe("THE CROSS-TENANT BOUNDARY — the client hands back paths and can claim anything", () => {
  it("accepts only this org's own intake folder", () => {
    expect(isOwnIntakePath(ORG, `${ORG}/intake/123-abc-plan.pdf`)).toBe(true);
  });

  it("rejects another tenant's folder, traversal, absolute URLs and near-misses", () => {
    for (const bad of [
      `${OTHER}/intake/steal.pdf`,                 // another tenant outright
      `${ORG}/intake/../../${OTHER}/intake/x.pdf`, // traversal out of the folder
      `${ORG}/appointments/x.pdf`,                 // right org, wrong area
      `https://evil.example/${ORG}/intake/x.pdf`,  // a URL, not a path
      `${ORG}x/intake/x.pdf`,                      // prefix collision
      "",
      null,
      42,
    ])
      expect(isOwnIntakePath(ORG, bad as unknown), String(bad)).toBe(false);
  });
});

describe("the file answer shape", () => {
  it("is a list of paths — URLs are refused, because a URL in a column is a bearer token", () => {
    const out = coerceNeed(fileNeed, [`${ORG}/intake/a.pdf`, "https://x/y.pdf", `${ORG}/intake/b.png`]);
    expect(out).toEqual([`${ORG}/intake/a.pdf`, `${ORG}/intake/b.png`]);
  });

  it("caps the list and nulls an empty one", () => {
    expect((coerceNeed(fileNeed, Array.from({ length: 50 }, (_, i) => `${ORG}/intake/${i}.pdf`)) as string[]).length).toBe(20);
    expect(coerceNeed(fileNeed, [])).toBeNull();
    expect(coerceNeed(fileNeed, null)).toBeNull();
  });

  it("shows the customer's own filename, not our storage key", () => {
    expect(uploadDisplayName(`${ORG}/intake/1754500000000-0f1e2d3c-4b5a-6789-abcd-ef0123456789-Deck_Plans.pdf`)).toBe("Deck_Plans.pdf");
  });
});

describe("AN UPLOAD MUST SURVIVE CONVERSION — Andrew's plan set 'disappeared' when his lead became a quote", () => {
  const intake = {
    reason: "Bucket A",
    intake_answers: {
      has_plans: "Yes",
      plan_files: [`${ORG}/intake/1-a-plan.pdf`, `${ORG}/intake/2-b-site.dwg`],
      photos: null,
      q_x: 96161,
    },
  };

  it("intakePaths finds every file across the answers, and only files", () => {
    expect(intakePaths(intake)).toEqual([`${ORG}/intake/1-a-plan.pdf`, `${ORG}/intake/2-b-site.dwg`]);
    expect(intakePaths(null)).toEqual([]);
    expect(intakePaths({ intake_answers: { a: "text", b: 3 } })).toEqual([]);
  });

  /**
   * THE PROJECTION LAW, pinned. The lead leaves the inbox on conversion (`.is("converted_at",
   * null)`), so the estimate, job and walk-through pages are the only remaining doors to the
   * customer's files — and each reaches them through `inquiry.intake`. A select list that drops
   * `intake` doesn't error; it renders an empty list and the upload silently "disappears" again.
   */
  it("every conversion-trail page projects the inquiry's intake", () => {
    const pages = [
      "src/app/(app)/quotes/[id]/page.tsx",
      "src/app/(app)/jobs/[id]/page.tsx",
      "src/app/(app)/appointments/[id]/page.tsx",
    ];
    for (const p of pages) {
      const src = readFileSync(p, "utf8");
      expect(/inquir(y:inquiry_id|ies)\([^)]*intake[^)]*\)/.test(src), `${p} must select inquiry intake`).toBe(true);
      expect(src.includes("IntakeFiles"), `${p} must render IntakeFiles`).toBe(true);
    }
  });
});

describe("THE PARSER MUST KNOW THE TYPE — an unknown slot fails OPEN, and silently", () => {
  /**
   * Caught on the live page, not by a test: `parseSlot` returned undefined for "file", which makes
   * the need OPEN — so the question rendered with its label and a plain text box, no upload button.
   * Nothing threw. Every slot type this codebase can WRITE must survive the round trip it READS
   * through, so this asserts the whole set rather than just the new one.
   */
  it("a file slot survives parsePlaybook", () => {
    const parsed = parsePlaybook({
      needs: [{ key: "plan_files", label: "Plans", ask: "Upload your plans", slot: { type: "file", multi: true, maxMb: 100 } }],
    });
    expect(parsed.needs[0].slot).toEqual({ type: "file", multi: true, maxMb: 100 });
  });

  it("and maxMb is clamped to the bucket's real ceiling, whatever the row claims", () => {
    const parsed = parsePlaybook({
      needs: [{ key: "f", label: "F", ask: "F?", slot: { type: "file", maxMb: 99999 } }],
    });
    expect((parsed.needs[0].slot as { maxMb: number }).maxMb).toBe(MAX_UPLOAD_MB);
  });

  it("EVERY slot type this app can write round-trips through the parser", () => {
    const slots = [
      { type: "number", unit: "ft" },
      { type: "select", options: ["Yes", "No"] },
      { type: "text", long: true },
      { type: "file", multi: true },
    ];
    const parsed = parsePlaybook({
      needs: slots.map((slot, i) => ({ key: `k${i}`, label: `L${i}`, ask: `A${i}?`, slot })),
    });
    expect(parsed.needs.map((n) => n.slot?.type)).toEqual(["number", "select", "text", "file"]);
  });
});
