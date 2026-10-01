import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WEB_SOURCES, isWebSource } from "./sources";

/**
 * EVERY LEAD DOOR'S SOURCE IS ONE THE ROW KNOWS (W2-07). The lead row draws the Globe ("From Your
 * Website") from WEB_SOURCES, so a door that writes a source the list doesn't carry would file its
 * web leads as typed by hand. Each door's `source: "<literal>"` is either a website door (in
 * WEB_SOURCES) or "manual" (the office's New Lead). A door that no longer exists is skipped: the
 * website's contact form (app/site/actions.ts) is to be folded into the one lead link.
 */
const DOORS = [
  "src/app/intake/[handle]/actions.ts",
  "src/app/site/actions.ts",
  "src/app/api/site-chat/route.ts",
  "src/app/estimate/[handle]/actions.ts",
  "src/app/(app)/leads/actions.ts",
];

describe("the lead doors write sources the row knows", () => {
  it("every source literal is a website door or manual", () => {
    const seen: string[] = [];
    for (const door of DOORS) {
      const abs = join(process.cwd(), door);
      if (!existsSync(abs)) continue;
      const src = readFileSync(abs, "utf8");
      for (const m of src.matchAll(/\bsource:\s*["'`]([^"'`]+)["'`]/g)) {
        seen.push(m[1]);
        expect(m[1] === "manual" || isWebSource(m[1]), `${door}: source "${m[1]}"`).toBe(true);
      }
    }
    // The scan saw the doors it was written for (so an empty scan can't pass).
    expect(seen).toContain("manual");
    expect(seen).toContain("intake");
    expect(seen).toContain("deck_configurator");
    expect(seen).toContain("site_chat");
  });

  it("the list is the website's doors, plus the one stored legacy value", () => {
    expect([...WEB_SOURCES]).toEqual(["public_form", "intake", "website_contact", "site_chat", "deck_configurator", "tahoe_deck"]);
    expect(isWebSource("manual")).toBe(false);
    expect(isWebSource(null)).toBe(false);
    expect(isWebSource(undefined)).toBe(false);
  });
});
