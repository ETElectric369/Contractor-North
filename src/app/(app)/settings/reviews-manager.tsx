"use client";

import { useState, useTransition } from "react";
import { Check, Plus, Trash2, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { updateOrgSettings } from "./actions";

type Review = { name: string; text: string; rating?: number };

/** Edit the customer testimonials shown on the public site. Real quotes the org enters — no
 *  seeding/fabrication. Saved to settings.reviews (the exact shape OrgSite renders). */
export function ReviewsManager({ initial, orgId }: { initial: Review[]; orgId?: string }) {
  const [reviews, setReviews] = useState<Review[]>(initial);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<Review>) => setReviews((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => setReviews((rs) => [...rs, { name: "", text: "", rating: 5 }]);
  const remove = (i: number) => setReviews((rs) => rs.filter((_, j) => j !== i));

  function save() {
    setError(null);
    setDone(false);
    const clean = reviews
      .map((r) => ({ name: r.name.trim(), text: r.text.trim(), rating: Math.max(1, Math.min(5, Math.round(r.rating ?? 5))) }))
      .filter((r) => r.name && r.text);
    start(async () => {
      const res = await updateOrgSettings({ reviews: clean }, orgId);
      if (!res.ok) { setError(res.error ?? "Couldn't save."); return; }
      setReviews(clean);
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">Real customer quotes shown on your public site — social proof sells. Add your best ones.</p>

      {reviews.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-400">No reviews yet.</p>
      )}

      {reviews.map((r, i) => (
        <div key={i} className="space-y-2 rounded-xl border border-slate-200 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Input value={r.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Customer name" className="max-w-xs" />
            <div className="flex items-center gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => update(i, { rating: n })} aria-label={`${n} star${n > 1 ? "s" : ""}`}>
                  <Star className="h-5 w-5" style={{ color: "#f59e0b" }} fill={n <= (r.rating ?? 5) ? "#f59e0b" : "none"} />
                </button>
              ))}
            </div>
            <button type="button" onClick={() => remove(i)} className="ml-auto text-slate-400 hover:text-red-600" aria-label="Remove review">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <Textarea rows={2} value={r.text} onChange={(e) => update(i, { text: e.target.value })} placeholder="They showed up on time and the deck looks incredible…" />
        </div>
      ))}

      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={add}><Plus className="h-4 w-4" /> Add review</Button>
        <Button size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save reviews"}</Button>
        {done && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
    </div>
  );
}
