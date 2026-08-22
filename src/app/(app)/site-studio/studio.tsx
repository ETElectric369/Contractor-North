"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Rocket, Sparkles, Camera, Trash2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { formatDateTime } from "@/lib/utils";
import { diffSiteDoc, extractSiteDoc, siteDocSeoChecks, type SiteDoc } from "@/lib/site-doc";
import { captureSiteVersion, designSitePass, discardSiteVersion, publishSiteVersion } from "./actions";

type VersionRow = { id: string; v: number; note: string | null; status: string; created_at: string; doc: unknown };

/**
 * The studio's three-part shape: the conversation rail (say what you want), the preview (the
 * ACTUAL site, draft overlaid at its real URL), and the version list (the history, any row
 * re-publishable). The chat is for taste; the buttons are for the deterministic verbs.
 */
export function SiteStudio({
  handle,
  liveDoc,
  versions,
}: {
  handle: string | null;
  liveDoc: SiteDoc;
  versions: VersionRow[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pendingUi, start] = useTransition();
  const [designing, setDesigning] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    versions.find((r) => r.status === "draft")?.id ?? versions[0]?.id ?? null,
  );
  const [lastChanges, setLastChanges] = useState<string[]>([]);
  const [lastDropped, setLastDropped] = useState<string[]>([]);

  const selected = versions.find((r) => r.id === selectedId) ?? null;
  const published = versions.find((r) => r.status === "published") ?? null;
  const publishedDoc = useMemo(() => (published ? extractSiteDoc(published.doc) : null), [published]);
  const selectedDoc = useMemo(() => (selected ? extractSiteDoc(selected.doc) : null), [selected]);
  // Someone edited outside the studio (the old builder, a collaborator): say so, don't guess.
  const liveDrift = useMemo(
    () => (publishedDoc ? diffSiteDoc(publishedDoc, liveDoc) : []),
    [publishedDoc, liveDoc],
  );

  if (!handle) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-slate-600">
          The public site is switched off — set a site address in Settings → Website first, then come back to design it.
        </CardContent>
      </Card>
    );
  }

  // Keyed off selectedId, NOT the row: a fresh pass sets an id that reaches the versions prop
  // only after router.refresh() lands — the preview must show the new design immediately.
  const previewSrc = selectedId ? `/site/${handle}?preview=1&sv=${selectedId}` : `/site/${handle}?preview=1`;

  function runDesign() {
    const ask = instruction.trim();
    if (!ask) return toast("Tell it what to change first.", "error");
    setDesigning(true);
    start(async () => {
      const r = await designSitePass(ask, selectedId);
      setDesigning(false);
      if (!r.ok) return toast(r.error ?? "The design pass failed.", "error");
      setInstruction("");
      setLastChanges(r.changes ?? []);
      setLastDropped(r.dropped ?? []);
      if (r.id) setSelectedId(r.id);
      toast(`New version ready — ${r.note ?? "design pass"}.`, "success");
      router.refresh();
    });
  }

  function runCapture() {
    start(async () => {
      const r = await captureSiteVersion();
      if (!r.ok) return toast(r.error ?? "Couldn't capture the site.", "error");
      if (r.id) setSelectedId(r.id);
      toast("Captured the live site as a new version.", "success");
      router.refresh();
    });
  }

  function runPublish() {
    if (!selected || !selectedDoc) return;
    const diff = diffSiteDoc(liveDoc, selectedDoc);
    const checks = siteDocSeoChecks(selectedDoc, publishedDoc);
    const warns = checks.filter((c) => c.level === "warn").map((c) => `• ${c.msg}`);
    const msg =
      `Publish v${selected.v} to the live site?\n\n` +
      (diff.length ? `Changes: ${diff.join(", ")}.\n\n` : "No visible changes vs the live site.\n\n") +
      (warns.length ? `Worth knowing:\n${warns.join("\n")}\n\n` : "") +
      "Your addresses, phone links and lead capture are never touched by a design — and any older version can be published again.";
    if (!confirm(msg)) return;
    start(async () => {
      const r = await publishSiteVersion(selected.id);
      if (!r.ok) return toast(r.error ?? "Publish failed.", "error");
      toast(`v${selected.v} is live.`, "success");
      router.refresh();
    });
  }

  function runDiscard(row: VersionRow) {
    if (!confirm(`Discard draft v${row.v}${row.note ? ` (“${row.note}”)` : ""}? Drafts keep nothing.`)) return;
    start(async () => {
      const r = await discardSiteVersion(row.id);
      if (!r.ok) return toast(r.error ?? "Couldn't discard that.", "error");
      if (selectedId === row.id) setSelectedId(null);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
      <div className="space-y-4">
        {/* THE CONVERSATION RAIL — taste goes here. */}
        <Card>
          <CardContent className="space-y-2 py-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Tell the designer</p>
            <Textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={4}
              placeholder={`e.g. "Darker, more mountain-lodge. Lead with the ${liveDoc.splash_bullets.split("\n")[0] || "signature"} work and put the best photos up top."`}
              className="text-sm"
            />
            <div className="flex items-center gap-2">
              <Button onClick={runDesign} disabled={designing || pendingUi} size="sm">
                {designing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Designing…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" /> Design a version
                  </>
                )}
              </Button>
              <span className="text-xs text-slate-400">
                {selected ? `builds on v${selected.v}` : "builds on the live site"}
              </span>
            </div>
            {lastChanges.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 pt-1 text-xs text-slate-600">
                {lastChanges.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
            {lastDropped.length > 0 && (
              <p className="text-xs text-amber-700">Refused: {lastDropped.join("; ")}.</p>
            )}
          </CardContent>
        </Card>

        {/* THE VERSIONS — the history, any row re-publishable. */}
        <Card>
          <CardContent className="py-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Versions</p>
              <button
                type="button"
                onClick={runCapture}
                disabled={pendingUi}
                className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
              >
                <Camera className="h-3.5 w-3.5" /> Capture live site
              </button>
            </div>
            {liveDrift.length > 0 && (
              <p className="mb-2 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                The live site has changes made outside the studio ({liveDrift.join(", ")}) — Capture to bring them in
                before designing.
              </p>
            )}
            {versions.length === 0 && (
              <p className="text-sm text-slate-500">
                No versions yet — Capture the live site to start from what you have, or just describe a design.
              </p>
            )}
            <ul className="space-y-1">
              {versions.map((r) => (
                // A row is a plain flex DIV with two REAL buttons inside — a button nested in a
                // button is invalid HTML and reads as one mystery tab-stop to a screen reader.
                <li key={r.id}>
                  <div
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-slate-50 ${r.id === selectedId ? "bg-slate-100" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
                    >
                      <span className="font-mono text-xs text-slate-400">v{r.v}</span>
                      <span className="min-w-0 flex-1 truncate">{r.note ?? "—"}</span>
                      {r.status === "published" ? (
                        <Badge tone="green">live</Badge>
                      ) : r.status === "archived" ? (
                        <span className="text-[10px] uppercase text-slate-400">was live</span>
                      ) : null}
                      <span className="shrink-0 text-[10px] text-slate-400">{formatDateTime(r.created_at)}</span>
                    </button>
                    {r.status === "draft" && (
                      <button
                        type="button"
                        onClick={() => runDiscard(r)}
                        className="shrink-0 p-1 text-slate-300 hover:text-rose-500"
                        aria-label={`Discard draft v${r.v}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* THE PREVIEW — the actual site, the draft overlaid at its real URL. */}
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-600">
            {selected ? (
              <>
                Previewing <span className="font-semibold">v{selected.v}</span>
                {selected.note ? ` — ${selected.note}` : ""}
                {selected.status === "published" ? " (this is what's live)" : ""}
              </>
            ) : (
              "Previewing the live site"
            )}
          </p>
          <div className="flex items-center gap-2">
            <a
              href={`/site/${handle}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" /> View live
            </a>
            {selected && selected.status !== "published" && (
              <Button onClick={runPublish} disabled={pendingUi} size="sm">
                <Rocket className="h-4 w-4" /> Publish v{selected.v}
              </Button>
            )}
          </div>
        </div>
        <iframe
          key={previewSrc}
          src={previewSrc}
          title="Site preview"
          className="h-[75vh] w-full rounded-xl border border-slate-200 bg-white shadow-sm"
        />
      </div>
    </div>
  );
}
