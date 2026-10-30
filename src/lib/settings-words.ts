/**
 * THE SETTINGS CLUSTERS' NAMES AND A PERSON'S ROLE, IN THE PERSON'S LANGUAGE (cn-v1139). One
 * explicit map from a cluster id to its key in the catalog (lib/words/nav.ts nv_set_<id>; the You
 * tab is the shell's sh_you), shared by settings/page.tsx (which declares the clusters) and
 * settings-subnav.tsx (which draws them), so the two can never disagree on a word.
 *
 * EXPLICIT, NOT BY ACCIDENT: the side-tab hands its clusters to the same SectionSheet that draws
 * the dock, whose dockLabel looks a row up as sh_dock_<id>. A cluster id that happens to be a dock
 * id ("you" is the tech's tile) would have been translated by that coincidence and the other ten
 * never. This map is the one lookup; an id it does not know answers undefined and the caller draws
 * the label it was handed.
 *
 * Client-safe: no server import, so the "use client" side-tab can read it.
 */

/** Cluster id → catalog key. The You tab reads the shell's own word for it. */
export const SETTINGS_CLUSTER_KEYS: Readonly<Record<string, string>> = {
  you: "sh_you",
  company: "nv_set_company",
  playbook: "nv_set_playbook",
  features: "nv_set_features",
  money: "nv_set_money",
  docs: "nv_set_docs",
  getpaid: "nv_set_getpaid",
  crew: "nv_set_crew",
  customers: "nv_set_customers",
  website: "nv_set_website",
  content: "nv_set_content",
  integrations: "nv_set_integrations",
};

/** The cluster's name in the translator's language, or undefined for an id the catalog does not name. */
export function settingsClusterLabel(id: string, t: (key: string) => string): string | undefined {
  const key = SETTINGS_CLUSTER_KEYS[id];
  return key ? t(key) : undefined;
}

/** profiles.role → catalog key (nv_role_<role>). */
export const ROLE_KEYS: Readonly<Record<string, string>> = {
  owner: "nv_role_owner",
  admin: "nv_role_admin",
  office: "nv_role_office",
  tech: "nv_role_tech",
};

/** A role's word in the translator's language ("owner" → Owner / Dueño), or undefined for a role the catalog does not name. */
export function roleLabel(role: string | null | undefined, t: (key: string) => string): string | undefined {
  const key = role ? ROLE_KEYS[role] : undefined;
  return key ? t(key) : undefined;
}
