import type { OrgSettings } from "@/lib/org-settings";

/**
 * THE HEADING TYPEFACE LEVER (Erik, in the studio, night one: the honesty list told him fonts
 * had no field — this is the field). A curated preset set, not free font names: every option is
 * a face that holds up on a contractor site, loaded from Google Fonts only on the public site
 * routes (the app keeps Geist). HEADINGS ONLY — body stays the system stack, which is what keeps
 * a bad pick recoverable and the page fast.
 */
export const SITE_FONTS = {
  default: null,
  serif: {
    label: "Editorial serif (Fraunces)",
    css: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&display=swap",
    family: `"Fraunces", Georgia, serif`,
  },
  grotesk: {
    label: "Modern grotesk (Space Grotesk)",
    css: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&display=swap",
    family: `"Space Grotesk", system-ui, sans-serif`,
  },
  soft: {
    label: "Soft rounded (Nunito)",
    css: "https://fonts.googleapis.com/css2?family=Nunito:wght@700;800&display=swap",
    family: `"Nunito", system-ui, sans-serif`,
  },
  condensed: {
    label: "Condensed wordmark (Oswald)",
    css: "https://fonts.googleapis.com/css2?family=Oswald:wght@500;600&display=swap",
    family: `"Oswald", system-ui, sans-serif`,
  },
} as const;
export type SiteFontKey = keyof typeof SITE_FONTS;

export function siteFontKey(v: unknown): SiteFontKey {
  return v === "serif" || v === "grotesk" || v === "soft" || v === "condensed" ? v : "default";
}

/**
 * THE DENSITY LEVER (Erik hit the spacing wall twice in one night — v6 and v8 both ended in
 * "spacing not controllable"). Whole-page rhythm, not per-section layout: the site's vertical
 * paddings live in seven Tailwind steps, and a scoped override rescales all of them together.
 * compact ≈ ×0.65, airy ≈ ×1.45. "default" emits nothing — existing sites byte-identical.
 * Per-section spacing and unstacking stay honestly impossible until the Phase 2 components.
 */
const DENSITY_SCALES: Record<string, Record<string, string> | null> = {
  default: null,
  compact: {
    "py-10": "1.75rem",
    "py-12": "2rem",
    "py-14": "2.25rem",
    "py-16": "2.75rem",
    "py-20": "3.25rem",
    "py-24": "4rem",
    "py-28": "4.5rem",
    "py-32": "5.25rem",
  },
  airy: {
    "py-10": "3.5rem",
    "py-12": "4.25rem",
    "py-14": "5rem",
    "py-16": "5.75rem",
    "py-20": "7.25rem",
    "py-24": "8.5rem",
    "py-28": "10rem",
    "py-32": "11.5rem",
  },
};

export function siteDensityKey(v: unknown): "default" | "compact" | "airy" {
  return v === "compact" || v === "airy" ? v : "default";
}

/** Mounted inside each public-site root (they all carry the `site-shell` class). Renders nothing
 *  for the default presets, so existing sites are byte-identical until an org chooses. */
export function SiteFonts({ settings }: { settings: OrgSettings }) {
  const preset = SITE_FONTS[siteFontKey(settings.site_font)];
  // THE BUSINESS NAME'S OWN FACE (Erik: "change the font for ET Electric on the top only") —
  // every spot the name renders carries the `site-brand` class; this styles them all at once,
  // independent of the headings.
  const brandPreset = SITE_FONTS[siteFontKey(settings.brand_font)];
  const density = DENSITY_SCALES[siteDensityKey(settings.site_density)];
  if (!preset && !brandPreset && !density) return null;
  // Bare classes AND their sm: responsive variants: Tailwind v4 layers mean these unlayered
  // rules beat every utility, so without the sm block a responsive step-up (py-20 sm:py-24)
  // would FLATTEN to the base scale instead of rescaling (review). The sm: selector needs the
  // escaped colon.
  const densityCss = density
    ? Object.entries(density)
        .map(([cls, pad]) => `.site-shell .${cls} { padding-top: ${pad}; padding-bottom: ${pad}; }`)
        .join("\n") +
      "\n@media (min-width: 640px) {\n" +
      Object.entries(density)
        .map(([cls, pad]) => `.site-shell .sm\\:${cls} { padding-top: ${pad}; padding-bottom: ${pad}; }`)
        .join("\n") +
      "\n}"
    : "";
  // One <link> per distinct family (heading + brand may share or differ).
  const cssLinks = [...new Set([preset?.css, brandPreset?.css])].filter((x): x is NonNullable<typeof x> => !!x);
  return (
    <>
      {cssLinks.map((href) => (
        // eslint-disable-next-line @next/next/no-page-custom-font
        <link key={href} rel="stylesheet" href={href} />
      ))}
      <style>
        {(preset ? `.site-shell h1, .site-shell h2, .site-shell h3 { font-family: ${preset.family}; }\n` : "") +
          (brandPreset ? `.site-shell .site-brand { font-family: ${brandPreset.family}; }\n` : "") +
          densityCss}
      </style>
    </>
  );
}
