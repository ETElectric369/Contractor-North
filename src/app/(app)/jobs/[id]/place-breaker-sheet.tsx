"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { candidatesFor, firstPicks, groupLabel, placementOf, type HaveGroup } from "@/lib/panel/breakers";
import { WORK_WORDS, circuitName, countWord, sizeWords, spaceMap } from "@/lib/panel/model";
import type { JobCircuit, JobPanel } from "@/lib/types";
import { placeBoughtBreaker, type PlaceResult } from "../panel-actions";

/**
 * PLACE FROM WHAT WAS BOUGHT (Panel plan, phase 3). Tap a breaker that came (a Q2020, a Q21530CT),
 * pick the space it goes in, and each of its pole groups is pre-filled as a circuit: a twin's top
 * and bottom halves, a quad's two outside 1-poles and its inside 2-pole. Each part is matched to a
 * kept circuit on the list that has no space yet and is that size (the first ones in list order),
 * or A New Circuit. Nothing is written until a person taps Place: the app suggests, a person
 * decides. What the door would warn about (two on one space, a tandem the label doesn't allow, No
 * Stab, past the end) is said before the tap, never after.
 */
export function PlaceBreakerSheet({
  jobId,
  panel,
  group,
  circuits,
  onPlaced,
  onClose,
}: {
  jobId: string;
  panel: JobPanel;
  group: HaveGroup;
  circuits: JobCircuit[];
  onPlaced: (r: Extract<PlaceResult, { ok: true }>, label: string, space: number) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [spaceText, setSpaceText] = useState("");
  const space = /^\d{1,2}$/.test(spaceText.trim()) ? Number(spaceText.trim()) : null;
  const parts = useMemo(() => (space && space >= 1 ? placementOf(group, space) : placementOf(group, 1)), [group, space]);
  const [picks, setPicks] = useState<(string | null)[]>(() => firstPicks(placementOf(group, 1), circuits, panel.id));
  const [fresh, setFresh] = useState<{ room: string; description: string }[]>(() => parts.map(() => ({ room: "", description: "" })));
  const [saving, setSaving] = useState(false);
  const once = useRef(false);
  const label = group.codes[0] ?? group.words;

  // What the door would say with these in: only the warnings about the parts being placed.
  const warnings = useMemo(() => {
    if (!space) return [];
    const ghost = parts.map((p, i) => {
      const picked = picks[i] ? circuits.find((c) => c.id === picks[i]) : null;
      return {
        id: picked?.id ?? `new-${i}`,
        panel_id: panel.id,
        space: p.space,
        half: p.half,
        poles: p.poles,
        state: "kept" as const,
        removed_at: null,
        room: picked?.room ?? (fresh[i]?.room || null),
        description: picked?.description ?? (fresh[i]?.description || `${label} ${p.label}`),
        panel_label: picked?.panel_label ?? null,
        amps: p.amps,
      };
    });
    const ids = new Set(ghost.map((g) => g.id));
    const others = circuits.filter((c) => !ids.has(c.id));
    return spaceMap(panel, [...others, ...ghost]).warnings.filter((w) => w.circuitIds.some((id) => ids.has(id)));
  }, [space, parts, picks, fresh, circuits, panel, label]);

  async function place() {
    if (!space || once.current) return;
    once.current = true;
    setSaving(true);
    try {
      const r = await placeBoughtBreaker(
        jobId,
        panel.id,
        parts.map((p, i) => ({
          circuit_id: picks[i],
          space: p.space,
          half: p.half,
          poles: p.poles,
          amps: p.amps,
          kind: p.kind,
          room: picks[i] ? null : fresh[i]?.room.trim() || null,
          description: picks[i] ? null : fresh[i]?.description.trim() || null,
        })),
      );
      if (!r.ok) {
        toast(r.error, "error");
        return;
      }
      onPlaced(r, label, space);
    } catch {
      toast("That didn't save. Check your connection and try again.", "error");
    } finally {
      once.current = false;
      setSaving(false);
    }
  }

  const tooFar = space != null && panel.spaces != null && parts.some((p) => p.space + 2 * (p.poles - 1) > panel.spaces!);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Place ${label}`}
      size="md"
      footer={
        <ModalActions
          onCancel={onClose}
          onSave={() => void place()}
          saveLabel={parts.length === 1 ? "Place It" : `Place These ${countWord(parts.length)}`}
          saving={saving}
          disabled={!space || tooFar}
        />
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{groupLabel(group)}. Pick the space it goes in; each part fills in as a circuit for you to check.</p>
        <label className="block">
          <span className="text-sm font-medium text-slate-800">Space {group.form === "quad" ? "(The Top Of The Quad)" : ""}</span>
          <Input
            className="mt-1 h-11"
            inputMode="numeric"
            placeholder={panel.spaces ? `1 To ${panel.spaces}` : "Space Number"}
            value={spaceText}
            onChange={(e) => setSpaceText(e.target.value)}
            autoFocus
          />
        </label>
        {tooFar && <p className="text-sm text-red-700">That runs past the end of this {panel.spaces}-space panel.</p>}

        <ul className="space-y-3">
          {parts.map((p, i) => {
            const options = candidatesFor(p, circuits, panel.id).filter((c) => c.id === picks[i] || !picks.includes(c.id));
            return (
              <li key={i} className="rounded-lg border border-slate-200 p-3">
                <div className="text-sm font-semibold text-slate-900">
                  {space ? `Space ${p.space}${p.half ?? ""}${p.poles > 1 ? `-${p.space + 2 * (p.poles - 1)}${p.half ?? ""}` : ""} · ` : ""}
                  {p.label} · {sizeWords(p.poles, p.amps, p.kind)}
                </div>
                <label className="mt-2 block">
                  <span className="sr-only">Which Circuit</span>
                  <select
                    className="h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"
                    value={picks[i] ?? ""}
                    onChange={(e) => setPicks((ps) => ps.map((x, j) => (j === i ? e.target.value || null : x)))}
                  >
                    {options.map((c) => (
                      <option key={c.id} value={c.id}>
                        {circuitName(c)} · {WORK_WORDS[c.work]}
                      </option>
                    ))}
                    <option value="">A New Circuit</option>
                  </select>
                </label>
                {!picks[i] && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="min-w-0">
                      <span className="sr-only">Room</span>
                      <Input
                        className="h-11"
                        placeholder="Room"
                        value={fresh[i]?.room ?? ""}
                        onChange={(e) => setFresh((f) => f.map((x, j) => (j === i ? { ...x, room: e.target.value } : x)))}
                      />
                    </label>
                    <label className="min-w-0">
                      <span className="sr-only">What It Feeds</span>
                      <Input
                        className="h-11"
                        placeholder="What It Feeds"
                        value={fresh[i]?.description ?? ""}
                        onChange={(e) => setFresh((f) => f.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                      />
                    </label>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {warnings.length > 0 && (
          <ul className="space-y-1">
            {warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {w.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
