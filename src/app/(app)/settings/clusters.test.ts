import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SETTINGS CLUSTERS, LOCKED FROM THE SOURCE.
 *
 * Erik: "i dont like having to scroll to look for settings neither does andrew and i want to have
 * the settings broken down into as many setting as possible for each thing on their own page with
 * a sub nav more broken down."
 *
 * The clusters are declared inline in a server component, so there is no export to import — but the
 * two failure modes are both visible in the text, and both have bitten:
 *
 *   1. A NEW CLUSTER WITH NO ICON. CLUSTER_ICONS lives in a different file (settings-subnav.tsx)
 *      because the icon can't cross the RSC boundary. A missing entry falls back to a generic gear,
 *      so eleven nav rows quietly become eleven identical gears — nothing throws, nothing is red.
 *   2. A CLUSTER GROWING BACK. Website reached nine panes and Money & Docs eight before cn-v695
 *      split them, and that growth is what "i have to scroll to look for settings" describes.
 *      Nothing stopped it, because adding one more <Section> to an existing cluster is always the
 *      smaller diff. This is the thing that says no.
 */
const dir = join(process.cwd(), "src/app/(app)/settings");
const page = readFileSync(join(dir, "page.tsx"), "utf8");
const subnav = readFileSync(join(dir, "settings-subnav.tsx"), "utf8");

/** Each cluster literal is `id: "x",` followed by `label:` then `icon:` — nothing else matches. */
const clusters = [...page.matchAll(/id: "([a-z]+)",\n\s+label: "[^"]+",\n\s+icon: /g)].map((m) => m[1]);

describe("settings clusters", () => {
  it("declares the eleven-way split, not the old seven", () => {
    // Not an exact list — new groups are the POINT. A floor, so a future merge has to be deliberate.
    expect(clusters.length).toBeGreaterThanOrEqual(10);
    expect(new Set(clusters).size).toBe(clusters.length);
  });

  it("every cluster the page declares has its own icon in the nav", () => {
    const icons = subnav.slice(subnav.indexOf("CLUSTER_ICONS"), subnav.indexOf("};", subnav.indexOf("CLUSTER_ICONS")));
    for (const id of clusters) expect(icons, `no CLUSTER_ICONS entry for "${id}"`).toContain(`${id}:`);
  });

  it("no cluster is a scroll — at most five panes each", () => {
    // Count <Section> between one cluster's `id:` and the next one's.
    const bounds = clusters.map((id) => page.indexOf(`id: "${id}",`));
    clusters.forEach((id, i) => {
      const body = page.slice(bounds[i], i + 1 < bounds.length ? bounds[i + 1] : page.length);
      const panes = (body.match(/<Section title=/g) ?? []).length;
      expect(panes, `"${id}" holds ${panes} panes — split it rather than growing it`).toBeLessThanOrEqual(5);
    });
  });

  it("keeps the two ids other pages deep-link to", () => {
    // /forms/[id], setup-interview and the onboarding TOUR all link ?tab=playbook or ?tab=you.
    expect(clusters).toContain("playbook");
    expect(page).toContain('id: "you"');
  });

  it("aliases the one id the split retired, so old bookmarks still land", () => {
    expect(page).toMatch(/TAB_ALIASES[^\n]*=\s*\{\s*scheduling: "crew"/);
  });
});
