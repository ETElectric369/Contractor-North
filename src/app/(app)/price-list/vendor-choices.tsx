"use client";

import { Check, ExternalLink, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  FOUND_FIELDS,
  FOUND_LABEL,
  foundOn,
  nothingFoundText,
  type FoundChange,
  type FoundField,
  type LookupAnswer,
  type LookupChoice,
} from "./vendor-lookup-math";

/**
 * WHAT A LOOKUP FOUND, AS CHOICES A PERSON PICKS FROM (Look Up, Phase 2). Used on an import
 * preview's row and on a vendor's card.
 *
 * Each choice is labelled with its place and lists only the details the guard kept, each with its
 * own "Found On <site>" link to the page it came from. Use This One, None Of These, and for nothing
 * found, Leave Blank. A choice is shown as picked for the person only when it was the only one found
 * (and the name isn't a person's); it says so, and None Of These is right there.
 */
export function LookupChoices({
  name,
  answer,
  isPerson,
  pickedId,
  autoPicked,
  onPick,
  onNone,
}: {
  name: string;
  answer: LookupAnswer;
  isPerson: boolean;
  pickedId: string | null;
  /** The pick was made for them (the only one found). */
  autoPicked: boolean;
  onPick: (choice: LookupChoice) => void;
  onNone: () => void;
}) {
  if (!answer.found) {
    return (
      <div className="space-y-1 rounded-lg bg-slate-50 px-3 py-2">
        <p className="text-sm text-slate-700">{nothingFoundText(name, answer, isPerson)}</p>
        <Button variant="ghost" onClick={onNone}>
          Leave Blank
        </Button>
      </div>
    );
  }
  const n = answer.choices.length;
  return (
    <div className="space-y-2 rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-xs text-slate-600">
        {n === 1 ? "One choice found" : `${n} choices found`}
        {answer.near ? ` near ${answer.near}` : ""}. Found On means where it was found, not that it&apos;s been checked.
        {answer.dropped > 0 && ` ${answer.dropped} detail${answer.dropped === 1 ? " was" : "s were"} left out because no page backed ${answer.dropped === 1 ? "it" : "them"} up.`}
      </p>
      {autoPicked && pickedId && <p className="text-xs font-medium text-slate-700">Picked because it&apos;s the only one found. Change it with None Of These.</p>}
      <ul className="space-y-2" role="radiogroup" aria-label={`Choices for ${name}`}>
        {answer.choices.map((c) => {
          const on = c.id === pickedId;
          return (
            <li key={c.id} className={`rounded-lg border bg-white px-3 py-2 ${on ? "border-brand ring-1 ring-brand" : "border-slate-200"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-900">{c.place}</span>
                <Button variant={on ? "primary" : "outline"} onClick={() => onPick(c)} role="radio" aria-checked={on}>
                  {on ? (
                    <>
                      <Check className="h-4 w-4" /> Picked
                    </>
                  ) : (
                    "Use This One"
                  )}
                </Button>
              </div>
              <ul className="mt-1 space-y-0.5">
                {FOUND_FIELDS.filter((f) => c.fields[f]).map((f) => (
                  <li key={f} className="flex flex-wrap items-center gap-x-2 text-sm text-slate-700">
                    <span className="text-xs text-slate-500">{FOUND_LABEL[f]}</span>
                    <span className="break-all">{c.fields[f]!.value}</span>
                    <FoundOnLink url={c.fields[f]!.source} />
                  </li>
                ))}
              </ul>
              {c.maps_url && (
                <a
                  href={c.maps_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-1.5 text-sm text-slate-700 hover:text-slate-900"
                >
                  <MapPin className="h-4 w-4" /> View On Map
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <Button variant="ghost" onClick={onNone}>
        None Of These
      </Button>
    </div>
  );
}

function FoundOnLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="inline-flex min-h-11 items-center gap-1 text-xs text-brand hover:underline"
    >
      <ExternalLink className="h-3 w-3" /> Found On {foundOn(url)}
    </a>
  );
}

/**
 * WHICH FOUND DETAILS TO TAKE. An empty field starts ticked; a field somebody typed shows old → new
 * and starts unticked, so nothing a person wrote is replaced without them choosing it.
 */
export function FoundChanges({
  changes,
  take,
  onToggle,
}: {
  changes: FoundChange[];
  take: FoundField[];
  onToggle: (field: FoundField, on: boolean) => void;
}) {
  if (!changes.length) return <p className="text-xs text-slate-500">It says the same as what&apos;s already here, so there&apos;s nothing to take.</p>;
  return (
    <ul className="space-y-1">
      {changes.map((c) => (
        <li key={c.field}>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="h-5 w-5 shrink-0" checked={take.includes(c.field)} onChange={(e) => onToggle(c.field, e.target.checked)} />
            <span className="min-w-0">
              <span className="text-xs text-slate-500">{FOUND_LABEL[c.field]}: </span>
              {c.current ? (
                <>
                  <span className="text-slate-500 line-through">{c.current}</span> → <span className="break-all">{c.found.value}</span>
                </>
              ) : (
                <span className="break-all">{c.found.value}</span>
              )}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
