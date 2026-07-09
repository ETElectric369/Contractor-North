"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type Block } from "@/lib/site-blocks";
import { BlockEditor } from "./block-editor";
import { saveHomeBlocks } from "./pages-actions";

/** Build the homepage's own custom sections with the SAME block editor as the page builder. Saves to
 *  settings.home_blocks; the homepage renders them below the hero. */
export function HomeBlocksEditor({ initial, brand, orgId }: { initial: Block[]; brand?: string; orgId?: string }) {
  const router = useRouter();
  const [blocks, setBlocks] = useState<Block[]>(initial ?? []);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    setDone(false);
    start(async () => {
      const res = await saveHomeBlocks(blocks, orgId);
      if (!res.ok) { setError(res.error ?? "Couldn't save."); return; }
      setDone(true);
      setTimeout(() => setDone(false), 2500);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">Add your own sections to the homepage — they show below the hero. Same blocks, toolbox, images, and banners as the page builder.</p>
      <BlockEditor blocks={blocks} onChange={setBlocks} brand={brand} orgId={orgId} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save homepage sections"}</Button>
        {done && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
    </div>
  );
}
