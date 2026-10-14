"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { saveNortGreeting } from "./nort-tone-actions";

/**
 * NORT SPEAKS FIRST (0394). Per person, under "You": the greeting is the ready signal for the one
 * holding the phone ("sometimes i have to wait longer than other times for it to be ready"), and
 * what Nort calls them is theirs — a name, a nickname, or their first name when the box is empty.
 */
export function NortGreeting({ greets, name }: { greets: boolean; name: string }) {
  const router = useRouter();
  const [on, setOn] = useState(greets);
  const [n, setN] = useState(name);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = on !== greets || n.trim() !== name.trim();
  return (
    <div className="space-y-3">
      <label htmlFor="nort-greets" className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-slate-800">
        <input id="nort-greets" type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); setSaved(false); }} className="h-4 w-4 rounded border-slate-300 text-brand" />
        <span>
          <span className="font-medium">Nort speaks first</span>
          <span className="block text-xs text-slate-500">When you tap Talk To Nort, he says hello the moment the mic is live — so you know you can talk. If he&rsquo;s holding something for you he names it and asks whether you want it now. Off, he stays quiet until you speak and asks about what he&rsquo;s holding in his first reply instead.</span>
        </span>
      </label>
      <div>
        <Label htmlFor="nort-name" className="mb-1.5">Nort greets you as</Label>
        <Input id="nort-name" value={n} maxLength={40} placeholder="Your first name" onChange={(e) => { setN(e.target.value); setSaved(false); }} />
      </div>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={!dirty || pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await saveNortGreeting(on, n);
              if (!r.ok) { setError(r.error); return; }
              setSaved(true);
              router.refresh();
            })
          }
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null} Save
        </Button>
        {saved && !dirty && <span className="text-sm text-slate-500">Saved.</span>}
        {error && <span className="text-sm text-red-700">{error}</span>}
      </div>
    </div>
  );
}
