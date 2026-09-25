import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { BackLink } from "@/components/back-link";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { DocHeader, templateFor } from "@/components/doc-templates";
import { CircuitMapSchedule, PanelDoorCard } from "@/components/panel-directory";
import { directoryFromRows, panelHeading, unpanelledFromRows } from "@/lib/panel/directory";
import { SITE_COLS, pickSite, siteLines, type SiteParts } from "@/lib/site-address";
import { getOrgSettings } from "@/lib/org-settings";
import { docTitle } from "@/lib/doc-title";
import { formatDate } from "@/lib/utils";
import type { JobCircuit, JobPanel, Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE PANEL DIRECTORY, PRINTED (Panel plan, phase 5): Print Panel Directory and Save As Circuit Map
 * both render this page (the PDF engine prints it; /api/pdf/panel/<job>). It replaces the map Erik
 * built by hand for J-011 on 2026-09-25:
 *
 *   1. THE DOOR CARD, one page per panel that has circuits in spaces: two columns in space order,
 *      the way the door hangs, to tape inside it.
 *   2. THE CIRCUIT MAP, the hand-built map's content: the company's letterhead, the address, who it
 *      was prepared for and the day, the chips (22 circuits, 3 at 15 A, 16 at 20 A, 3 at 240 V), a
 *      section per size with each circuit's room, what it feeds (and the door's words when they
 *      differ), and its size, then the note about the circuits already in the panel.
 *
 * WHAT IS ON IT: only the customer-safe directory (lib/panel/directory), the same shape the portal
 * gets, because Save As Circuit Map puts this very page on the customer's Plans And Drawings. The
 * read below never asks for a wire tag, a note, progress, a source or who did what (the projection
 * law: a column never selected cannot leak). Kept circuits only; a suggestion, a circuit taken off
 * and one coming out are not on it.
 *
 * WHO: any active member of the job's org (the crew print the door card at the panel too). RLS on
 * job_panels / job_circuits (0333) is the boundary; a job outside the org is a 404.
 */
export async function generateMetadata({ params }: { params: Promise<{ jobId: string }> }): Promise<Metadata> {
  const { jobId } = await params;
  if (!UUID.test(jobId)) return { title: "Panel Directory" };
  const supabase = await createClient();
  const { data } = await supabase.from("jobs").select("name").eq("id", jobId).maybeSingle();
  return { title: docTitle("Panel Directory", (data as { name?: string | null } | null)?.name) };
}

export default async function PanelDirectoryPrintPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID.test(jobId)) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();
  const { data: me } = await supabase.from("profiles").select("org_id, active").eq("id", user.id).maybeSingle();
  const my = me as { org_id?: string | null; active?: boolean | null } | null;
  if (!my?.org_id || my.active === false) notFound();

  const { data: job } = await supabase
    .from("jobs")
    .select(`id, name, job_number, ${SITE_COLS}, customer_id, customers(name, ${SITE_COLS})`)
    .eq("id", jobId)
    .eq("org_id", my.org_id)
    .maybeSingle();
  if (!job) notFound();
  const j = job as unknown as {
    id: string;
    name: string | null;
    job_number: string | null;
    address: string | null;
    unit: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    customers: ({ name: string | null } & SiteParts) | null;
  };

  const [{ data: org }, { data: panelRows }, { data: circuitRows }] = await Promise.all([
    supabase.from("organizations").select("*").eq("id", my.org_id).maybeSingle(),
    supabase
      .from("job_panels")
      .select("id, name, brand, main_amps, spaces, numbering, dead_spaces, created_at")
      .eq("job_id", jobId)
      .eq("org_id", my.org_id)
      .is("removed_at", null)
      .order("created_at"),
    // Only what the directory draws, and only what is kept and live.
    supabase
      .from("job_circuits")
      .select("id, panel_id, room, description, panel_label, amps, poles, kind, space, half, work, state, removed_at, sort_order")
      .eq("job_id", jobId)
      .eq("org_id", my.org_id)
      .eq("state", "kept")
      .is("removed_at", null)
      .order("sort_order")
      .order("created_at"),
  ]);
  const panels = (panelRows ?? []) as unknown as JobPanel[];
  const circuits = (circuitRows ?? []) as unknown as JobCircuit[];
  const directories = panels.map((p) => directoryFromRows(p, circuits));
  const loose = unpanelledFromRows(circuits, panels.map((p) => p.id));
  const doors = directories.filter((d) => d.circuits.some((c) => c.space != null));
  const everything = [...directories.flatMap((d) => d.circuits), ...loose];

  const o = org as Organization | null;
  const company = companyFromOrg(o);
  const template = templateFor(o, "panel_directory");
  const tz = getOrgSettings((o as { settings?: unknown } | null)?.settings).timezone;
  // The day it was PRINTED, said as that: the page is drawn fresh every time, so it can't honestly
  // say when the circuits last changed ("Revised" on every print would claim a change nobody made).
  const printed = formatDate(new Date(), tz);
  const site = siteLines(pickSite([{ source: "job", parts: j }, { source: "customer", parts: j.customers }]));
  const jobName = j.name?.trim() || site[0] || "This Job";
  const customer = j.customers?.name?.trim() || null;
  const footer = (
    <div className="mt-8 flex flex-wrap items-baseline justify-between gap-2 border-t border-slate-300 pt-2 text-[10px] text-slate-600">
      <span>
        Keep this with the panel. Questions about any circuit: {company.name}
        {o?.phone ? `, ${o.phone}` : ""}.
      </span>
      <span>{[company.name, o?.license].filter(Boolean).join(" · ")}</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-between px-4">
        <BackLink fallback={`/jobs/${jobId}?tab=panel`} fallbackLabel="Back" className="inline-flex min-h-[44px] items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800" />
        <PrintButton label="Print Panel Directory" />
      </div>

      {doors.map((d, i) => (
        <div key={`door-${i}`} className="print-page mx-auto mb-6 bg-white shadow-sm" style={i > 0 ? { breakBefore: "page" } : undefined} data-print-sheet="door">
          <DocHeader
            co={company}
            template={template}
            meta={{ docType: "Panel Directory", number: d.name, rows: [{ label: "Job", value: jobName }, { label: "Printed", value: printed }] }}
          />
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-bold text-slate-900">{panelHeading(d)}</h2>
            <span className="text-[11px] text-slate-600">
              {d.numbering === "bottom_up" ? "Space 1 is at the bottom." : "Space 1 is at the top."} Odd spaces left, even right.
            </span>
          </div>
          <PanelDoorCard panel={d} />
          {footer}
        </div>
      ))}

      <div className="print-page mx-auto bg-white shadow-sm" style={doors.length ? { breakBefore: "page" } : undefined} data-print-sheet="map">
        <DocHeader
          co={company}
          template={template}
          meta={{
            docType: "Circuit Map",
            number: jobName,
            rows: [...(customer ? [{ label: "Prepared For", value: customer }] : []), { label: "Printed", value: printed }],
          }}
        />
        {site.length ? (
          <div className="mb-4 text-sm text-slate-700">
            {site.map((l) => (
              <div key={l}>{l}</div>
            ))}
          </div>
        ) : null}
        <CircuitMapSchedule circuits={everything} />
        {footer}
      </div>
    </div>
  );
}
