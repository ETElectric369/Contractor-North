import {
  directoryLine,
  doorCard,
  existingNote,
  panelHeading,
  scheduleChips,
  scheduleGroups,
  sizeLine,
  spaceWords,
  type DirectoryCircuit,
  type DirectoryPanel,
  type DoorCell,
} from "@/lib/panel/directory";

/**
 * THE PANEL DIRECTORY, DRAWN (Panel plan, phase 5). ONE renderer, render-only (no state, no data
 * fetching), for every place a directory is read: the printed door card and circuit map
 * (/print/panel/<job>), the customer's live "Your Panel" on the portal, and the office's preview of
 * that on the Customer Page tab (the structural-faults law: one renderer, never a second copy that
 * drifts). It draws a DirectoryPanel and nothing else, and that shape carries only what a customer
 * may read (lib/panel/directory).
 */

/** The small New tag on new work (the type, AFCI or GFCI, rides with the size: sizeLine). */
function Marks({ c, showNew }: { c: DirectoryCircuit; showNew: boolean }) {
  return (
    <>
      {showNew && c.isNew ? (
        <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 ring-1 ring-emerald-200">New</span>
      ) : null}
    </>
  );
}

/**
 * THE LIST, IN SPACE ORDER: one line per circuit, as the customer reads it ("7 · Entry Lights ·
 * feeds Kitchen And Living · 15A"). What it feeds shows only when it differs from the door label.
 * Circuits with no space yet come last with a dash. Each line fits a 375px phone: the space in a
 * fixed column, the words wrapping, the size on its own line under them.
 */
export function PanelDirectoryList({ panel, showNew = true }: { panel: DirectoryPanel; showNew?: boolean }) {
  return (
    <div>
      <h3 className="px-1 text-sm font-semibold text-slate-900">{panelHeading(panel)}</h3>
      {panel.circuits.length === 0 ? (
        <p className="mt-1 px-1 text-sm text-slate-600">No circuits on this panel yet.</p>
      ) : (
        <ol className="mt-1.5 divide-y divide-slate-200/70" aria-label={`${panel.name} circuits`}>
          {panel.circuits.map((c, i) => (
            <li key={i} className="flex min-h-[44px] items-start gap-3 py-2" aria-label={directoryLine(c)} data-panel-line={directoryLine(c)}>
              <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-sm font-semibold text-slate-700">{spaceWords(c)}</span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="break-words text-sm font-medium text-slate-900">{c.label}</span>
                  <Marks c={c} showNew={showNew} />
                </span>
                {c.feeds ? <span className="block break-words text-xs text-slate-600">Feeds {c.feeds}</span> : null}
                <span className="block text-xs text-slate-600">
                  {[sizeLine(c), c.room].filter(Boolean).join(" · ")}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function DoorCellView({ cell, side }: { cell: DoorCell; side: "left" | "right" }) {
  const num = (
    <td className="w-8 border border-slate-400 px-1 text-center align-middle font-mono text-[11px] font-semibold">{cell.space}</td>
  );
  const body = cell.noStab && !cell.occupants.length ? (
    <td className="border border-slate-400 bg-slate-200 px-2 text-center align-middle text-[10px] font-semibold uppercase tracking-wide text-slate-600">No Stab</td>
  ) : (
    <td className="border border-slate-400 px-2 py-0.5 align-middle">
      {cell.occupants.length === 0 ? (
        <span className="block h-4" aria-label="Empty" />
      ) : (
        cell.occupants.map((o, i) => (
          <div key={i} className="flex items-baseline justify-between gap-2 leading-tight">
            <span className="min-w-0 text-[11px] font-medium text-slate-900">
              {o.half ? `${o.half} · ` : ""}
              {o.circuit.label}
            </span>
            <span className="shrink-0 text-[9.5px] text-slate-600">
              {sizeLine(o.circuit)}
              {o.partner != null ? ` · With ${o.partner}` : ""}
            </span>
          </div>
        ))
      )}
    </td>
  );
  return side === "left" ? (
    <>
      {num}
      {body}
    </>
  ) : (
    <>
      {body}
      {num}
    </>
  );
}

/**
 * THE DOOR CARD: the panel as it hangs, odd spaces down the left, even down the right, top of the
 * box first. Twins split A/B, a 2P names the space it pairs with, a No Stab space is grey. Blank
 * spaces stay blank, for a pen.
 */
export function PanelDoorCard({ panel }: { panel: DirectoryPanel }) {
  const rows = doorCard(panel);
  return (
    <table className="w-full table-fixed border-collapse text-slate-900" aria-label={`${panel.name} door`}>
      <colgroup>
        <col className="w-8" />
        <col />
        <col />
        <col className="w-8" />
      </colgroup>
      <tbody>
        {rows.map((r) => (
          <tr key={r.left.space} className="h-7 break-inside-avoid">
            <DoorCellView cell={r.left} side="left" />
            <DoorCellView cell={r.right} side="right" />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * THE CIRCUIT MAP: the chips, then a section per size (15 A, 20 A, the 240-volt two-poles), each
 * line its room, what it is, and its size; the space when there is one. A circuit already in the
 * panel says Existing; a note under the sections counts them.
 */
export function CircuitMapSchedule({ circuits }: { circuits: DirectoryCircuit[] }) {
  const groups = scheduleGroups(circuits);
  const chips = scheduleChips(groups);
  const note = existingNote(circuits);
  if (!circuits.length) return <p className="text-sm text-slate-600">No circuits are kept on this job yet.</p>;
  return (
    <div>
      <div className="grid grid-cols-4 gap-2">
        {chips.map((c, i) => (
          <div key={i} className="flex items-baseline gap-1.5 rounded-md bg-slate-100 px-3 py-2">
            <span className="text-lg font-bold text-slate-900">{c.n}</span>
            <span className="text-[11px] text-slate-600">{c.words}</span>
          </div>
        ))}
      </div>
      {groups.map((g) => (
        <section key={g.key} className="mt-5 break-inside-avoid-page">
          <div className="flex items-baseline justify-between gap-3 border-b border-slate-300 pb-1">
            <h3 className="border-l-4 border-slate-800 pl-2 text-[15px] font-bold text-slate-900">{g.title}</h3>
            <span className="text-[11px] text-slate-600">{g.sub}</span>
          </div>
          <table className="w-full table-fixed text-[12px]">
            <colgroup>
              <col className="w-[22%]" />
              <col />
              <col className="w-[16%]" />
              <col className="w-[14%]" />
            </colgroup>
            <tbody>
              {g.circuits.map((c, i) => (
                <tr key={i} className="border-b border-slate-200 align-top">
                  <td className="py-1.5 pr-2 text-[11px] text-slate-600">{c.room ?? ""}</td>
                  <td className="py-1.5 pr-2 text-slate-900">
                    {/* The map reads by what a circuit feeds; the door's own words ride along when
                        they differ ("Kitchen And Living (Door Says Entry Lights)"). */}
                    {c.feeds ?? c.label}
                    {c.feeds ? <span className="text-slate-600"> (Door Says {c.label})</span> : null}
                    {!c.isNew ? <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Existing</span> : null}
                  </td>
                  <td className="py-1.5 pr-2 text-right text-[11px] text-slate-600">{c.space != null ? `Space ${spaceWords(c)}` : ""}</td>
                  <td className="py-1.5 text-right text-[11px] text-slate-700">{sizeLine(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {note ? <p className="mt-4 text-[11px] text-slate-600">{note}</p> : null}
    </div>
  );
}
