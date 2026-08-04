"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Camera, Check, ClipboardList, CloudOff, FileText, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { MediaLightbox } from "@/components/media-lightbox";
import { createClient } from "@/lib/supabase/client";
import { prepareImageForUpload } from "@/lib/image-prep";
import { coerceByPlaybook } from "@/lib/playbook/answers";
import { playbookForForm } from "@/lib/playbook/parse";
import { applicableNeeds, clearInapplicable, missingNeeds, splitAsk } from "@/lib/playbook/resolve";
import type { Answers, AnswerValue, Need, Playbook } from "@/lib/playbook/types";
import {
  captureId,
  inspectorReadiness,
  looseNumber,
  parseInspectorCapture,
  type CaptureItem,
  type CaptureMeasure,
} from "@/lib/inspection/capture";
import { createStarterInspectionSheet } from "../../forms/actions";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { LinkPicker } from "./link-picker";
import { TellNort } from "./tell-nort";
import { saveInspectionAnswers, saveInspectionCapture, setAppointmentPlace } from "../actions";

/** A numeric field that can be EMPTY. Deliberately not NumberInput: its value is a `number` and
 *  it renders 0 as blank, so "I didn't count it" and "zero of them" become the same stored value —
 *  and a silent zero reads as a real measurement all the way to a customer's price. */
function NumBox({ value, onValue, className }: { value: number | null; onValue: (n: number | null) => void; className?: string }) {
  return (
    <Input
      inputMode="decimal"
      value={value === null ? "" : String(value)}
      className={className}
      onChange={(e) => onValue(looseNumber(e.target.value))}
    />
  );
}

/** Which chips are lit, whatever shape the answer is stored in.
 *  The boolean case is the OLD checkbox renderer's value: a sheet checkbox is a two-option select
 *  in the playbook, so `true` must still light "Yes" rather than quietly lighting nothing. */
const chosen = (v: AnswerValue | undefined): string[] => {
  if (v === true) return ["Yes"];
  if (v === false) return ["No"];
  if (Array.isArray(v)) return v.map(String);
  if (v === null || v === undefined || v === "") return [];
  return [String(v)];
};

export interface CapturePhoto {
  path: string;
  url: string | null;
}
/** `playbook` (0179) is what it asks; `schema` is the older, smaller way of saying the same thing
 *  and is what every form still carries. See playbookForForm — one wins, and it is never both. */
export type InspectionTemplate = { id: string; name: string; schema: unknown; playbook?: unknown };

/**
 * ONE SMART INSPECTOR.
 *
 * Erik: "there are notes, measurements, etc then there is the thing you built when in reality it
 * should all be one smart thing that starts with the appointed questions and fragments from those
 * first … all the things need to be available that could build an estimate and they have to be in
 * the inspector … no nothing gets ruled out but get smarter about simplifying the process."
 *
 * What this replaces: a three-textarea capture card, and BELOW it a separate typed question sheet.
 * Two components, two Save buttons, and prose placeholders that said "the questions above" while
 * the questions were below. The person walking the job had to know which box was which.
 *
 * THE SHAPE — two zones and a bar.
 *
 *   ZONE A, THE ASK. One question at the top: what kind of work is this. Answer it and only the
 *   questions that apply to that answer appear. This is not new logic — showIf/visibleFields
 *   shipped and are tested; what is new is that they are the FIRST thing on the screen instead of
 *   the last. An answered question leaves the ask and reappears in Zone B, so the top of the
 *   screen is always "what's still open" and never a wall.
 *
 *   ZONE B, WHAT WE'VE GOT. Everything captured, in one list: answers, measurements, materials,
 *   photos, notes. Every row is editable in place — tap it and you are editing the same value in
 *   the same field, not a copy. NOTHING IS REMOVED: the three prose boxes are still here, because
 *   the sentence nobody anticipated ("the meter base is pulling away from the wall") is often the
 *   one that saves the job.
 *
 *   THE BAR. What is captured, and the one button that turns it into money.
 *
 * IT SAVES ITSELF. A capture is not a document you decide to commit — you are in a crawlspace and
 * it should just persist. Debounced, patch-only (see saveInspectionCapture for why never a
 * snapshot), and answers and capture are separate columns so they save independently.
 *
 * ── WHAT IT RENDERS FROM (cn-v628) ──────────────────────────────────────────────────────────
 *
 * A PLAYBOOK, not a sheet. The stored `forms.schema` is unchanged — playbookFromSheet converts it
 * on the way in — but everything on screen now comes from lib/playbook/resolve, which is the same
 * resolver the interview will speak through. That is the whole reason for the swap: the cold path
 * and the warm path can no longer disagree about what is still missing.
 *
 * Three things it buys immediately, all of which failed Erik at 13125 Moraine Rd:
 *   - the LABEL IS A SENTENCE (`need.ask`). His sheet had a field called "Panel"; he typed 2 into
 *     it and then 2 again into the next box, because a heading transmits nothing about the answer.
 *   - MULTI-SELECT. His job was outlets AND lights. A router that holds one value is why the sheet
 *     then asked him panel questions about a circuits job.
 *   - `when` IS A CONJUNCTION and clearing ITERATES. A rule can wait for two facts, and switching
 *     the work type drops the whole branch below it — not just its first level.
 */
export function Inspector({
  appointmentId,
  templates,
  initialTemplateId,
  initialAnswers,
  initialCapture,
  initialPhotos,
  orgId,
  userId,
  estimateHref,
  initialLocation,
  linked,
}: {
  appointmentId: string;
  templates: InspectionTemplate[];
  initialTemplateId: string | null;
  initialAnswers: Answers;
  initialCapture: unknown;
  initialPhotos: CapturePhoto[];
  orgId: string;
  userId: string | null;
  /** Where "Start the estimate" goes — built by the page so the capture/lead ids ride along. */
  estimateHref: string;
  /** appointments.location — the address, which is the fact that names everything downstream. */
  initialLocation: string;
  /** What this visit is already connected to — a lead, a customer or a job. */
  linked: { kind: "lead" | "customer" | "job"; name: string } | null;
}) {
  const router = useRouter();
  const stored = useMemo(() => parseInspectorCapture(initialCapture), [initialCapture]);

  const [templateId, setTemplateId] = useState<string | null>(
    initialTemplateId ?? (templates.length === 1 ? templates[0].id : null),
  );
  const [answers, setAnswers] = useState<Answers>(initialAnswers ?? {});
  const [items, setItems] = useState<CaptureItem[]>(stored.items ?? []);
  const [measures, setMeasures] = useState<CaptureMeasure[]>(stored.measures ?? []);
  const [notes, setNotes] = useState(stored.notes);
  const [materials, setMaterials] = useState(stored.materials);
  const [proseMeasurements, setProseMeasurements] = useState(stored.measurements);
  const [photos, setPhotos] = useState<CapturePhoto[]>(initialPhotos);

  /**
   * AVAILABLE IS NOT VISIBLE.
   *
   * Erik: "it wasnt so much the measurements box in the way it was the subquestions that didnt
   * guide me… when i clicked kind of work i like that responsiveness but my eye left with the
   * measurements box becuase it stuck out permanent right there."
   *
   * I read "nothing gets ruled out" as "everything is always on screen", and those are not the
   * same instruction. Five empty labelled boxes announcing capabilities he wasn't using yet sat
   * between him and the one thing he wanted to do. Nothing is removed — a section appears the
   * moment it HAS something, or the moment he reaches for it, and until then it is one word in a
   * row of chips.
   */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const shows = (key: string, hasContent: boolean) => hasContent || opened.has(key);
  const open1 = (key: string) => setOpened((s) => new Set(s).add(key));

  const [place, setPlace] = useState(initialLocation);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [viewing, setViewing] = useState<CapturePhoto | null>(null);
  const [seeding, startSeed] = useTransition();
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);

  const playbook = useMemo<Playbook>(
    () => playbookForForm(templates.find((x) => x.id === templateId)),
    [templates, templateId],
  );

  // THE ASK is what applies AND is still unanswered. The moment you answer something it leaves
  // the top and shows up below — the top of the screen is never a list of things you've done.
  const open = useMemo(() => missingNeeds(playbook, answers), [playbook, answers]);
  const answered = useMemo(() => {
    const stillOpen = new Set(open.map((n) => n.key));
    return applicableNeeds(playbook, answers).filter((n) => !stillOpen.has(n.key));
  }, [playbook, answers, open]);
  // What's on screen now vs what's one tap away — see splitAsk. `open` stays the honest count.
  const { ask, reach } = useMemo(() => splitAsk(playbook, answers, opened), [playbook, answers, opened]);

  const readiness = inspectorReadiness({
    ...stored,
    notes,
    materials,
    measurements: proseMeasurements,
    photos: photos.map((p) => p.path),
    items,
    measures,
  });

  // ── SAVING ─────────────────────────────────────────────────────────────────────────────────
  // Two columns, two independent debounced writes. A patch names only what changed, so an
  // in-flight materials save can never blank notes somebody typed a second later.
  const capturePatchRef = useRef<Record<string, unknown>>({});
  const answersDirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function queueCapture(patch: Record<string, unknown>) {
    capturePatchRef.current = { ...capturePatchRef.current, ...patch };
    schedule();
  }
  function queueAnswers() {
    answersDirty.current = true;
    schedule();
  }
  function schedule() {
    if (timer.current) clearTimeout(timer.current);
    // Wrapped, not passed by reference: setTimeout hands the callback its timer id, which would
    // arrive as `explicit` and make every autosave claim to be a deliberate press.
    timer.current = setTimeout(() => flush(), 900);
  }
  function flush(explicit = false) {
    const patch = capturePatchRef.current;
    const wantAnswers = answersDirty.current;
    capturePatchRef.current = {};
    answersDirty.current = false;
    const placeDirty = place.trim() !== initialLocation.trim();
    if (!Object.keys(patch).length && !wantAnswers && !placeDirty) {
      // Pressing Save when everything is already written must still ANSWER. Silence reads as a
      // dead button, and the whole point of the press is to be told the work is safe.
      if (explicit) setSavedAt(Date.now());
      return;
    }
    start(async () => {
      setError(null);
      if (Object.keys(patch).length) {
        const r = await saveInspectionCapture(appointmentId, patch as never);
        if (!r.ok) return setError(r.error ?? "Couldn't save.");
      }
      if (place.trim() !== initialLocation.trim()) {
        const r = await setAppointmentPlace(appointmentId, place);
        if (!r.ok) return setError(r.error ?? "Couldn't save the address.");
      }
      if (wantAnswers) {
        const r = await saveInspectionAnswers(appointmentId, templateId, coerceByPlaybook(playbook, answers) as never);
        if (!r.ok) return setError(r.error ?? "Couldn't save.");
      }
      setSavedAt(Date.now());
    });
  }
  // A tab closing mid-debounce must not eat the last thing typed.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const setAnswer = (key: string, value: AnswerValue) => {
    // Answer, then drop anything that answer just made inapplicable — a stale panel brand must not
    // ride into a lighting estimate as a fact. Iterates to a fixed point, which is the part the
    // sheet's one-pass clear could not do: work → power_source → feed → run_ft is four levels, and
    // one pass leaves an abandoned branch's measurement alive all the way into a price.
    setAnswers((a) => clearInapplicable(playbook, { ...a, [key]: value }));
    queueAnswers();
  };

  // ── PHOTOS ─────────────────────────────────────────────────────────────────────────────────
  async function upload(files: File[]) {
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      const supabase = createClient();
      const added: CapturePhoto[] = [];
      for (const raw of files) {
        // An image gets downscaled for the truck's connection; a document uploads untouched.
        const file = raw.type.startsWith("image/") ? await prepareImageForUpload(raw) : raw;
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${orgId}/appointments/${appointmentId}/${Date.now()}-${safe}`;
        const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
        if (upErr) throw upErr;
        const { data } = await supabase.storage.from("documents").createSignedUrl(path, 3600);
        added.push({ path, url: data?.signedUrl ?? null });
      }
      const next = [...photos, ...added];
      setPhotos(next);
      // Persist immediately — a closed tab must not lose the shots.
      const r = await saveInspectionCapture(appointmentId, { photos: next.map((p) => p.path) });
      if (!r.ok) setError(r.error ?? "Couldn't save the photos.");
      else setSavedAt(Date.now());
    } catch (e: unknown) {
      setError((e as { message?: string })?.message ?? "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function removePhoto(p: CapturePhoto) {
    if (!confirm("Remove this?")) return;
    const next = photos.filter((x) => x.path !== p.path);
    setPhotos(next);
    queueCapture({ photos: next.map((x) => x.path) });
  }

  // ── EMPTY STATE ────────────────────────────────────────────────────────────────────────────
  // Never render as nothing. The whole per-trade engine was invisible in production for months
  // because the sheet component returned null when no org had a template.
  const noSheet = templates.length === 0;

  const isImage = (p: string) => /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i.test(p);
  const fileLabel = (p: string) => (p.split("/").pop() ?? p).replace(/^\d{10,}-/, "");

  const control = (n: Need) => {
    const v = answers[n.key];

    // AN OPEN NEED — no slot, so no typed control can hold it. A box, because he types it himself
    // and Nort fills it in for him; that is the same instruction in both directions, and a
    // question with nowhere to put the answer is a dead end whichever way it got asked.
    if (!n.slot)
      return (
        <Textarea rows={2} value={typeof v === "string" ? v : ""} onChange={(e) => setAnswer(n.key, e.target.value)} />
      );

    if (n.slot.type === "select") {
      const { options, multi } = n.slot;
      const picked = chosen(v);
      return (
        // Chips, not a dropdown: a select on a phone costs a tap to open, a scroll, and a tap to
        // choose. Chips cost one tap and you can read every option at a glance in daylight.
        <div className="flex flex-wrap gap-2">
          {options.map((o) => {
            const on = picked.includes(o);
            return (
              <button
                key={o}
                type="button"
                onClick={() => {
                  if (!multi) return setAnswer(n.key, on ? null : o);
                  // MULTI. "2 new circuits one for lights and one for outlets" — outlets AND
                  // lights, both true at once. Deselecting the last one is null, not [], because
                  // an empty array reads as answered-with-nothing and the question would leave
                  // the screen having never been answered.
                  const next = on ? picked.filter((x) => x !== o) : [...picked, o];
                  setAnswer(n.key, next.length ? next : null);
                }}
                className={
                  on
                    ? "min-h-[44px] rounded-full border border-brand bg-brand px-4 text-sm font-medium text-white"
                    : "min-h-[44px] rounded-full border border-slate-300 bg-white px-4 text-sm text-slate-700 active:bg-slate-50"
                }
              >
                {o}
              </button>
            );
          })}
        </div>
      );
    }

    if (n.slot.type === "number")
      return (
        <div className="flex items-center gap-2">
          <NumBox value={typeof v === "number" ? v : null} onValue={(x) => setAnswer(n.key, x)} />
          {n.slot.unit && <span className="shrink-0 text-sm text-slate-500">{n.slot.unit}</span>}
        </div>
      );

    return n.slot.long ? (
      <Textarea rows={2} value={typeof v === "string" ? v : ""} onChange={(e) => setAnswer(n.key, e.target.value)} />
    ) : (
      <Input value={typeof v === "string" ? v : ""} onChange={(e) => setAnswer(n.key, e.target.value)} />
    );
  };

  return (
    <Card className="overflow-hidden p-0">
      {/* ── ZONE A — THE ASK ──────────────────────────────────────────────────────────────── */}
      <div className="border-b border-slate-100 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ClipboardList className="h-4 w-4 text-slate-400" />
            Walk-through
          </div>
          {templates.length > 1 && (
            <Select value={templateId ?? ""} onChange={(e) => setTemplateId(e.target.value || null)} className="max-w-[10rem]">
              <option value="">Pick a sheet…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </Select>
          )}
        </div>

        {/* WHERE. First control on the surface, above the first question, because this is the
            fact that names the lead, the estimate, the job and the invoice — and because typing
            it into the title (which is what 4 of 13 real inspections did) was the only way to
            record it before. Saves on resolve/blur, and renames a stock-titled record so a list
            of visits stops reading "Site inspection" six times. */}
        <div className="mt-3">
          <Label className="mb-1.5">Where</Label>
          <AddressAutocomplete
            defaultValue={initialLocation}
            placeholder="Job address"
            onTextChange={(v) => { setPlace(v); schedule(); }}
            onResolved={(parts) => {
              // `formatted` is the full one-line address — appointments.location is a single
              // text column, so the whole thing is what belongs in it.
              const line = parts.formatted || parts.line1 || "";
              setPlace(line);
              // Resolved from autocomplete → the PARTS ride along (0177), so the city is stored
              // rather than left to be guessed out of a string later.
              if (line && line !== initialLocation)
                start(async () => {
                  await setAppointmentPlace(appointmentId, line, { city: parts.city, state: parts.state, zip: parts.zip });
                  router.refresh();
                });
            }}
          />
        </div>

        <LinkPicker appointmentId={appointmentId} linked={linked} seed={place} />

        {/* SAY IT, OR TAP IT — the same boxes either way. Above the questions because that is the
            order it happens on a job: he talks first, and what's left over is what gets asked. */}
        {!noSheet && (
          <TellNort
            appointmentId={appointmentId}
            answers={answers}
            hint={ask[0]?.ask}
            onFilled={(next, filled, note) => {
              setAnswers(next);
              queueAnswers();
              if (filled.length) setSavedAt(null);
              // WHAT IT COULDN'T PLACE GOES IN THE NOTES, VERBATIM, and the box opens so he sees
              // it land. Losing the one sentence nobody's template anticipated is the failure this
              // whole capture exists to prevent.
              if (note) {
                open1("notes");
                setNotes((n) => {
                  const merged = n.trim() ? `${n.trim()}\n${note}` : note;
                  queueCapture({ notes: merged });
                  return merged;
                });
              }
            }}
          />
        )}

        {noSheet ? (
          <div className="mt-3">
            <p className="text-sm text-slate-500">
              You don&rsquo;t have a set of walk-through questions yet. Start with the ones for your trade —
              one question at a time, and only what applies to the job in front of you.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={seeding}
                onClick={() =>
                  startSeed(async () => {
                    const r = await createStarterInspectionSheet();
                    if (!r.ok) setError(r.error ?? "Couldn't set that up.");
                    else router.refresh();
                  })
                }
              >
                {seeding ? <><Loader2 className="h-4 w-4 animate-spin" /> Setting up…</> : "Set up my questions"}
              </Button>
              <Link href="/forms" className="text-sm text-slate-500 underline-offset-2 hover:underline">or build my own</Link>
            </div>
          </div>
        ) : open.length === 0 ? (
          <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <Check className="h-4 w-4" /> That&rsquo;s everything this job needs.
          </p>
        ) : (
          <div className="mt-3 space-y-4">
            {/* AVAILABLE IS NOT VISIBLE, applied to the questions themselves.
                An OPEN need (no control) is a sentence Nort is meant to phrase and hear, so it
                renders nothing until it is reached for — otherwise "anything that'll bite us?"
                is an empty box sitting between him and the work, which is the exact complaint:
                "my eye left with the measurements box becuase it stuck out permanent right there."
                ONE EXCEPTION, and it is the whole point of the flag: a HOLD always shows. "Don't
                let me price without this" cannot be a thing you have to go looking for. */}
            {ask.map((n) => (
              <div key={n.key}>
                {/* THE SENTENCE, not the heading. His sheet had a field called "Panel" — he typed
                    2 into it and then 2 again into the next box, because a heading transmits
                    nothing about the answer it wants. */}
                <Label className="mb-1">{n.ask}</Label>
                {n.hold && (
                  <span className="mb-1.5 ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    before you price it
                  </span>
                )}
                {/* HIS OWN REASON, on his own screen. Two lines, because the why is the fuel and
                    the fuel is what makes a question feel like guidance instead of a form. */}
                {n.why && <p className="mb-1.5 line-clamp-2 text-xs leading-snug text-slate-500">{n.why}</p>}
                {control(n)}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── ZONE B — WHAT WE'VE GOT ───────────────────────────────────────────────────────── */}
      <div className="space-y-5 p-4">
        {answered.length > 0 && (
          <div>
            <SectionLabel>Answered</SectionLabel>
            <div className="mt-2 space-y-3">
              {answered.map((n) => (
                <div key={n.key} className="rounded-lg bg-slate-50 p-3">
                  {/* The SHORT label down here — the sentence did its job upstairs; a recap of
                      twelve full questions is a wall. */}
                  <div className="text-[11px] uppercase tracking-wide text-slate-400">{n.label}</div>
                  <div className="mt-1.5">{control(n)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* MEASUREMENTS — still always available, now not always VISIBLE. Typed rows for what a
            kit can size itself from, plus the prose box for the shape a number can't hold. */}
        {shows("measures", measures.length > 0 || !!proseMeasurements.trim()) && (
        <div>
          <SectionLabel>Measurements</SectionLabel>
          <div className="mt-2 space-y-2">
            {measures.map((m, i) => (
              <div key={m.id} className="flex items-center gap-2">
                <Input
                  value={m.label}
                  placeholder="what you measured"
                  onChange={(e) => {
                    const next = measures.map((x, j) => (j === i ? { ...x, label: e.target.value } : x));
                    setMeasures(next);
                    queueCapture({ measures: next });
                  }}
                />
                <NumBox
                  value={m.value}
                  className="w-24"
                  onValue={(n) => {
                    const next = measures.map((x, j) => (j === i ? { ...x, value: n } : x));
                    setMeasures(next);
                    queueCapture({ measures: next });
                  }}
                />
                <Input
                  value={m.unit}
                  placeholder="ft"
                  className="w-16"
                  onChange={(e) => {
                    const next = measures.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x));
                    setMeasures(next);
                    queueCapture({ measures: next });
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = measures.filter((_, j) => j !== i);
                    setMeasures(next);
                    queueCapture({ measures: next });
                  }}
                  className="shrink-0 rounded-md p-2 text-slate-400 active:bg-slate-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <AddRow
              label="Add a measurement"
              onClick={() => setMeasures([...measures, { id: captureId(), label: "", value: null, unit: "" }])}
            />
            <Textarea
              rows={2}
              value={proseMeasurements}
              placeholder="Anything a number doesn't hold — “35' to the far corner, uphill”."
              onChange={(e) => {
                setProseMeasurements(e.target.value);
                queueCapture({ measurements: e.target.value });
              }}
            />
          </div>
        </div>
        )}

        {/* MATERIALS — a list you or Nort can add to, PLUS the paragraph box. Both, still. */}
        {shows("items", items.length > 0 || !!materials.trim()) && (
        <div>
          <SectionLabel>Materials</SectionLabel>
          <div className="mt-2 space-y-2">
            {items.map((it, i) => (
              <div key={it.id} className="flex items-center gap-2">
                <Input
                  value={it.description}
                  placeholder="what you need"
                  onChange={(e) => {
                    const next = items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x));
                    setItems(next);
                    queueCapture({ items: next });
                  }}
                />
                <NumBox
                  value={it.quantity}
                  className="w-20"
                  onValue={(n) => {
                    const next = items.map((x, j) => (j === i ? { ...x, quantity: n } : x));
                    setItems(next);
                    queueCapture({ items: next });
                  }}
                />
                <Input
                  value={it.unit}
                  className="w-16"
                  onChange={(e) => {
                    const next = items.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x));
                    setItems(next);
                    queueCapture({ items: next });
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = items.filter((_, j) => j !== i);
                    setItems(next);
                    queueCapture({ items: next });
                  }}
                  className="shrink-0 rounded-md p-2 text-slate-400 active:bg-slate-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <AddRow
              label="Add a material"
              onClick={() => setItems([...items, { id: captureId(), description: "", quantity: null, unit: "ea" }])}
            />
            <Textarea
              rows={2}
              value={materials}
              placeholder="Or just type it — “roughly 200' of 12-2, a couple of 20A breakers”."
              onChange={(e) => {
                setMaterials(e.target.value);
                queueCapture({ materials: e.target.value });
              }}
            />
          </div>
        </div>
        )}

        {/* PHOTOS — DELIBERATELY ALWAYS VISIBLE, unlike the others. "i exited stage left and took
            some pictures like i normally do to look at later" — the camera is the one thing that
            gets reached for on every job whether the rest of this screen helps or not. Hiding it
            behind a chip would be tidiness at the cost of the single most-used control. */}
        <div>
          <div className="flex items-center justify-between">
            <SectionLabel>Photos &amp; documents</SectionLabel>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" disabled={uploading} onClick={() => captureRef.current?.click()}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} Take
              </Button>
              <Button type="button" variant="secondary" disabled={uploading} onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" /> Add
              </Button>
            </div>
          </div>
          <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" className="hidden"
                 onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <input ref={captureRef} type="file" accept="image/*" capture="environment" className="hidden"
                 onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          {photos.length === 0 ? (
            <p className="mt-2 rounded-lg bg-slate-50 px-3 py-3 text-center text-xs text-slate-400">
              Whatever you&rsquo;d want to look at again from the office.
            </p>
          ) : (
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photos.map((p) => (
                <div key={p.path} className="group relative aspect-square overflow-hidden rounded-lg bg-slate-100">
                  {isImage(p.path) ? (
                    <button type="button" onClick={() => p.url && setViewing(p)} className="h-full w-full">
                      {p.url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.url} alt="" className="h-full w-full object-cover" />
                      )}
                    </button>
                  ) : (
                    <a href={p.url ?? "#"} target="_blank" rel="noopener noreferrer"
                       className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center">
                      <FileText className="h-6 w-6 shrink-0 text-slate-400" />
                      <span className="line-clamp-2 break-all text-[10px] leading-tight text-slate-500">{fileLabel(p.path)}</span>
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => removePhoto(p)}
                    // Always visible, not hover-revealed: there is no hover on a phone.
                    className="absolute right-1 top-1 rounded-md bg-black/50 p-1 text-white"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* NOTES — the escape hatch. The sentence nobody's template anticipated. */}
        {shows("notes", !!notes.trim()) && (
          <div>
            <SectionLabel>Notes</SectionLabel>
            <Textarea
              rows={3}
              className="mt-2"
              value={notes}
              placeholder="Anything the questions didn't cover."
              onChange={(e) => {
                setNotes(e.target.value);
                queueCapture({ notes: e.target.value });
              }}
            />
          </div>
        )}

        {/* THE ONE ROW THAT REPLACES FOUR EMPTY BOXES. Nothing is ruled out — everything is one
            tap away and says so. This is the whole "available is not visible" change: a capability
            he isn't using yet is a word, not a container. */}
        {(() => {
          const hidden = [
            // The open questions that aren't holds ride in the SAME row as the capture sections,
            // because they are the same kind of thing: something you can reach for, named, not a
            // box announcing itself. Tap one and its question opens upstairs with the rest.
            ...reach.map((n) => ({ k: n.key, label: n.label, on: () => open1(n.key) })),
            { k: "measures", label: "Measurement", on: () => { open1("measures"); setMeasures((m) => [...m, { id: captureId(), label: "", value: null, unit: "" }]); } },
            { k: "items", label: "Material", on: () => { open1("items"); setItems((i) => [...i, { id: captureId(), description: "", quantity: null, unit: "ea" }]); } },
            { k: "notes", label: "Note", on: () => open1("notes") },
          ].filter((x) => !shows(x.k, false));
          if (!hidden.length) return null;
          return (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-slate-400">Add</span>
              {hidden.map((h) => (
                <button
                  key={h.k}
                  type="button"
                  onClick={h.on}
                  className="flex min-h-[36px] items-center gap-1 rounded-full border border-dashed border-slate-300 px-3 text-sm text-slate-500 active:bg-slate-50"
                >
                  <Plus className="h-3.5 w-3.5" /> {h.label}
                </button>
              ))}
            </div>
          );
        })()}
      </div>

      {/* ── THE BAR ───────────────────────────────────────────────────────────────────────── */}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="text-xs text-slate-500">
          {/* Counts, never confidence. */}
          {[
            open.length > 0 ? `${open.length} still open` : "all questions answered",
            readiness.items ? `${readiness.items} materials` : null,
            readiness.measures ? `${readiness.measures} measurements` : null,
            readiness.photos ? `${readiness.photos} photos` : null,
          ].filter(Boolean).join(" · ")}
          <span className="ml-2">
            {pending ? (
              <span className="text-slate-400">saving…</span>
            ) : error ? (
              <span className="text-rose-600"><CloudOff className="mr-1 inline h-3 w-3" />{error}</span>
            ) : savedAt ? (
              <span className="font-medium text-emerald-700"><Check className="mr-0.5 inline h-3 w-3" />Saved</span>
            ) : null}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* THE SAVE BUTTON IS BACK, and autosave stays underneath it.
              Erik: "when i start and complete an inspection and im not ready to start the estimate
              i want to be able to save it and the save button is gone."
              I removed it because a capture persists itself, and that reasoning was wrong: autosave
              protects the DATA, it does not tell a person they are DONE. Walking away from a job
              needs an act — something to press that answers "did that stick?" before you get in the
              truck. So this flushes anything still in the debounce and says so out loud. */}
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              if (timer.current) clearTimeout(timer.current);
              flush(true);
            }}
          >
            {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : <><Check className="h-4 w-4" /> Save</>}
          </Button>
          <Link href={estimateHref}>
            <Button type="button">Start the estimate</Button>
          </Link>
        </div>
      </div>

      {viewing?.url && <MediaLightbox url={viewing.url} name={fileLabel(viewing.path)} onClose={() => setViewing(null)} />}
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{children}</div>;
}

function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[44px] w-full items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 text-sm text-slate-500 active:bg-slate-50"
    >
      <Plus className="h-4 w-4" /> {label}
    </button>
  );
}
