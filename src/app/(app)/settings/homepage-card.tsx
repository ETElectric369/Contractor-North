import { ExternalLink } from "lucide-react";
import type { OrgSettings } from "@/lib/org-settings";
import type { Block } from "@/lib/site-blocks";
import { SplashSettings } from "./splash-settings";
import { HomeBlocksEditor } from "./home-blocks-editor";

/**
 * THE homepage editor — one card mirroring the one homepage model: an always-on-top banner
 * (SplashSettings) + optional custom sections that replace the standard layout below it
 * (HomeBlocksEditor). Shared by BOTH editing surfaces (settings ▸ Website and the /content
 * collaborator workspace) so they can't drift; each surface wraps this in its own card chrome
 * with the "Homepage" title.
 */
export function HomepageCard({
  settings,
  homeBlocks,
  brand,
  orgId,
  siteUrl,
}: {
  settings: OrgSettings;
  homeBlocks: Block[];
  brand?: string;
  orgId: string;
  siteUrl?: string | null;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-xl text-sm text-slate-500">
          The banner always sits on top; custom sections replace the standard layout below it. Saves go live on your site immediately.
        </p>
        {siteUrl && (
          <a href={siteUrl} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand hover:underline">
            View live <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
      <div>
        <h4 className="mb-3 text-sm font-semibold text-slate-700">Top banner</h4>
        <SplashSettings settings={settings} portfolio={settings.portfolio ?? []} orgId={orgId} />
      </div>
      <div className="border-t border-slate-100 pt-5">
        <h4 className="mb-3 text-sm font-semibold text-slate-700">Sections below the banner</h4>
        <HomeBlocksEditor initial={homeBlocks} brand={brand} orgId={orgId} />
      </div>
    </div>
  );
}
