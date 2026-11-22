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

/**
 * HOW LONG WE KEEP IT SAYS ONLY WHAT THE SWEEP DOES (skeptic #78, cn-v1175). The page said "an uploaded
 * file nothing in North points to any more, after two days", and lib/storage-sweep.ts reaps orphans in
 * three places only (beside the bug screenshots, said in their own clause). The sentence names those
 * three, and the sweep lists exactly those prefixes.
 */
describe("the privacy page's retention paragraph", () => {
  it("names the three places the two-day sweep reaps, and no wider claim", () => {
    expect(src).toContain(
      "and, after two days, a file left behind that nothing in North points to any more: a file sent with a request form that no lead holds, the photos of a visit that was deleted, or a file given to the estimate editor to read.",
    );
    expect(src).not.toContain("an uploaded file nothing in North points to any more");
    expect(src).toContain("signatures and every other file you upload.");
    const sweep = readFileSync(join(process.cwd(), "src/lib/storage-sweep.ts"), "utf8");
    const prefixes = [...sweep.matchAll(/listAll\(svc, [^,]+, `\$\{org\.name\}\/([\w-]+)/g)].map((m) => m[1]);
    expect([...new Set(prefixes)].sort()).toEqual(["ai-uploads", "appointments", "bug-screenshots", "intake"]);
    expect(sweep).toContain("const AGE_MS = 48 * 60 * 60 * 1000;");
  });
});
