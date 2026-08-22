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
} as const;
export type SiteFontKey = keyof typeof SITE_FONTS;

export function siteFontKey(v: unknown): SiteFontKey {
  return v === "serif" || v === "grotesk" || v === "soft" ? v : "default";
}

/** Mounted inside each public-site root (they all carry the `site-shell` class). Renders nothing
 *  for the default preset, so existing sites are byte-identical until an org chooses a face. */
export function SiteFonts({ settings }: { settings: OrgSettings }) {
  const preset = SITE_FONTS[siteFontKey(settings.site_font)];
  if (!preset) return null;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href={preset.css} />
      <style>{`.site-shell h1, .site-shell h2, .site-shell h3 { font-family: ${preset.family}; }`}</style>
    </>
  );
}
