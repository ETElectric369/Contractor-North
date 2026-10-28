import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * THE PLAN CARD FOR SOMEONE WHO CANNOT PICK A PLAN (skeptic #43, S12). Settings › Getting Paid's
 * Plan & Subscription card offered Subscribe and Manage Billing to the office and the crew — two
 * doors whose actions refuse them ("Only an owner or admin can manage billing."). For anyone who is
 * not the owner or an admin the card now says who can, by first name, through THE one owner read
 * (lib/lapse-words ownerFirstName) that /subscribe and every paused refusal use. Source pins: the
 * page is a server component with two dozen reads that are not the subject.
 */
const page = readFileSync("src/app/(app)/settings/page.tsx", "utf8");

describe("Settings' plan card, for the office and the crew", () => {
  it("asks the one owner read, only for someone who cannot pick a plan and only with billing on", () => {
    expect(page).toContain('import { ownerFirstName } from "@/lib/lapse-words";');
    expect(page).toContain('const planOwnerFirst = !isAdmin && billingEnabled ? ((await ownerFirstName(profile?.org_id)) ?? "the owner") : null;');
    // No owner read of its own.
    expect(page).not.toContain('.eq("role", "owner")');
  });

  it("Subscribe and Manage Billing are the owner's and an admin's; everyone else reads 'Ask <first name> to pick a plan.'", () => {
    const doors = page.indexOf("isAdmin ? (\n                          <div className=\"mt-4 flex flex-wrap gap-2\">");
    const portal = page.indexOf("<FormSubmit variant=\"outline\">Manage Billing</FormSubmit>");
    const subscribe = page.indexOf("<FormSubmit>Subscribe</FormSubmit>");
    const ask = page.indexOf('Ask {planOwnerFirst ?? "the owner"} to pick a plan.');
    expect(doors).toBeGreaterThan(0);
    expect(portal).toBeGreaterThan(doors);
    expect(subscribe).toBeGreaterThan(portal);
    expect(ask).toBeGreaterThan(subscribe);
    // Both doors sit inside the isAdmin branch, and the ask line is its else.
    const branch = page.slice(doors, ask);
    expect(branch).toContain("Manage Billing");
    expect(branch).toContain("Subscribe");
    expect(branch).toContain(") : (");
    expect((page.match(/<FormSubmit>Subscribe<\/FormSubmit>/g) ?? []).length).toBe(1);
  });
});
