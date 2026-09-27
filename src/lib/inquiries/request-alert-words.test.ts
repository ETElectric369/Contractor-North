import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A REQUEST IS CALLED WHAT IT IS WHERE IT LANDS (the switch board, 0352). Leads on: the bell, the
 * push and the email say "lead" and open the lead list, word for word as always. Leads off: they
 * open My Day, so they say "request" and the email's button names My Day.
 */
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn() }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(), orgStaffIds: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(), clientIp: vi.fn() }));

const { requestAlertWords } = await import("./create-triaged-inquiry");

describe("requestAlertWords", () => {
  it("Leads on: exactly the lead words as before", () => {
    expect(requestAlertWords("/leads")).toEqual({
      head: "🔥 New lead",
      subject: "New lead",
      button: "Open the lead →",
      footer: "Reach out fast — speed-to-lead wins the job.",
    });
    expect(requestAlertWords("/leads", true).head).toBe("🔁 Lead came back");
    expect(requestAlertWords("/leads", true).subject).toBe("Lead came back");
  });

  it("Leads off: a request, and the button names where it opens", () => {
    const w = requestAlertWords("/planner");
    expect(w.head).toBe("🔥 New request");
    expect(w.subject).toBe("New request");
    expect(w.button).toBe("Open My Day →");
    expect(JSON.stringify(w)).not.toMatch(/\blead\b/i);
    expect(requestAlertWords("/planner", true).head).toBe("🔁 Request came back");
  });

  it("the bell, the push and the email all read the words from where the alert opens", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/inquiries/create-triaged-inquiry.ts"), "utf8");
    expect(src).toContain("const words = requestAlertWords(url, !!opts.cameBack);");
    expect(src).toContain("const title = `${words.head} — ${input.name}`;");
    expect(src).toContain("${words.button}</a>");
    expect(src).not.toContain(">Open the lead →<");
  });

  it("the site-visit alert and the morning digest follow the same switch", () => {
    const sched = readFileSync(join(process.cwd(), "src/lib/actions/public-schedule.ts"), "utf8");
    expect(sched).toContain('(url === "/leads" ? "Open the lead to send time options." : "Open My Day to send time options.")');
    const digest = readFileSync(join(process.cwd(), "src/lib/action-items/digest.ts"), "utf8");
    expect(digest).toContain('featureOn(getOrgSettings(org.settings).features, "leads") ? "New lead" : "New request"');
  });
});
