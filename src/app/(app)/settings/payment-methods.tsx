"use client";

import { useState, useTransition } from "react";
import { Plus, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OrgSettings } from "@/lib/org-settings";
import { updateOrgSettings } from "./actions";

export function PaymentMethods({ settings }: { settings: OrgSettings }) {
  const [methods, setMethods] = useState<string[]>(settings.payment_methods ?? []);
  const [venmo, setVenmo] = useState(settings.venmo_handle ?? "");
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  function add() {
    const v = draft.trim();
    if (!v || methods.includes(v)) return;
    setMethods((m) => [...m, v]);
    setDraft("");
  }

  function persist(next: string[]) {
    start(async () => {
      await updateOrgSettings({ payment_methods: next });
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        Methods available when recording a payment in the field (Cash, Check, Card, Zelle, Venmo…).
      </p>
      {/* THE VENMO QR NEEDS A HANDLE. Erik: "if i choose venmo then it gives me my venmo qr to
          show the customer on the spot." Pay now's Venmo chip builds a pay link with the amount
          filled in from this username; blank just means the chip explains where to set it. */}
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-400">Venmo username</label>
          <Input
            value={venmo}
            onChange={(e) => setVenmo(e.target.value)}
            placeholder="ETElectric"
            className="h-8 w-48 text-sm"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              await updateOrgSettings({ venmo_handle: venmo.trim().replace(/^@/, "") });
              setDone(true);
              setTimeout(() => setDone(false), 2000);
            })
          }
        >
          Save Handle
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {methods.map((m) => (
          <span key={m} className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">
            {m}
            <button
              onClick={() => { const next = methods.filter((x) => x !== m); setMethods(next); persist(next); }}
              className="text-slate-400 hover:text-red-600"
              title="Remove"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
        {methods.length === 0 && <span className="text-sm text-slate-400">No methods yet.</span>}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add a method…"
          className="max-w-xs"
        />
        <Button size="sm" variant="outline" onClick={add}><Plus className="h-3.5 w-3.5" /> Add</Button>
        <Button size="sm" onClick={() => persist(methods)} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {done && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
    </div>
  );
}
