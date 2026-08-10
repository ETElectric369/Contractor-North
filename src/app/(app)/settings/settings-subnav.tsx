"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Settings,
  User,
  Building2,
  Globe,
  Wallet,
  CalendarDays,
  Plug,
  ClipboardList,
  FileText,
  CreditCard,
  MessageSquare,
  Images,
  type LucideIcon,
} from "lucide-react";
import type { DockNode, DockSection } from "@/lib/dock";
import { SectionSheet } from "@/components/section-sheet";

/** One settings cluster. Only serializable data (id/label) crosses the server→client
 *  boundary — the icon is resolved HERE by id (see CLUSTER_ICONS). Passing the lucide
 *  component itself as a prop is a function-across-the-RSC-boundary, which threw
 *  "Functions cannot be passed directly to Client Components" and crashed all of /settings. */
export interface SettingsCluster {
  id: string;
  label: string;
}

const CLUSTER_ICONS: Record<string, LucideIcon> = {
  you: User,
  company: Building2,
  playbook: ClipboardList,
  website: Globe,
  money: Wallet,
  // cn-v695 split the four fat clusters into eleven nameable ones. `scheduling` stays in the
  // map only because a bookmark can still carry ?tab=scheduling — page.tsx aliases it to `crew`,
  // and an icon for a cluster that no longer exists costs nothing.
  scheduling: CalendarDays,
  crew: CalendarDays,
  docs: FileText,
  getpaid: CreditCard,
  customers: MessageSquare,
  content: Images,
  integrations: Plug,
};

/**
 * SETTINGS' OWN side-tab — the cluster nav for /settings, now that Settings is its own
 * territory (owned by no dock section, cn-v331). It replaces the old <Tabs> top strip so
 * the SAME left side-tab that shows for the long dock sections shows HERE too — but driving
 * Settings' clusters, not Office's pages (Erik: the left tab "still showing on the screen
 * for office not related to settings but in the way").
 *
 * TWO shapes, matching SectionSubnav's grammar exactly:
 *   - BELOW lg (lg:hidden): the SectionSheet visual — the left-edge glass handle opening a
 *     vertical slide-over of the clusters. We synthesize the DockSection/DockNode shapes it
 *     wants ({title:"Settings"} group + one node per cluster, href /settings?tab=<id>) and
 *     pass activeHref /settings?tab=<activeTab> so the current cluster lights.
 *   - AT lg+ (hidden lg:flex): the vertical cluster column. It only earns its 208px at a real
 *     desktop width — below that the dock rail is already 84px, and two left navs plus content
 *     in a ~900px window is what left the content at phone width.
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
  // A ?tab= that names no cluster — a retired id off an old bookmark, which the server aliases
  // for us — must NOT win, or the nav lights nothing while the panel shows something.
  const raw = search.get("tab") ?? activeTab;
  const current = clusters.some((c) => c.id === raw) ? raw : activeTab;

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
    icon: CLUSTER_ICONS[c.id] ?? Settings,
    href: href(c.id),
  }));

  return (
    <>
      {/* Mobile: the same left-edge handle + vertical sheet the long dock sections use. */}
      <SectionSheet group={group} items={items} activeHref={activeHref} />

      {/* Desktop: a compact top pill row (the dock rail already owns the left column). */}
      {/* DESKTOP: A REAL LEFT SIDEBAR, not a pill row.
          Erik: "i really dont like scrolling down a page to find something in the middle" and
          "break down the settings page into a sub nav side bar like the rest".
          A horizontal strip has to stay short to fit, which is exactly the pressure that kept
          thirty sections crammed into six clusters — the nav shape was capping how many honest
          groups there could be. A vertical column has room, so clusters can multiply until each
          one is a thing you can name, and it stays on screen while you read rather than scrolling
          away above you. */}
      <div
        data-tour="sections-settings"
        className="mb-5 hidden w-52 shrink-0 flex-col gap-1 self-start lg:sticky lg:top-4 lg:flex"
      >
        {clusters.map((c) => {
          const active = c.id === current;
          const Icon = CLUSTER_ICONS[c.id] ?? Settings;
          return (
            <Link
              key={c.id}
              // The tour walks somebody to /settings and points at THIS — the cluster their
              // questions and why lines live in. Naming it per-cluster keeps the anchor honest
              // if the order changes.
              data-tour={`settings-${c.id}`}
              href={href(c.id)}
              scroll={false}
              className={`inline-flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                active
                  ? "seaglass-active"
                  : "border border-transparent text-slate-600 hover:bg-white hover:text-[color:rgb(var(--glass-ink))]"
              }`}
            >
              <Icon className="relative z-10 h-4 w-4" />
              <span className="relative z-10">{c.label}</span>
            </Link>
          );
        })}
      </div>
    </>
  );
}
