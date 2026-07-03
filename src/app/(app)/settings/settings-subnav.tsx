"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Settings, type LucideIcon } from "lucide-react";
import type { DockNode, DockSection } from "@/lib/dock";
import { SectionSheet } from "@/components/section-sheet";

/** One settings cluster, in the shape the page already knows (id/label/icon). */
export interface SettingsCluster {
  id: string;
  label: string;
  icon: LucideIcon;
}

/**
 * SETTINGS' OWN side-tab — the cluster nav for /settings, now that Settings is its own
 * territory (owned by no dock section, cn-v331). It replaces the old <Tabs> top strip so
 * the SAME left side-tab that shows for the long dock sections shows HERE too — but driving
 * Settings' clusters, not Office's pages (Erik: the left tab "still showing on the screen
 * for office not related to settings but in the way").
 *
 * TWO shapes, matching SectionSubnav's grammar exactly:
 *   - MOBILE (lg:hidden): the SectionSheet visual — the left-edge glass handle opening a
 *     vertical slide-over of the clusters. We synthesize the DockSection/DockNode shapes it
 *     wants ({title:"Settings"} group + one node per cluster, href /settings?tab=<id>) and
 *     pass activeHref /settings?tab=<activeTab> so the current cluster lights.
 *   - DESKTOP (hidden lg:block): a compact top pill row of the same clusters (the dock rail
 *     is already the left column on lg+, so a second left nav would double it).
 *
 * Route-driven (usePathname/useSearchParams), so it stays lit through reloads and deep links.
 */
export function SettingsSubnav({
  clusters,
  activeTab,
}: {
  clusters: SettingsCluster[];
  activeTab: string;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  // Prefer the live ?tab= (instant on client nav); fall back to the server-resolved default.
  const current = search.get("tab") ?? activeTab;

  const href = (id: string) => `/settings?tab=${id}`;
  const activeHref = href(current);

  // Synthesize the SectionSheet contract: a Settings "section" plus one node per cluster.
  const group: DockSection = {
    key: "settings",
    label: "Settings",
    icon: Settings,
    href: pathname,
    children: [],
  };
  const items: DockNode[] = clusters.map((c) => ({
    id: c.id,
    label: c.label,
    icon: c.icon,
    href: href(c.id),
  }));

  return (
    <>
      {/* Mobile: the same left-edge handle + vertical sheet the long dock sections use. */}
      <SectionSheet group={group} items={items} activeHref={activeHref} />

      {/* Desktop: a compact top pill row (the dock rail already owns the left column). */}
      <div className="mb-5 hidden gap-1.5 border-b border-slate-200 pb-3 lg:flex">
        {clusters.map((c) => {
          const active = c.id === current;
          const Icon = c.icon;
          return (
            <Link
              key={c.id}
              href={href(c.id)}
              scroll={false}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-brand text-white shadow-sm"
                  : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Icon className="h-4 w-4" />
              {c.label}
            </Link>
          );
        })}
      </div>
    </>
  );
}
