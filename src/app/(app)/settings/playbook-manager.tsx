"use client";

import { useMemo, useState, useTransition } from "react";
import { stampNeeds } from "@/lib/playbook/stamp";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { WhyField } from "@/components/playbook/why-field";
import type { Clause, Need, NeedSlot } from "@/lib/playbook/types";
import { clearPlaybook, installPlaybookStarter, savePlaybook } from "./playbook-actions";

/**
 * THE PLAYBOOK EDITOR — the first place in this app where a contractor can read the questions his
 * own inspector asks, and the reason each one exists.
 *
 * Erik: "there has to be a turnkey way we can have a set of questions each person wants its
 * inspector to ask it or use as a playbook … each one will be different of course and drastically."
 *
 * WHAT MAKES THIS DIFFERENT FROM THE FORM BUILDER IT LOOKS LIKE. A form builder edits LABELS. This
 * edits four things a label cannot hold, and each one traces to a real failure:
 *
 *   THE ASK    a sentence, not a heading. His sheet had a field called "Panel"; he typed 2 into it
 *              and then 2 again into the next box, because a heading transmits nothing about the
 *              answer it wants.
 *   THE WHY    his reason, in his words. It is the FUEL — what shows under the question so it
 *              guides instead of interrogating, and what Nort reads to know whether a question is
 *              worth asking at all. "it wasnt so much the measurements box in the way it was the
 *              subquestions that didnt guide me."
 *   THE RULES  more than one, and they can be NEGATIVE. "Ask the outlet count only if the room
 *              wasn't measured" is not expressible in a sheet, and it is the difference between
 *              deriving a number and demanding one.
 *   HOLD       "don't let me price without this."
 *
 * OPEN vs a control is DERIVED here too, not declared: pick "anything he says" as the answer kind
 * and the need has no slot, which is what makes it a sentence Nort has to phrase rather than a box.
 */

type Kind = "one" | "many" | "number" | "text" | "long" | "file" | "scopes" | "open";

const KIND_LABEL: Record<Kind, string> = {
  one: "Pick one",
  many: "Pick any that apply",
  number: "A number",
  text: "Typed in — short",
  long: "Typed in — a paragraph",
  file: "Files — plans, drawings, photos",
  scopes: "Pick line items off your price list and price them on site",
  open: "Anything you say (no box until it's answered)",
};

const kindOf = (n: Need): Kind =>
  !n.slot
    ? "open"
    : n.slot.type === "number"
      ? "number"
      : n.slot.type === "file"
        ? "file"
        : n.slot.type === "scopes"
          ? "scopes"
        : n.slot.type === "select"
          ? n.slot.multi
            ? "many"
            : "one"
          : n.slot.long
            ? "long"
            : "text";

/** Changing the kind keeps whatever the old kind had that the new one can still use. */
function slotForKind(kind: Kind, prev: NeedSlot | undefined): NeedSlot | undefined {
  const options = prev && prev.type === "select" ? prev.options : ["Yes", "No"];
  switch (kind) {
    case "open":
      return undefined;
    case "number":
      return { type: "number", ...(prev && prev.type === "number" && prev.unit ? { unit: prev.unit } : {}) };
    case "one":
      return { type: "select", options };
    case "many":
      return { type: "select", options, multi: true };
    case "long":
      return { type: "text", long: true };
    case "file":
      // Sensible defaults; a starter or a hand-edit can narrow `accept` per question.
      return { type: "file", multi: true, maxMb: 100 };
    case "scopes":
      // No `codes` = the whole price list is on offer. Narrow it per question by hand.
      return { type: "scopes" };
    default:
      return { type: "text" };
  }
}

const clauseMode = (c: Clause): "in" | "known" | "unknown" =>
  "unknown" in c ? "unknown" : "known" in c ? "known" : "in";

/** One rule, in words, for the collapsed summary. */
function ruleText(c: Clause, byKey: Map<string, Need>): string {
  const name = byKey.get(c.key)?.label ?? c.key;
  if ("unknown" in c) return `${name} hasn't been answered`;
  if ("known" in c) return `${name} has an answer`;
  return `${name} is ${c.in.join(" or ")}`;
}

export interface PlaybookForm {
  id: string;
  name: string;
  needs: Need[];
  /** False when the needs were converted from the sheet — saving is what promotes it. */
  owned: boolean;
  /** THE ONE THE PUBLIC DOOR SERVES. Without saying this out loud, two forms with sensible names
   *  are indistinguishable, and the customer-facing questions get written into the private one. */
  isWebsite?: boolean;
}

export function PlaybookManager({
  forms,
  starters,
}: {
  forms: PlaybookForm[];
  starters: { key: string; label: string; blurb: string }[];
}) {
  const router = useRouter();
  const [formId, setFormId] = useState(forms[0]?.id ?? "");
  // What this form looked like when the page loaded. Sent on save so a concurrent edit is
  // REFUSED instead of overwritten — see playbookStamp in playbook-actions.
  const baseStamps = useMemo(
    () => new Map(forms.map((f) => [f.id, f.owned ? stampNeeds(f.needs) : undefined])),
    [forms],
  );
  const form = forms.find((f) => f.id === formId) ?? forms[0];
  const baseStamp = baseStamps.get(form?.id ?? "");

  const [needs, setNeeds] = useState<Need[]>(form?.needs ?? []);
  const [loadedFor, setLoadedFor] = useState(form?.id ?? "");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Switching forms reloads that form's needs. Deliberately not an effect: a render-time sync is
  // what keeps an unsaved edit from being silently carried onto a different company's playbook.
  if (form && form.id !== loadedFor) {
    setLoadedFor(form.id);
    setNeeds(form.needs);
    setDirty(false);
    setOpenKey(null);
  }

  const byKey = useMemo(() => new Map(needs.map((n) => [n.key, n])), [needs]);

  if (!form)
    return (
      <p className="text-sm text-slate-500">
        You don&rsquo;t have a walk-through yet. Start one from an inspection and it&rsquo;ll show up here.
      </p>
    );

  const edit = (i: number, patch: Partial<Need>) => {
    setNeeds((ns) => ns.map((n, j) => (j === i ? { ...n, ...patch } : n)));
    setDirty(true);
  };

  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= needs.length) return;
    const next = [...needs];
    [next[i], next[j]] = [next[j], next[i]];
    // A rule may only name a question ABOVE it, so moving one past its own trigger would make a
    // rule that can never resolve. Drop the rules that just went backwards rather than leave a
    // question nobody can reach — the same call the parser makes, made visibly here.
    const order = new Map(next.map((n, k) => [n.key, k]));
    setNeeds(
      next.map((n, k) => {
        const kept = (n.when ?? []).filter((c) => (order.get(c.key) ?? 1e9) < k);
        return kept.length === (n.when?.length ?? 0) ? n : { ...n, when: kept.length ? kept : undefined };
      }),
    );
    setDirty(true);
  };

  const remove = (i: number) => {
    const gone = needs[i].key;
    if (!confirm(`Remove “${needs[i].label}”? Any rule that waits on it goes too.`)) return;
    setNeeds(
      needs
        .filter((_, j) => j !== i)
        .map((n) => {
          const kept = (n.when ?? []).filter((c) => c.key !== gone);
          return kept.length === (n.when?.length ?? 0) ? n : { ...n, when: kept.length ? kept : undefined };
        }),
    );
    setDirty(true);
  };

  const add = () => {
    const key = `q_${Date.now().toString(36)}`;
    setNeeds([...needs, { key, label: "New question", ask: "" }]);
    setOpenKey(key);
    setDirty(true);
  };

  /**
   * `resyncs` = this operation REPLACED the questions server-side (install a starter, go back to
   * the plain sheet), so the editor's local copy is now a lie.
   *
   * The render-time guard below only resyncs when the FORM ID changes, and these operations keep
   * the same id — so the editor went on showing the OLD questions under a green "Starter loaded"
   * message, and a subsequent Save wrote those stale questions straight back over the starter that
   * had just been installed. Dropping `loadedFor` re-arms that guard on the next render, which is
   * the one place the resync is already written correctly.
   */
  const run = (
    fn: () => Promise<{ ok: boolean; error?: string }>,
    done: string,
    resyncs = false,
  ) =>
    start(async () => {
      setErr(null);
      setMsg(null);
      const r = await fn();
      if (!r.ok) return setErr(r.error ?? "Couldn't save that.");
      setDirty(false);
      setMsg(done);
      if (resyncs) setLoadedFor("");
      router.refresh();
    });

  return (
    <div className="space-y-4">
      {forms.length > 1 && (
        <div>
          <Label className="mb-1.5">Which set of questions</Label>
          <Select value={formId} onChange={(e) => setFormId(e.target.value)}>
            {forms.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.isWebsite ? " — your website" : ""}
              </option>
            ))}
          </Select>
        </div>
      )}

      {/* WHO IS GOING TO READ THESE. The whole confusion is that both lists are "questions", and
          one of them is answered by a stranger on a phone who will never see the rest of the app. */}
      {form.isWebsite ? (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <strong className="font-medium">These are the questions on your website.</strong> A customer
          answers them at your public &ldquo;request an estimate&rdquo; link and lands on your Leads
          board. Keep them short — every question is a chance to leave.
        </p>
      ) : (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          Your own walk-through — what you ask yourself standing on the job. Never shown to a customer.
          {forms.some((f) => f.isWebsite) ? " Your website's questions are a separate set in the picker above." : ""}
        </p>
      )}

      {!form.owned && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
          These came across from your question sheet. Everything works today — but the ask, the reason and the
          rules below are things a sheet can&rsquo;t hold. Save any change and this becomes a playbook of your own.
        </p>
      )}

      <div className="space-y-2">
        {needs.map((n, i) => {
          const expanded = openKey === n.key;
          const kind = kindOf(n);
          const earlier = needs.slice(0, i);
          return (
            <Card key={n.key} className="overflow-hidden">
              <CardContent className="p-0">
                {/* THE ROW. Collapsed, this is the whole playbook readable at a glance: the
                    question, when it shows, and whether it stops a price. */}
                <div className="flex items-start gap-2 p-3">
                  <button
                    type="button"
                    onClick={() => setOpenKey(expanded ? null : n.key)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-1.5">
                      {expanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                      )}
                      <span className="truncate text-sm font-medium text-slate-900">
                        {n.ask?.trim() || <span className="text-amber-700">No question written yet</span>}
                      </span>
                      {n.hold && (
                        <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                          before pricing
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 pl-5 text-xs text-slate-500">
                      {KIND_LABEL[kind]}
                      {n.when?.length ? ` · only when ${n.when.map((c) => ruleText(c, byKey)).join(" and ")}` : " · always"}
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30">
                      <ChevronUp className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === needs.length - 1}
                            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30">
                      <ChevronDown className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => remove(i)} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="space-y-4 border-t border-slate-100 bg-slate-50/60 p-4">
                    <div>
                      <Label className="mb-1.5">The question, the way you&rsquo;d say it out loud</Label>
                      <Input value={n.ask} placeholder="Where's the power coming from — which panel, how far, what's open in it?"
                             onChange={(e) => edit(i, { ask: e.target.value })} />
                    </div>

                    <div>
                      <Label className="mb-1.5">Short name (what it&rsquo;s called in the recap)</Label>
                      <Input value={n.label} onChange={(e) => edit(i, { label: e.target.value })} />
                    </div>

                    <WhyField need={n} onChange={(why) => edit(i, { why })} />

                    {/* Everything else true about this question. The line above has to be readable
                        in three seconds; this has no such limit, and Nort reads both. Folded away
                        because on most questions it's empty and an open box invites homework. */}
                    <details className="group" open={!!n.note}>
                      <summary className="cursor-pointer list-none text-xs text-slate-500 hover:text-slate-700">
                        <span className="underline-offset-2 group-open:hidden">
                          + Anything else about this one {n.note ? "" : "(optional)"}
                        </span>
                        <span className="hidden group-open:inline">Anything else about this one</span>
                      </summary>
                      <Textarea
                        className="mt-1.5"
                        rows={3}
                        value={n.note ?? ""}
                        placeholder="The war story, the code section, the reason not to ask it too early. Nort reads this; it never shows on a job."
                        onChange={(e) => edit(i, { note: e.target.value || undefined })}
                      />
                    </details>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label className="mb-1.5">How it gets answered</Label>
                        <Select value={kind} onChange={(e) => edit(i, { slot: slotForKind(e.target.value as Kind, n.slot) })}>
                          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                            <option key={k} value={k}>{KIND_LABEL[k]}</option>
                          ))}
                        </Select>
                      </div>
                      {n.slot?.type === "number" && (
                        <div>
                          <Label className="mb-1.5">Units</Label>
                          <Input value={n.slot.unit ?? ""} placeholder="ft"
                                 onChange={(e) => edit(i, { slot: { type: "number", unit: e.target.value || undefined } })} />
                        </div>
                      )}
                    </div>

                    {n.slot?.type === "select" && (
                      <div>
                        <Label className="mb-1.5">The choices</Label>
                        <div className="space-y-2">
                          {n.slot.options.map((o, oi) => (
                            <div key={oi} className="flex items-center gap-2">
                              <Input
                                value={o}
                                onChange={(e) => {
                                  const options = (n.slot as { options: string[] }).options.map((x, k) => (k === oi ? e.target.value : x));
                                  edit(i, { slot: { ...(n.slot as NeedSlot & { type: "select" }), options } });
                                }}
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const options = (n.slot as { options: string[] }).options.filter((_, k) => k !== oi);
                                  edit(i, { slot: { ...(n.slot as NeedSlot & { type: "select" }), options } });
                                }}
                                className="shrink-0 rounded-md p-2 text-slate-400 hover:bg-slate-100"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => edit(i, { slot: { ...(n.slot as NeedSlot & { type: "select" }), options: [...(n.slot as { options: string[] }).options, ""] } })}
                            className="flex min-h-[40px] w-full items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 text-sm text-slate-500 hover:bg-white"
                          >
                            <Plus className="h-4 w-4" /> Add a choice
                          </button>

                          {/* Erik: "you prompt me with options then a 'other' box i use often."
                              A list you can't step outside forces every unforeseen answer into the
                              nearest wrong chip — and the honest ones just don't get said. */}
                          <label className="mt-1 flex items-center gap-2 text-sm text-slate-600">
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              checked={!!(n.slot as NeedSlot & { type: "select" }).other}
                              onChange={(e) =>
                                edit(i, { slot: { ...(n.slot as NeedSlot & { type: "select" }), other: e.target.checked || undefined } })
                              }
                            />
                            Let me write my own answer too
                          </label>
                        </div>
                      </div>
                    )}

                    {/* THE RULES. More than one, and one of them can be a negative — which is what
                        "derive it, or else ask it" needs and what a sheet could never say. */}
                    <div>
                      <Label className="mb-1.5">Only ask this when…</Label>
                      {earlier.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          This is the first question, so there&rsquo;s nothing yet for it to wait on.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {(n.when ?? []).map((c, ci) => {
                            const target = byKey.get(c.key);
                            const mode = clauseMode(c);
                            const opts = target?.slot?.type === "select" ? target.slot.options : [];
                            const setClause = (next: Clause) =>
                              edit(i, { when: (n.when ?? []).map((x, k) => (k === ci ? next : x)) });
                            return (
                              <div key={ci} className="rounded-lg border border-slate-200 bg-white p-2">
                                <div className="flex items-center gap-2">
                                  <Select
                                    value={c.key}
                                    onChange={(e) => setClause({ key: e.target.value, known: true })}
                                    className="min-w-0 flex-1"
                                  >
                                    {earlier.map((p) => (
                                      <option key={p.key} value={p.key}>{p.label}</option>
                                    ))}
                                  </Select>
                                  <Select
                                    value={mode}
                                    className="w-40 shrink-0"
                                    onChange={(e) => {
                                      const m = e.target.value;
                                      setClause(
                                        m === "known"
                                          ? { key: c.key, known: true }
                                          : m === "unknown"
                                            ? { key: c.key, unknown: true }
                                            : { key: c.key, in: opts.slice(0, 1) },
                                      );
                                    }}
                                  >
                                    <option value="in" disabled={!opts.length}>is one of…</option>
                                    <option value="known">has any answer</option>
                                    <option value="unknown">has NO answer</option>
                                  </Select>
                                  <button type="button"
                                          onClick={() => {
                                            const kept = (n.when ?? []).filter((_, k) => k !== ci);
                                            edit(i, { when: kept.length ? kept : undefined });
                                          }}
                                          className="shrink-0 rounded-md p-2 text-slate-400 hover:bg-slate-100">
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </div>
                                {mode === "in" && (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {opts.map((o) => {
                                      const on = "in" in c && c.in.includes(o);
                                      return (
                                        <button
                                          key={o}
                                          type="button"
                                          onClick={() => {
                                            const cur = "in" in c ? c.in : [];
                                            const next = on ? cur.filter((x) => x !== o) : [...cur, o];
                                            setClause({ key: c.key, in: next });
                                          }}
                                          className={
                                            on
                                              ? "rounded-full border border-brand bg-brand px-3 py-1 text-xs font-medium text-white"
                                              : "rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-600"
                                          }
                                        >
                                          {o}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          <button
                            type="button"
                            onClick={() => edit(i, { when: [...(n.when ?? []), { key: earlier[earlier.length - 1].key, known: true }] })}
                            className="flex min-h-[40px] w-full items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 text-sm text-slate-500 hover:bg-white"
                          >
                            <Plus className="h-4 w-4" /> Add a condition
                          </button>
                          {(n.when?.length ?? 0) > 1 && (
                            <p className="text-xs text-slate-500">All of them have to be true.</p>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-4">
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" className="h-4 w-4" checked={!!n.hold}
                               onChange={(e) => edit(i, { hold: e.target.checked || undefined })} />
                        Don&rsquo;t let me price without this
                      </label>
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" className="h-4 w-4" checked={!!n.measured}
                               onChange={(e) => edit(i, { measured: e.target.checked || undefined })} />
                        This is measured on site
                      </label>
                    </div>
                    {n.measured && kind !== "number" && (
                      <p className="flex items-start gap-1.5 text-xs text-amber-700">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        A measured answer feeds a calculation, so it should be a number.
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <button
        type="button"
        onClick={add}
        className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 text-sm text-slate-500 hover:bg-slate-50"
      >
        <Plus className="h-4 w-4" /> Add a question
      </button>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
        <Button type="button" disabled={pending || !dirty} onClick={() => run(() => savePlaybook(form.id, needs, baseStamp), "Saved.")}>
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : <><Check className="h-4 w-4" /> Save</>}
        </Button>

        {starters.map((s) => (
          <Button
            key={s.key}
            type="button"
            variant="secondary"
            disabled={pending}
            title={s.blurb}
            onClick={() => {
              // A starter REPLACES everything. Say so plainly — the first version of this
              // destroyed a hand-authored sheet with no way back, and a soft "replace?" is not
              // the same warning as "this is gone".
              if (!confirm(`Replace all ${needs.length} of your questions with the ${s.label} starter?\n\nYour current questions and why lines are overwritten.`)) return;
              run(() => installPlaybookStarter(form.id, s.key), "Starter loaded — now make it yours.", true);
            }}
          >
            Start from: {s.label}
          </Button>
        ))}

        {form.owned && (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              if (!confirm("Go back to the plain question sheet? Your playbook is removed.")) return;
              run(() => clearPlaybook(form.id), "Back to the sheet.", true);
            }}
          >
            <RotateCcw className="h-4 w-4" /> Back to the plain sheet
          </Button>
        )}

        {err && <span className="text-sm text-rose-600">{err}</span>}
        {msg && !err && <span className="text-sm font-medium text-emerald-700">{msg}</span>}
        {dirty && !pending && !err && <span className="text-sm text-slate-500">Unsaved changes</span>}
      </div>
    </div>
  );
}
