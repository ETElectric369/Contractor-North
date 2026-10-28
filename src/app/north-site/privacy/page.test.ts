import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORT_EMAIL } from "../site-facts";

/**
 * THE PRIVACY PAGE'S "YOUR CHOICES" NAMES THE DOOR (cn-v1138): a copy of the company's data is no
 * longer an email to us — the owner downloads it from Settings › Getting Paid › Your Data. Everyone
 * else (a tech, an office seat, a customer) keeps a path to a copy of THEIR OWN data, a correction
 * and a deletion: by email, through the one support address (the deletion door is not built).
 */
const src = readFileSync(join(__dirname, "page.tsx"), "utf8").replace(/\s+/g, " ");

describe("the privacy page's Your choices", () => {
  it("sends an owner to Settings › Getting Paid › Your Data for a copy, and everyone else to the support address for a copy of their own data, a correction or deletion", () => {
    expect(src).toContain(
      "Owners download everything from Settings › Getting Paid › Your Data. Anyone else can ask us for a copy of their own data, a correction, or deletion at",
    );
    expect(src).toContain('<a href={mailto("Privacy request")}>{SUPPORT_EMAIL}</a>');
    expect(src).not.toContain("Ask us for a copy of your data");
    // The sentence before the fix sent only an owner anywhere: a tech or a customer had no path to a copy.
    expect(src).not.toContain("For a correction, or to delete your account and data, write to");
    expect(SUPPORT_EMAIL).toBe("support@contractornorth.com");
  });

  it("the door it names is the one the settings page mounts (the section's title) and the words match the card", () => {
    const words = readFileSync(join(process.cwd(), "src/app/(app)/settings/your-data-words.ts"), "utf8");
    expect(words).toContain('export const YOUR_DATA_TITLE = "Your Data";');
  });
});
