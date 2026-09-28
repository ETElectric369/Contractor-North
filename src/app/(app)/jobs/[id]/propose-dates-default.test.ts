import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * OFFER DATES OFFERS THE COMPANY'S DAY, NOT 8 AM. Since 0370 a customer's pick lands at the offered
 * time (else the work-day start) for the job's length: an offer pre-filled at a fixed 08:00 put a
 * 9-to-5 company's job an hour before its day began. The three dates start at Settings' work-day
 * start unless the office types another time.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "https://example.test" }));
vi.mock("../../schedule/actions", () => ({ createScheduleProposal: vi.fn(), cancelScheduleProposal: vi.fn() }));

import { defaultSlots } from "./propose-dates-button";

afterEach(() => vi.useRealTimers());

describe("Offer Dates' three dates", () => {
  it("are the next three weekdays at the company's work-day start", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 25, 21, 0)); // a Friday evening
    expect(defaultSlots("09:00")).toEqual([
      { date: "2026-09-28", time: "09:00" },
      { date: "2026-09-29", time: "09:00" },
      { date: "2026-09-30", time: "09:00" },
    ]);
  });

  it("fall back to 8 AM only when the setting isn't a time", () => {
    expect(defaultSlots("").every((s) => s.time === "08:00")).toBe(true);
    expect(defaultSlots("7am").every((s) => s.time === "08:00")).toBe(true);
    expect(defaultSlots("07:30").every((s) => s.time === "07:30")).toBe(true);
  });

  it("the job page hands the button the work day's start", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/<ProposeDatesButton[\s\S]{0,300}dayStart=\{workDay\.start\}/);
    const button = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/propose-dates-button.tsx"), "utf8");
    expect(button).not.toContain('time: "08:00" });');
  });
});
