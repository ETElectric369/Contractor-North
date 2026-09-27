import type { LucideIcon } from "lucide-react";
import type { TabDef } from "@/components/tabs";
import { FeatureOffLine } from "@/components/feature-off-line";
import { ALL_ON, featureOn, type FeatureKey, type FeatureMap } from "@/lib/features";
// The More-panel chip icons must come through a "use client" re-export so the
// component REFERENCES survive the server→client serialization into <Tabs>.
import {
  LayoutDashboard, Clock, Package, Camera, ListChecks, CalendarDays,
  ClipboardCheck, FileText, DollarSign, Receipt as ReceiptTab, StickyNote, Stamp, FileDiff, Eye, Zap,
} from "./job-tab-icons";

// In-page nav order — the lifecycle-honest strip. The pinned chips (per role, below)
// lead in this order; everything else clusters into the More chip in this order.
export const JOB_TAB_ORDER = [
  "job", "tasks", "time", "materials", "costs", "invoices", "photos", "appointments",
  "notes", "quotes", "change-orders", "permits", "panel", "wos", "customer",
];
// THE CHIPS THAT STAY PUT (Erik, 2026-09-11: "overview - time - materials - invoices be
// seaglass buttons that stay put and the little arrow drop down for more"). Two sets,
// because the money chips can't render for a tech (tech-job-access: a control a role
// can't use must not render) — his other chip is Photos, the crew's other one-tap door.
// Pinned chips are never measured or folded (<Tabs look="tiles">), which is what ends
// Costs and Invoices living behind More on every phone: the old measured strip fit ~3
// of its four "primaries" at 343px, so the money tabs never once stayed inline.
//
// TASKS RIGHT AFTER OVERVIEW, for both (Erik, 2026-09-26: "put it on the bottom bar next to
// overview"). SIX CHIPS IS THE PHONE'S ROW: at 375 (343px inside the page) the tiles share the
// width at gap-1.5, and seven would be 43.9px each (under the 44px minimum) with "Overview" (42px of
// text at 10px Geist) and "Materials" (41px) cut off inside chips that have 39.9px of room — measured
// in Geist, 2026-09-26. Six is 52.2px each with every word whole. So for the office the LAST pinned
// chip, Invoices, folds into More (its "Money" cluster, one tap away), and the crew's row is
// Overview, Tasks, Time, Materials, Photos + More: six, as it was for the office before.
export const JOB_PINNED_STAFF: ReadonlySet<string> = new Set(["job", "tasks", "time", "materials", "costs"]);
export const JOB_PINNED_TECH: ReadonlySet<string> = new Set(["job", "tasks", "time", "materials", "photos"]);
// "customer" (what the customer sees): the link, the stretches and the picks are the office's.
export const JOB_STAFF_ONLY = new Set(["costs", "quotes", "invoices", "change-orders", "customer"]);
// THE TABS A SWITCH OWNS (the switch board, 0352). While the switch is off the tab loses its chip
// (offStrip), and a ?tab= link (a bell, a Needs You card, a bookmark) still opens it, with the Off
// line on top. Nothing on the tab is read differently: its rows, counts and money are the same.
// Only the pinned core tabs never appear here, so a switch can never take a pinned chip away.
export const JOB_TAB_FEATURE: Readonly<Record<string, FeatureKey>> = {
  quotes: "estimates",
  "change-orders": "estimates",
  wos: "estimates",
  permits: "permits",
  panel: "panel_map",
  customer: "customer_portal",
};

// Cluster header + icon per tab. The LucideIcon COMPONENT reference is the chip's own
// 18px glyph on the strip AND the chamfered glass chip in the More panel. The whole
// Money cluster is staffOnly, so it vanishes for techs as a unit.
const JOB_TAB_META: Record<string, { group?: string; icon?: LucideIcon }> = {
  job: { icon: LayoutDashboard },
  time: { icon: Clock },
  materials: { icon: Package },
  photos: { group: "Docs", icon: Camera },
  tasks: { icon: ListChecks },
  appointments: { group: "Work", icon: CalendarDays },
  wos: { group: "Work", icon: ClipboardCheck },
  quotes: { group: "Money", icon: FileText },
  // DollarSign, not Wallet: a wallet and a box (Materials' Package) share the same
  // rounded-rect silhouette at glance size — $ vs box can't be confused.
  costs: { group: "Money", icon: DollarSign },
  invoices: { group: "Money", icon: ReceiptTab },
  "change-orders": { group: "Money", icon: FileDiff },
  notes: { group: "Docs", icon: StickyNote },
  permits: { group: "Docs", icon: Stamp },
  // THE PANEL (0333): the job's circuits. Not pinned and not staff-only — the crew works it at the
  // panel (Erik's decision 1, 2026-09-25) and nothing on it carries a price.
  panel: { group: "Docs", icon: Zap },
  customer: { group: "Money", icon: Eye },
};

/** Order the job tabs and tag each with its pin + cluster + staff-gating, so
 *  <Tabs look="tiles"> keeps the role's five chips put and folds the rest
 *  into a clustered, bloom-skinned "More" chip. staffOnly is honored TWICE: the
 *  page drops those tabs before passing them (so their content never serializes
 *  to a tech), and <Tabs> filters again on the client. `switches` omitted = everything on. */
export function arrangeJobTabs(
  tabs: TabDef[],
  viewerIsStaff: boolean,
  switches: { features: FeatureMap; isOwner: boolean } = { features: ALL_ON, isOwner: false },
): TabDef[] {
  const pinned = viewerIsStaff ? JOB_PINNED_STAFF : JOB_PINNED_TECH;
  return [...tabs]
    .sort((a, b) => JOB_TAB_ORDER.indexOf(a.id) - JOB_TAB_ORDER.indexOf(b.id))
    .map((t) => {
      const feature: FeatureKey | undefined = JOB_TAB_FEATURE[t.id];
      const off = !!feature && !featureOn(switches.features, feature);
      return {
        ...t,
        ...(JOB_TAB_META[t.id] ?? {}),
        pinned: pinned.has(t.id),
        staffOnly: JOB_STAFF_ONLY.has(t.id),
        // A switched-off feature's tab loses its chip and still opens from a ?tab= link. (Tasks used
        // to ride this rail too, its door a slot in the action dock; since 0358 it is a pinned chip
        // and the dock slot is gone — one door, not two.)
        offStrip: off,
        content:
          off && feature ? (
            <>
              <FeatureOffLine feature={feature} features={switches.features} isOwner={switches.isOwner} />
              {t.content}
            </>
          ) : (
            t.content
          ),
      };
    });
}
