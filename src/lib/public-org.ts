import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { getOrgSettings, type OrgSettings } from "@/lib/org-settings";

export type PublicOrg = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  license: string | null;
  logo_url: string | null;
  city: string | null;
  state: string | null;
  /** organizations.updated_at (touch trigger) — the sitemap folds it into the homepage
   *  <lastmod>, since most homepage content lives in settings, not posts/pages. */
  updated_at: string | null;
  settings: OrgSettings;
};

/**
 * Resolve an org for its PUBLIC, unauthenticated site by its settings.public_handle — the one
 * lookup shared by every public org page (the marketing homepage /site/[handle] and the deck
 * estimate configurator /estimate/[handle]). Service client (no session); handle match is
 * parameterized. Returns null when the handle is unknown or the public site is switched off.
 * Wrapped in React cache() so a page + its generateMetadata share a single query per request.
 */
function toPublicOrg(data: unknown): PublicOrg | null {
  if (!data) return null;
  const settings = getOrgSettings((data as { settings?: unknown }).settings);
  if (!settings.public_handle) return null; // site switched off
  const o = data as Record<string, unknown>;
  return {
    id: o.id as string,
    name: o.name as string,
    phone: (o.phone as string) ?? null,
    email: (o.email as string) ?? null,
    license: (o.license as string) ?? null,
    logo_url: (o.logo_url as string) ?? null,
    city: (o.city as string) ?? null,
    state: (o.state as string) ?? null,
    updated_at: (o.updated_at as string) ?? null,
    settings,
  };
}

const SELECT = "id, name, phone, email, license, logo_url, city, state, updated_at, settings";

export const getPublicOrgByHandle = cache(async (handle: string): Promise<PublicOrg | null> => {
  const supabase = createServiceClient();
  // .limit(1) so a stray duplicate can never make maybeSingle() throw and 404 a live site.
  const { data } = await supabase.from("organizations").select(SELECT).eq("settings->>public_handle", handle).limit(1).maybeSingle();
  return toPublicOrg(data);
});

/** Resolve an org by a custom domain it has pointed at us (settings.custom_domain). Host is
 *  normalized (lowercased, port + a leading www. stripped) so www.example.com and example.com
 *  both match a stored "example.com". Used by the by-domain public route. */
export const getPublicOrgByDomain = cache(async (rawHost: string): Promise<PublicOrg | null> => {
  const host = String(rawHost || "").toLowerCase().split(":")[0].replace(/^www\./, "").trim();
  if (!host) return null;
  const supabase = createServiceClient();
  const { data } = await supabase.from("organizations").select(SELECT).eq("settings->>custom_domain", host).limit(1).maybeSingle();
  return toPublicOrg(data);
});
