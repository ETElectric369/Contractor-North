import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newestFirst, tallyFilesByJob } from "./jobs-with-files";

/**
 * THE "FILES BY JOB" COUNT (cn-v1138): distinct keys per job across every pointer row — a
 * documents row, a task's two photos, a visit's capture photos AND its sheet's file slots, a pick's
 * picture — under the company's own prefix only; a key two rows share is one file. Every name here
 * is invented.
 */
const ORG = "org-1";
const JOB = "11111111-1111-4111-8111-111111111111";

describe("tallyFilesByJob", () => {
  it("counts distinct keys per job from every pointer, the visit's sheet files among them; a stranger's key and a note count nothing", () => {
    const counts = tallyFilesByJob(ORG, {
      documents: [
        { job_id: JOB, file_url: `${ORG}/${JOB}/1-a.jpg` },
        { job_id: "j2", file_url: `${ORG}/j2/1-b.pdf` },
        { job_id: null, file_url: `${ORG}/loose.pdf` },
      ],
      tasks: [{ job_id: JOB, photo_path: `${ORG}/${JOB}/1-a.jpg`, done_photo_path: `${ORG}/${JOB}/2-done.jpg` }],
      appointments: [
        {
          job_id: JOB,
          capture: { photos: [`${ORG}/appointments/a1/3-visit.jpg`] },
          inspection_answers: { plans: [`${ORG}/appointments/a1/4-plan.pdf`, `${ORG}/appointments/a1/3-visit.jpg`], conduit: "3/4 EMT", theirs: "org-2/appointments/a1/x.pdf" },
        },
        // A visit with a sheet file and no capture at all still counts its file.
        { job_id: JOB, capture: null, inspection_answers: { meter: `${ORG}/appointments/a2/5-meter.jpg` } },
      ],
      picks: [{ job_id: JOB, file_path: `${ORG}/picks/${JOB}/swatch.png` }, { job_id: JOB, file_path: "org-2/picks/x.png" }],
    });
    // 1-a (once), 2-done, 3-visit (once), 4-plan, 5-meter, swatch = 6.
    expect([...counts.entries()]).toEqual([
      [JOB, 6],
      ["j2", 1],
    ]);
  });

  it("newest first, then the later number first", () => {
    const rows = [
      { created_at: "2026-10-01T00:00:00Z", job_number: "J-010" },
      { created_at: "2026-10-05T00:00:00Z", job_number: "J-011" },
      { created_at: "2026-10-05T00:00:00Z", job_number: "J-012" },
      { created_at: null, job_number: "J-001" },
    ];
    expect([...rows].sort(newestFirst).map((r) => r.job_number)).toEqual(["J-012", "J-011", "J-010", "J-001"]);
  });

  it("the appointments read carries the sheet and filters on neither capture nor sheet, every read naming the company (source pin)", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/export-files/jobs-with-files.ts"), "utf8");
    expect(src).toContain('.select("job_id, capture, inspection_answers")');
    expect(src).not.toContain('.not("capture", "is", null)');
    expect(src.match(/\.eq\("org_id", orgId\)/g)?.length).toBe(5);
    expect(src).not.toMatch(/select\("\*"\)/);
  });
});
