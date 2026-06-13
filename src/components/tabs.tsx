"use client";

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

export interface TabDef {
  id: string;
  label: string;
  count?: number;
  content: React.ReactNode;
}

/**
 * A top tab bar that shows one panel at a time.
 *
 * By default tabs are client-only (useState). Pass `urlSync` to make the active
 * tab deep-linkable: the initial tab is read from `?<paramKey>=` on load (so the
 * tab survives a reload and can be linked to, e.g. `/jobs/x?tab=invoices`), and
 * switching updates the URL via history.replaceState — instant, no server
 * round-trip, and other query params (e.g. `?week=`) are preserved.
 */
export function Tabs({
  tabs,
  urlSync = false,
  paramKey = "tab",
}: {
  tabs: TabDef[];
  urlSync?: boolean;
  paramKey?: string;
}) {
  if (urlSync) return <UrlSyncedTabs tabs={tabs} paramKey={paramKey} />;
  return <StatefulTabs tabs={tabs} />;
}

function StatefulTabs({ tabs }: { tabs: TabDef[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  return <TabView tabs={tabs} activeId={active} onSelect={setActive} />;
}

function UrlSyncedTabs({ tabs, paramKey }: { tabs: TabDef[]; paramKey: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fromUrl = searchParams.get(paramKey);
  const initial = tabs.some((t) => t.id === fromUrl) ? (fromUrl as string) : tabs[0]?.id;
  const [active, setActive] = useState(initial);

  function onSelect(id: string) {
    setActive(id);
    // Reflect the tab in the URL without a navigation/refetch — keeps switching
    // instant while making the tab shareable + reload-safe. Rebuild the query so
    // other params survive.
    const params = new URLSearchParams(searchParams.toString());
    params.set(paramKey, id);
    window.history.replaceState(null, "", `${pathname}?${params.toString()}`);
  }

  return <TabView tabs={tabs} activeId={active} onSelect={onSelect} />;
}

function TabView({
  tabs,
  activeId,
  onSelect,
}: {
  tabs: TabDef[];
  activeId?: string;
  onSelect: (id: string) => void;
}) {
  const current = tabs.find((t) => t.id === activeId) ?? tabs[0];

  return (
    <div>
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={cn(
              "flex items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              activeId === t.id
                ? "border-brand text-brand"
                : "border-transparent text-slate-500 hover:text-slate-800",
            )}
          >
            {t.label}
            {typeof t.count === "number" && t.count > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  activeId === t.id ? "bg-brand-light text-brand-dark" : "bg-slate-100 text-slate-500",
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>
      <div>{current?.content}</div>
    </div>
  );
}
