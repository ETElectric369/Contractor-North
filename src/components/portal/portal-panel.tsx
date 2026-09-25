import { PanelDirectoryList } from "@/components/panel-directory";
import type { DirectoryPanel } from "@/lib/panel/directory";

/**
 * "YOUR PANEL" ON THE CUSTOMER'S JOB PAGE (0335; Panel plan, phase 5). Shown only once the office
 * turns on "Show The Panel On Their Page" for the job; live, like the rest of the page. Drawn by the
 * one directory renderer (components/panel-directory), from the customer-safe shape alone: where
 * each circuit sits, what the door says, what it feeds when that differs, its size and type, and a
 * New tag on the new work. No part numbers, suppliers, prices, wire tags, notes, progress, or
 * suggestions nobody kept; the database never sends them.
 */
export function PortalPanel({ panels }: { panels: DirectoryPanel[] }) {
  return (
    <div className="portal-glass space-y-4 rounded-2xl p-4">
      {panels.map((p, i) => (
        <PanelDirectoryList key={`${p.name}-${i}`} panel={p} />
      ))}
      <p className="px-1 text-xs text-slate-700">This is the list on your panel door. Your electrician keeps it current.</p>
    </div>
  );
}
