"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function AiStatus({ configured, model }: { configured: boolean; model: string }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ live: boolean; error?: string } | null>(null);

  async function runTest() {
    setTesting(true);
    setResult(null);
    try {
      const r = await fetch("/api/ai-health?live=1", { cache: "no-store" });
      const j = await r.json();
      setResult({ live: !!j.live, error: j.error });
    } catch (e: any) {
      setResult({ live: false, error: e?.message ?? "Request failed" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {configured ? (
          <Badge tone="green">Key configured</Badge>
        ) : (
          <Badge tone="amber">No key</Badge>
        )}
        <span className="text-sm text-slate-600">
          Model: <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{model}</code>
        </span>
      </div>

      {!configured ? (
        <p className="text-sm text-slate-400">
          AI features (chat assistant, quote &amp; material drafting) are off until <code>ANTHROPIC_API_KEY</code> is set
          in your hosting environment. Add it in Vercel → Project → Settings → Environment Variables (Production),
          then redeploy.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" onClick={runTest} disabled={testing}>
              {testing ? "Testing…" : "Run live test"}
            </Button>
            {result?.live && (
              <span className="text-sm font-medium text-green-600">✓ AI is live and responding.</span>
            )}
            {result && !result.live && (
              <span className="text-sm font-medium text-red-600">✗ {result.error ?? "Test failed."}</span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            The live test sends one tiny message to the Anthropic API to confirm the key and model work end-to-end.
          </p>
        </>
      )}
    </div>
  );
}
