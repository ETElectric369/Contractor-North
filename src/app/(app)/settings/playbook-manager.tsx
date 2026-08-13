"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { stampNeeds } from "@/lib/playbook/stamp";
import { useRouter, useSearchParams } from "next/navigation";
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
function slotForKind(kind: Kind, prev: NeedSlot | undefined, remembered?: string[]): NeedSlot | undefined {
  // `remembered` is the last list this question HAD, kept by the editor across a round trip
  // (cn-v700). Without it the carry-over only worked select→select, so a contractor who opened
  // "The project", tried "Typed in — short" to see what it looked like, and came back to
  // "Pick one" found his thirteen hand-written choices replaced by Yes / No — silently, one Save
  // from being the version on his website, and with every stored answer outside the new list
  // coercing to null on the next autosave.
  const options = prev && prev.type === "select" ? prev.options : remembered?.length ? remembered : ["Yes", "No"];
  // `other` SURVIVES A KIND CHANGE (cn-v698). `multi` is dropped on purpose — one-vs-many IS the
  // thing the dropdown selects. `other` was dropped by omission, and the doc-comment above was
  // false about it: a select→select change can obviously still use it. The cost was silent —
  // flipping "many" to "one" and back unticked "Let me write my own answer too" with no warning,
  // and the free-text answers behind it coerce to null on the next autosave.
  const keepOther = prev && prev.type === "select" && prev.other ? { other: true as const } : {};
  switch (kind) {
    case "open":
      return undefined;
    case "number":
      return { type: "number", ...(prev && prev.type === "number" && prev.unit ? { unit: prev.unit } : {}) };
    case "one":
      return { type: "select", options, ...keepOther };
    case "many":
      return { type: "select", options, multi: true, ...keepOther };
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
  // NOT forms[0] — that is alphabetical, and cn-v683 added the WEBSITE form to this picker.
  // For Vivian Builders "Customer intake" sorts before "Site inspection", so the editor started
  // opening on the questions that are live on Andrew's website rather than on his own
  // walk-through. Default to the private one; orgs with a single form are unaffected.
  /** The last option list each question carried, so a kind round trip can put it back. */
  const lastOptions = useRef(new Map<string, string[]>());
  // ?form=<id> WINS. The default below is a guess about which set you probably meant; a link that
  // names one is not a guess. /forms/[id]'s "edit it in Settings → Playbook" banner carries the id,
  // because without it Andrew followed that link from his WEBSITE form and landed on the
  // walk-through — ten questions that were not the ones he came to change.
  const linked = useSearchParams().get("form");
  const [formId, setFormId] = useState(
    (forms.find((f) => f.id === linked) ?? forms.find((f) => !f.isWebsite) ?? forms[0])?.id ?? "",
  );
  // What this form looked like when the page loaded. Sent on save so a concurrent edit is
  // REFUSED instead of overwritten — see stampNeeds in lib/playbook/stamp.
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

  /**
   * LEAVING THE PAGE WITH UNSAVED QUESTIONS SHOULD COST YOU A CLICK, NOT A MORNING.
   *
   * Andrew removed the Budget question from Vivian Builders' website form and rang Erik the next
   * morning to say his playbook was frozen: he could not change the questions. The row had never
   * been written. Nothing under this component is broken — the save action, the concurrency stamp
   * and the RLS policy all work, and his four real playbooks round-trip byte-identically. What was
   * missing was any signal at all that a change was still on his screen and nowhere else.
   *
   * beforeunload is the browser's own version of this and it is deliberately blunt: no custom
   * text, and iOS standalone PWAs ignore it entirely. It is therefore the WEAKEST of the three
   * guards here (the sticky bar and the form-switch confirm are the ones that actually save him),
   * but it is free and it catches the desktop tab-close.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

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

  /**
   * Rewrite every later need's `when` clause that names an option being renamed.
   *
   * Deliberately NOT applied on delete: a deleted choice has no replacement, so a rule pointing at
   * it is a rule the author has to resolve — silently dropping the clause would change which
   * questions apply, which is the same silent-rewrite this exists to prevent.
   */
  const renameOptionInRules = (key: string, from: string, to: string) => {
    const a = from.trim();
    const b = to.trim();
    if (!a || !b || a === b) return;
    setNeeds((cur) =>
      cur.map((n) =>
        n.when?.some((c) => "in" in c && c.key === key && c.in.includes(a))
          ? {
              ...n,
              when: n.when.map((c) =>
                "in" in c && c.key === key ? { ...c, in: c.in.map((x) => (x === a ? b : x)) } : c,
              ),
            }
          : n,
      ),
    );
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
      try {
        const r = await fn();
        if (!r.ok) return setErr(r.error ?? "Couldn't save that.");
        setDirty(false);
        setMsg(done);
        if (resyncs) setLoadedFor("");
        router.refresh();
      } catch {
        // A rejected server action left NOTHING on screen — the button spun, came back, and said
        // nothing, which reads as a page that quietly refuses to save. Most often a tab held open
        // across one of the day's deploys.
        setErr("That didn't reach the server — your questions are still on this screen. Check your connection and try again.");
      }
    });

  return (
    <div className="space-y-4">
      {forms.length > 1 && (
        <div>
          <Label className="mb-1.5">Which set of questions</Label>
          <Select
            value={formId}
            onChange={(e) => {
              // SWITCHING THE PICKER DISCARDS EVERYTHING UNSAVED, silently — the render-time sync
              // below reloads the other form's needs and resets `dirty`. That is the right
              // behaviour (an edit must never be carried onto a different question set) and the
              // wrong way to reach it: Andrew has TWO forms and the editor opens on the private
              // one, so "delete Budget, flick to the other list to check something, flick back"
              // loses the delete and looks exactly like a form that refuses to change.
              if (dirty && !confirm("You haven't saved your changes to these questions. Switch anyway and lose them?")) return;
              setFormId(e.target.value);
            }}
          >
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
                        <Select
                          value={kind}
                          onChange={(e) => {
                            // Record the outgoing list BEFORE the slot is replaced — this is the
                            // only moment it still exists.
                            if (n.slot?.type === "select" && n.slot.options.length)
                              lastOptions.current.set(n.key, n.slot.options);
                            edit(i, {
                              slot: slotForKind(e.target.value as Kind, n.slot, lastOptions.current.get(n.key)),
                            });
                          }}
                        >
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
                                  // RENAMING A CHIP RENAMES THE RULES THAT POINT AT IT.
                                  //
                                  // A `when` clause matches an option by its exact STRING. Rename
                                  // "New Construction" and every question gated on it silently
                                  // stops applying — the follow-ups just never appear again, and
                                  // nothing anywhere says why. Vivian Builders' site inspection is
                                  // a chain of eight of these, so one rename can orphan the rest
                                  // of the sheet.
                                  //
                                  // THIS KEYSTROKE IS THE ONLY PLACE THE INTENT IS KNOWABLE: it
                                  // holds both the old string and the new one. A minute later
                                  // there is nothing left to tell a rename from a delete-and-add.
                                  renameOptionInRules(n.key, o, e.target.value);
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
              // NAME THE LOSSES (cn-v700). A sheet has no shape for an open question, a file
              // upload or a price-list picker, so sheetFromPlaybook drops them — permanently,
              // because `forms` has no history table. On Andrew's website form that is "Plan
              // files" and "Photo files", the two uploads he filed bugs about this week, and
              // the button that deletes them said only "Your playbook is removed."
              const gone = needs
                .filter((n) => !n.slot || n.slot.type === "file" || n.slot.type === "scopes")
                .map((n) => n.label);
              const whys = needs.filter((n) => n.why || n.note).length;
              const losses = [
                gone.length ? `\n\nThese questions are DELETED — a plain sheet cannot hold them:\n  · ${gone.join("\n  · ")}` : "",
                whys ? `\n\n${whys} why line${whys === 1 ? "" : "s"} will also be lost.` : "",
                form.isWebsite ? "\n\nThis is the form on your WEBSITE." : "",
              ].join("");
              if (!confirm(`Go back to the plain question sheet?${losses}\n\nThere is no undo.`)) return;
              run(() => clearPlaybook(form.id), "Back to the sheet.", true);
            }}
          >
            <RotateCcw className="h-4 w-4" /> Back to the plain sheet
          </Button>
        )}

        {msg && !err && <span className="text-sm font-medium text-emerald-700">{msg}</span>}
      </div>

      {/* ── THE BAR THAT FOLLOWS YOU ──────────────────────────────────────────────────────────
          Andrew removed the Budget question from Vivian Builders' website form and rang Erik the
          next morning to say his playbook was frozen — he could not change the questions. The row
          had never been written, and nothing under this component was broken: the save action, the
          concurrency stamp and the RLS policy all work, and his four real playbooks round-trip
          byte-identically. What was missing was any signal that his change was still only on his
          screen. A delete removes the card INSTANTLY, so the question is visibly gone; the Save
          button is below twenty question cards; and the words "Unsaved changes" sat right beside
          that button, which parks the only warning where you can read it just after you have
          already found the thing it is telling you to press.

          `sticky`, not `fixed`, so it belongs to this section rather than floating over the whole
          Settings page. Offset above the mobile bottom nav, because the nav's backdrop-filter
          builds a stacking context that beats ordinary content — which is precisely how a Save
          button has ended up underneath it before (cn-v57). Above `shell:` there is no nav. */}
      {/* AN ERROR HERE IS NOT A FOOTNOTE. It used to render as a one-line rose span at the bottom
          of a long scrolling editor, beside a Save button somebody had just pressed from muscle
          memory — and the message it most often carries ("someone else changed these questions")
          is the one whose entire point is that the user must act before their work is safe. */}
      {err && (
        <div className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-300 bg-rose-50/95 px-3 py-2 text-sm text-rose-900 shadow-md backdrop-blur shell:bottom-2">
          <span>{err}</span>
          {/* THE WAY OUT OF A CONFLICT, and the only correct one.
              A refused save leaves this editor holding a fingerprint of a version that is no
              longer on the row, so every retry is refused identically — forever, with no reload
              affordance at all inside the installed PWA. That is the most literal reading of
              "frozen".
              My first fix was a router.refresh() on the failure path, and it was worse than the
              bug: refresh preserves client state, so the FINGERPRINT would have quietly
              re-baselined to the other person's version while `needs` still held this user's —
              and the next Save would have sailed through the guard and overwritten them. That is
              exactly the cn-v686 clobber the stamp was built to stop.
              So the escape is explicit, and it costs you your unsaved edit on purpose: a full
              reload, behind a confirm, which is the only version of "show me theirs" that cannot
              silently eat somebody's work. */}
          <button
            type="button"
            onClick={() => {
              if (dirty && !confirm("Reload their version? Your unsaved changes on this screen are lost.")) return;
              window.location.reload();
            }}
            className="shrink-0 font-medium underline underline-offset-2"
          >
            Reload their version
          </button>
        </div>
      )}

      {dirty && !pending && !err && (
        <div className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50/95 px-3 py-2 shadow-md backdrop-blur shell:bottom-2">
          <span className="text-sm font-medium text-amber-900">
            Not saved yet &mdash; {form.isWebsite ? "your website still asks the old questions" : "your inspector still asks the old questions"}
          </span>
          <Button type="button" onClick={() => run(() => savePlaybook(form.id, needs, baseStamp), "Saved.")}>
            <Check className="h-4 w-4" /> Save
          </Button>
        </div>
      )}
    </div>
  );
}
