"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Rocket, Sparkles, Camera, Trash2, ExternalLink, Mic, Square } from "lucide-react";
import { useDictation } from "@/lib/use-dictation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { formatDateTime } from "@/lib/utils";
import { diffSiteDoc, extractSiteDoc, siteDocSeoChecks, type SiteDoc } from "@/lib/site-doc";
import { captureSiteVersion, designSiteOptions, designSitePass, discardSiteVersion, publishSiteVersion, updateVersionBlocks } from "./actions";
import { BlockEditor } from "../settings/block-editor";
import type { Block } from "@/lib/site-blocks";

type VersionRow = { id: string; v: number; note: string | null; status: string; created_at: string; doc: unknown };

/**
 * The studio's three-part shape: the conversation rail (say what you want), the preview (the
 * ACTUAL site, draft overlaid at its real URL), and the version list (the history, any row
 * re-publishable). The chat is for taste; the buttons are for the deterministic verbs.
 */
export function SiteStudio({
  orgId,
  handle,
  liveDoc,
  versions,
}: {
  orgId?: string;
  handle: string | null;
  liveDoc: SiteDoc;
  versions: VersionRow[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pendingUi, start] = useTransition();
  const [designing, setDesigning] = useState(false);
  const [optioning, setOptioning] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    versions.find((r) => r.status === "draft")?.id ?? versions[0]?.id ?? null,
  );
  const [lastChanges, setLastChanges] = useState<string[]>([]);
  const [lastDropped, setLastDropped] = useState<string[]>([]);
  const [lastCannot, setLastCannot] = useState<string[]>([]);
  // ARRANGE BY HAND — the hand-edit mode on the selected DRAFT's body. Seeded from the version
  // when opened; Save writes the draft (never the live site). Keyed by version so switching
  // versions never carries stale blocks across.
  const [hand, setHand] = useState<{ versionId: string; blocks: Block[] } | null>(null);
  const [handSaving, setHandSaving] = useState(false);
  // A hand-save must repaint the preview: same sv URL, so bump a nonce the route ignores.
  const [previewBump, setPreviewBump] = useState(0);
  // On-page editing: the iframe carries &edit=1; its Save posts back so the list refreshes.
  const [pageEdit, setPageEdit] = useState(false);
  // SAY THE DESIGN (Erik: "can we put a talk button in there to have Nort design it verbally?").
  // Same press-to-talk → /api/transcribe turn as the inspector and /organize. The words land IN
  // THE BOX for review — dictation hands back text, never an action; he reads it, fixes a
  // misheard word, then presses Design. Appends, so a spoken addendum extends a typed start.
  const dictation = useDictation((text) =>
    setInstruction((cur) => (cur.trim() ? `${cur.trimEnd()} ${text}` : text)),
  );

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
  const previewSrc = selectedId
    ? `/site/${handle}?preview=1&sv=${selectedId}${pageEdit && selected?.status === "draft" ? "&edit=1" : ""}${previewBump ? `&r=${previewBump}` : ""}`
    : `/site/${handle}?preview=1`;

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const flushDone = useRef<(() => void) | null>(null);
  const pageEditRef = useRef(pageEdit);
  pageEditRef.current = pageEdit;
  /** Ask the live editor inside the iframe to commit + save everything, and wait for its
   *  answer (bounded). Any studio action that remounts the iframe or acts on the draft's doc
   *  MUST pass through this first — a remount aborts in-flight autosaves ("auto reverts"). */
  const flushLiveEdits = (): Promise<void> => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !pageEditRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      flushDone.current = resolve;
      try {
        win.postMessage({ type: "cn-live-flush" }, "*");
      } catch {
        resolve();
      }
      setTimeout(resolve, 1200);
    });
  };
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const t = (e.data as { type?: string })?.type;
      if (t === "cn-live-saved") {
        // Autosave ping: refresh the version list's edited-state, but NEVER remount the
        // preview iframe — the person is mid-edit inside it (drag in progress, text focused).
        router.refresh();
      }
      if (t === "cn-live-flushed") {
        flushDone.current?.();
        flushDone.current = null;
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A typed-but-unsent instruction or an open hand-arrangement is real work — same-window
  // navigation ("View live", the Back chip round trip) must not eat it silently.
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (instruction.trim() || hand) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [instruction, hand]);

  function runDesign() {
    const ask = instruction.trim();
    if (!ask) return toast("Tell it what to change first.", "error");
    setDesigning(true);
    start(async () => {
      await flushLiveEdits();
      const r = await designSitePass(ask, selectedId);
      setDesigning(false);
      if (!r.ok) return toast(r.error ?? "The design pass failed.", "error");
      setInstruction("");
      setLastChanges(r.changes ?? []);
      setLastDropped(r.dropped ?? []);
      setLastCannot(r.cannot ?? []);
      if (r.id) {
        setSelectedId(r.id);
        toast(`New version ready — ${r.note ?? "design pass"}.`, "success");
      } else {
        // The no-op guard answered without minting a version — say that, not "ready".
        toast("No version created — nothing in that request maps to a design field.", "error");
      }
      router.refresh();
    });
  }

  // ONE TAP, FOUR ARRANGEMENTS — the see-options answer to "like i would drag and drop any old
  // editor": flip through them with your eyes instead of describing layout in words.
  function runOptions() {
    // The typed instruction rides into all four options (and stays in the box — the options are
    // variations, the box is his standing direction until he clears it).
    setOptioning(true);
    start(async () => {
      await flushLiveEdits();
      const r = await designSiteOptions(selectedId, instruction.trim() || undefined);
      setOptioning(false);
      if (!r.ok) return toast(r.error ?? "The options pass failed.", "error");
      setLastChanges((r.options ?? []).map((o) => o.note));
      setLastDropped([]);
      setLastCannot([]);
      if (r.options?.[0]?.id) setSelectedId(r.options[0].id);
      toast(`${r.options?.length ?? 0} options ready — click through the new versions.`, "success");
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
      await flushLiveEdits();
      const r = await publishSiteVersion(selected.id);
      if (!r.ok) return toast(r.error ?? "Publish failed.", "error");
      toast(`v${selected.v} is live.`, "success");
      router.refresh();
    });
  }

  function saveHandBlocks() {
    // Write to the version the editor was SEEDED from (review, high: switching versions with the
    // editor open could have saved draft A's body onto draft B).
    if (!hand) return;
    setHandSaving(true);
    start(async () => {
      const r = await updateVersionBlocks(hand.versionId, hand.blocks);
      setHandSaving(false);
      if (!r.ok) return toast(r.error ?? "Couldn't save the arrangement.", "error");
      toast("Arrangement saved to this draft.", "success");
      setHand(null);
      setPreviewBump((n) => n + 1);
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
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runDesign} disabled={designing || pendingUi} size="sm">
                {designing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Designing…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" /> Design It
                  </>
                )}
              </Button>
              <Button onClick={runOptions} disabled={designing || optioning || pendingUi} size="sm" variant="outline">
                {optioning ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Designing 4…
                  </>
                ) : (
                  "4 Layouts"
                )}
              </Button>
              <button
                type="button"
                onClick={() => (dictation.recording ? dictation.stop() : void dictation.start())}
                disabled={designing || dictation.transcribing}
                aria-label={dictation.recording ? "Stop talking" : "Say the design out loud"}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border ${
                  dictation.recording
                    ? "animate-pulse border-rose-300 bg-rose-50 text-rose-600"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50"
                } disabled:opacity-50`}
              >
                {dictation.transcribing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : dictation.recording ? (
                  <Square className="h-3.5 w-3.5" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </button>
              <span className="text-xs text-slate-400">
                {dictation.recording
                  ? "listening — tap to stop"
                  : dictation.transcribing
                    ? "writing it down…"
                    : selected
                      ? `builds on v${selected.v}`
                      : "builds on the live site"}
              </span>
            </div>
            {dictation.error && <p className="text-xs text-rose-600">{dictation.error}</p>}
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
            {/* The honesty channel — what the instruction asked for that no design field
                controls. A timid pass with no explanation reads as "it didn't understand me". */}
            {lastCannot.length > 0 && (
              <p className="text-xs text-slate-500">
                <span className="font-semibold">Not possible yet:</span> {lastCannot.join("; ")}
              </p>
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
                <Camera className="h-3.5 w-3.5" /> Capture Live Site
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
                      onClick={() => void flushLiveEdits().then(() => setSelectedId(r.id))}
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
            {/* SAME WINDOW on purpose (Erik: _blank in his app shell "keeps opening behind and
                narrow"). The app-host site route shows him a ← Back to North chip, so viewing
                the live site is a round trip, not a stranding and not a stray window. */}
            <a
              href={`/site/${handle}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" /> View Live
            </a>
            {selected && selected.status !== "published" && (
              <Button onClick={runPublish} disabled={pendingUi} size="sm">
                <Rocket className="h-4 w-4" /> Publish v{selected.v}
              </Button>
            )}
          </div>
        </div>
        <iframe
          ref={iframeRef}
          key={previewSrc}
          src={previewSrc}
          title="Site preview"
          className="h-[75vh] w-full rounded-xl border border-slate-200 bg-white shadow-sm"
        />
        {/* ARRANGE BY HAND — only on a draft. The same editor the settings page uses, pointed
            at this version's body instead of the live site: move things, save, see the preview. */}
        {selected && selected.status === "draft" && selectedDoc && (
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => void flushLiveEdits().then(() => setPageEdit((v) => !v))}
              className={`text-sm font-medium underline-offset-2 hover:underline ${pageEdit ? "text-amber-600" : "text-brand"}`}
            >
{pageEdit ? "✕ Close on-page editing" : "Edit on the page →"}
            </button>
          </div>
        )}
        {selected && selected.status === "draft" && selectedDoc && (
          <div className="mt-3">
            {!hand || hand.versionId !== selected.id ? (
              <button
                type="button"
                onClick={() =>
                  setHand({
                    versionId: selected.id,
                    // An empty body means the standard template — seed it as its section blocks
                    // so "arrange by hand" has real things to move instead of an empty list.
                    blocks: selectedDoc.home_blocks.length
                      ? selectedDoc.home_blocks.map((b) => ({ ...b }))
                      : (["specialty", "services", "portfolio", "reviews", "estimate", "contact"] as const).map(
                          (key) => ({ type: "section" as const, props: { key } }),
                        ),
                  })
                }
                className="text-sm font-medium text-brand underline-offset-2 hover:underline"
              >
                Arrange this version by hand →
              </button>
            ) : (
              <Card key={selected.id}>
                <CardContent className="space-y-3 py-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Arranging v{selected.v} by hand — the page body below the hero
                    </p>
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={saveHandBlocks} disabled={handSaving || pendingUi}>
                        {handSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save Arrangement"}
                      </Button>
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            JSON.stringify(hand?.blocks) !== JSON.stringify(selectedDoc.home_blocks) &&
                            !confirm("Throw away this arrangement? Unsaved changes are lost.")
                          )
                            return;
                          setHand(null);
                        }}
                        className="text-xs font-medium text-slate-500 hover:underline"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                  <BlockEditor
                    blocks={hand?.blocks ?? []}
                    onChange={(blocks) => setHand((h) => (h ? { ...h, blocks } : h))}
                    orgId={orgId}
                    sections
                  />
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
