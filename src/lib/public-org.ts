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
  settings: OrgSettings;
};

/**
 * Resolve an org for its PUBLIC, unauthenticated site by its settings.public_handle — the one
 * lookup shared by every public org page (the marketing homepage /site/[handle] and the deck
 * estimate configurator /estimate/[handle]). Service client (no session); handle match is
 * parameterized. Returns null when the handle is unknown or the public site is switched off.
 * Wrapped in React cache() so a page + its generateMetadata share a single query per request.
 */
export const getPublicOrgByHandle = cache(async (handle: string): Promise<PublicOrg | null> => {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("organizations")
    .select("id, name, phone, email, license, logo_url, city, state, settings")
    .eq("settings->>public_handle", handle)
    .maybeSingle();
  if (!data) return null;
  const settings = getOrgSettings((data as { settings?: unknown }).settings);
  if (!settings.public_handle) return null;
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
    settings,
  };
});
