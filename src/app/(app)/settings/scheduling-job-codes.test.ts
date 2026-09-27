import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE JOB CODES BOX IS THE SWITCH NOW (0352). It used to ride Save Changes as timeclock_job_codes;
 * that key belongs to the switch board, which only the owner moves. So the owner gets the box (it
 * saves on its own tap), and everyone else gets the state in words: never a box that looks saved
 * and isn't.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ updateOrgSettings: vi.fn(async () => ({ ok: true })) }));
vi.mock("./features-actions", () => ({ setFeature: vi.fn(async () => ({ ok: true })) }));

import { SchedulingSettings } from "./scheduling-settings";
import { getOrgSettings } from "@/lib/org-settings";

const box = (html: string) => {
  const at = html.indexOf("Ask the crew for job codes");
  return at < 0 ? null : html.slice(html.lastIndexOf("<input", at), at);
};

describe("the Job Codes box on Scheduling", () => {
  it("the owner gets the box, showing the switch, saving on its own tap", () => {
    const html = renderToStaticMarkup(createElement(SchedulingSettings, { settings: getOrgSettings({}), isOwner: true }));
    expect(box(html)).toMatch(/ checked=""/);
    expect(html).toContain("Saves as soon as you tap it.");
    const off = renderToStaticMarkup(
      createElement(SchedulingSettings, { settings: getOrgSettings({ features: { job_codes: false } }), isOwner: true }),
    );
    expect(box(off)).not.toMatch(/ checked=""/);
  });

  it("anyone else reads the state and who can change it, with no box", () => {
    const html = renderToStaticMarkup(createElement(SchedulingSettings, { settings: getOrgSettings({ timeclock_job_codes: false }) }));
    expect(box(html)).toBeNull();
    expect(html).toContain("Job codes are off. Only the owner can change this.");
  });
});
