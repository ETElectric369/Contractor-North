"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Check, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { updateOrgSettings } from "../settings/actions";

/** Renders the handbook ( # / ## headings + paragraphs); admins can edit. */
export function HandbookView({ text, isAdmin }: { text: string; isAdmin: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    start(async () => {
      const res = await updateOrgSettings({ employee_handbook: draft });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setEditing(false);
      router.refresh();
    });
  }

  if (editing) {
    return (
      <Card>
        <CardContent className="space-y-3 py-5">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <p className="text-xs text-slate-400">
            Lines starting with <code># </code> become section titles, <code>## </code> subsections; everything else is paragraphs/bullets.
          </p>
          <Textarea rows={28} value={draft} onChange={(e) => setDraft(e.target.value)} className="font-mono text-xs" />
          <div className="flex gap-2">
            <Button onClick={save} disabled={pending}>
              <Check className="h-4 w-4" /> {pending ? "Saving…" : "Save handbook"}
            </Button>
            <Button variant="outline" onClick={() => { setEditing(false); setDraft(text); }}>Cancel</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const lines = text.split("\n");

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="h-3.5 w-3.5" /> Edit handbook
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="py-6">
          {!text.trim() ? (
            <div className="py-8 text-center text-sm text-slate-400">
              <BookOpen className="mx-auto mb-2 h-8 w-8 text-slate-300" />
              No handbook yet{isAdmin ? " — hit Edit to start from scratch." : "."}
            </div>
          ) : (
            <div className="space-y-1.5">
              {lines.map((l, i) => {
                if (l.startsWith("## "))
                  return <h3 key={i} className="pt-3 text-sm font-semibold text-slate-900">{l.slice(3)}</h3>;
                if (l.startsWith("# "))
                  return <h2 key={i} className="border-b border-slate-100 pb-1 pt-5 text-lg font-bold text-slate-900 first:pt-0">{l.slice(2)}</h2>;
                if (!l.trim()) return <div key={i} className="h-2" />;
                return <p key={i} className="text-sm leading-relaxed text-slate-600">{l}</p>;
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
