"use client";

import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Flag, RotateCcw, X } from "lucide-react";
import { EmptyState } from "@/components/page-header";
import { toneClasses, type Tone } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { setErrorEventStatus, type ErrorEvent } from "./error-actions";

/**
 * THE ERROR SINK, TRIAGED ON BUG WATCH (cn-v1136). Modelled on bug-list.tsx: tabs by status, a tenant
 * row when more than one company is on the page, an optimistic mark with a toast revert, and a
 * failed read said where the list would be — never an empty run, never "all clear" over a refusal.
 * Each row unfolds the sink's first sighting as it was caught, and the latest repeat when it differs.
 *
 * TRACES HAVE THEIR OWN TAB (skeptic #42, S4): a trace is a footprint the client shipped, not work,
 * so it is never on New / Triaged / Fixed / Ignored, and the New count — the badge's error half —
 * counts only open non-trace rows. All shows everything the two reads brought.
 */
export const TABS = [
  { key: "new", label: "New" },
  { key: "triaged", label: "Triaged" },
  { key: "fixed", label: "Fixed" },
  { key: "ignored", label: "Ignored" },
  { key: "traces", label: "Traces" },
  { key: "all", label: "All" },
] as const;
export type ErrorTab = (typeof TABS)[number]["key"];

export const statusOf = (r: Pick<ErrorEvent, "status">) => r.status || "new";
/** Open work: new or triaged. Fixed and ignored are closed and can only be reopened. */
export const isOpenStatus = (status: string) => status === "new" || status === "triaged";
/** A trace row: the client's footprint, kept fourteen days, never an error. */
export const isTrace = (r: Pick<ErrorEvent, "level">) => r.level === "trace";
/** The New tab's number, which is the badge's error half (bug-watch-count): open, new, not a trace. */
export const countNew = (rows: ErrorEvent[]) => rows.filter((r) => !isTrace(r) && statusOf(r) === "new").length;

/** The level pill, from the ONE palette (ui/badge): a blocker red, an error amber, a trace grey. */
export function levelPill(level: string): { word: string; tone: Tone } {
  if (level === "blocker") return { word: "Blocker", tone: "red" };
  if (level === "trace") return { word: "Trace", tone: "slate" };
  return { word: "Error", tone: "amber" };
}

/** The doors a row offers, by its status. An open row can be marked triaged (while new), fixed or
 *  ignored; a closed row reopens — and a reopened row is new again, as a returning error would be. */
export function actionsFor(status: string): { label: string; next: string }[] {
  if (status === "new") return [{ label: "Triaged", next: "triaged" }, { label: "Fixed", next: "fixed" }, { label: "Ignore", next: "ignored" }];
  if (status === "triaged") return [{ label: "Fixed", next: "fixed" }, { label: "Ignore", next: "ignored" }];
  return [{ label: "Reopen", next: "new" }];
}

/** The rows a tab and a tenant filter leave: Traces holds every trace whatever its status, the four
 *  status tabs hold no trace, All holds everything. */
export function shownErrors(rows: ErrorEvent[], tab: ErrorTab, orgFilter: string): ErrorEvent[] {
  return rows
    .filter((r) => (tab === "all" ? true : tab === "traces" ? isTrace(r) : !isTrace(r) && statusOf(r) === tab))
    .filter((r) => !orgFilter || r.org === orgFilter);
}

const pretty = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
};

/** What a row unfolds: the first sighting as the sink caught it, and the latest repeat only when its
 *  payload differs (the same words twice would say nothing; jsonb comes back key-sorted, so the text
 *  compares). */
export function detailBlocks(r: Pick<ErrorEvent, "payload" | "last_payload">): { heading: string; json: string }[] {
  const first = pretty(r.payload);
  const blocks = [{ heading: "First Sighting", json: first }];
  if (r.last_payload !== null && r.last_payload !== undefined) {
    const latest = pretty(r.last_payload);
    if (latest !== first) blocks.push({ heading: "Latest", json: latest });
  }
  return blocks;
}

const ACTION_ICON: Record<string, { Icon: React.ComponentType<{ className?: string }>; hover: string }> = {
  triaged: { Icon: Flag, hover: "hover:text-blue-600" },
  fixed: { Icon: Check, hover: "hover:text-green-600" },
  ignored: { Icon: X, hover: "hover:text-slate-700" },
  new: { Icon: RotateCcw, hover: "hover:text-amber-600" },
};

/** One row: the pill, the count, the company and culprit, the title, the two dates, its doors, and
 *  the unfolded payload when open. Presentational — the list owns the state. */
export function ErrorRow({
  row,
  open,
  onToggle,
  onStatus,
}: {
  row: ErrorEvent;
  open: boolean;
  onToggle: () => void;
  onStatus: (next: string) => void;
}) {
  const st = statusOf(row);
  const closed = !isOpenStatus(st);
  const pill = levelPill(row.level);
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${toneClasses(pill.tone)}`}>{pill.word}</span>
            {row.event_count > 1 && <span className="text-xs font-semibold text-slate-500">{`×${row.event_count}`}</span>}
            <span className="truncate font-mono text-xs text-slate-500">{row.org ? `${row.org} · ${row.culprit}` : row.culprit}</span>
          </div>
          <div className={`mt-1 text-sm ${closed ? "text-slate-400 line-through" : "text-slate-800"}`}>{row.title}</div>
          <div className="mt-0.5 text-xs text-slate-400">{`First ${formatDate(row.first_seen)} · Last ${formatDate(row.last_seen)}`}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <button onClick={onToggle} className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-700">
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} {open ? "Hide" : "Details"}
          </button>
          {actionsFor(st).map((a) => {
            const { Icon, hover } = ACTION_ICON[a.next];
            return (
              <button key={a.next} onClick={() => onStatus(a.next)} className={`flex items-center gap-1 text-xs text-slate-400 ${hover}`}>
                <Icon className="h-3.5 w-3.5" /> {a.label}
              </button>
            );
          })}
        </div>
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          {detailBlocks(row).map((b) => (
            <div key={b.heading}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{b.heading}</div>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-xs text-slate-700">{b.json}</pre>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

/** `readError`: the list read failed. The page says so instead of "Nothing new" — a failed read is
 *  never an empty run — and the New tab shows no count it does not know. `openCapped`: the open read
 *  came back at PostgREST's cap, so the page says the open list may be cut (S4). */
export function ErrorList({ initial, readError = null, openCapped = false }: { initial: ErrorEvent[]; readError?: string | null; openCapped?: boolean }) {
  const [rows, setRows] = useState<ErrorEvent[]>(initial);
  const [tab, setTab] = useState<ErrorTab>("new");
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const [orgFilter, setOrgFilter] = useState<string>("");
  const toast = useToast();

  async function setStatus(id: string, status: string) {
    // Optimistic, and never silent: a refused mark puts the row back and says why.
    const before = rows.find((r) => r.id === id)?.status ?? "new";
    setRows((p) => p.map((r) => (r.id === id ? { ...r, status } : r)));
    const res = await setErrorEventStatus(id, status).catch(() => ({ ok: false, error: "Couldn't reach the server. Try again." }));
    if (!res.ok) {
      setRows((p) => p.map((r) => (r.id === id ? { ...r, status: before } : r)));
      toast(res.error ?? "Couldn't mark that error.", "error");
    }
  }

  function toggle(id: string) {
    setOpenIds((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Only a platform admin ever gets a company's name back (platform_org_label), so this layer
  // simply does not appear for anyone else — and not until two companies are on the page.
  const tenants = [...new Set(rows.map((r) => r.org).filter(Boolean))] as string[];
  const crossTenant = tenants.length > 1;

  const shown = shownErrors(rows, tab, orgFilter);
  const newCount = countNew(rows);

  return (
    <div>
      {crossTenant && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium uppercase tracking-wide text-slate-400">Tenant</span>
          {["", ...tenants].map((t) => (
            <button
              key={t || "all"}
              onClick={() => setOrgFilter(t)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                orgFilter === t ? "seaglass-active" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              <span className="relative z-10">{t || "All Tenants"}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key ? "seaglass-active" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            <span className="relative z-10">
              {t.label}
              {t.key === "new" && !readError && newCount > 0 ? ` (${newCount})` : ""}
            </span>
          </button>
        ))}
      </div>

      {openCapped && !readError && <p className="mb-3 text-xs text-slate-500">Showing the newest 1,000 open errors.</p>}
      {readError ? (
        <EmptyState icon={AlertTriangle} title="Couldn't read the errors" description={readError} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Check}
          title={tab === "new" ? "Nothing new" : tab === "traces" ? "No traces" : "Nothing here"}
          description={tab === "new" ? "The sink is quiet — no new errors to triage." : tab === "traces" ? "No client footprints in the last fourteen days." : undefined}
        />
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {shown.map((r) => (
            <ErrorRow key={r.id} row={r} open={openIds.has(r.id)} onToggle={() => toggle(r.id)} onStatus={(next) => setStatus(r.id, next)} />
          ))}
        </ul>
      )}
    </div>
  );
}
